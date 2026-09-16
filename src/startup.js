'use strict';

/**
 * Startup sequence and graceful shutdown.
 *
 * Startup (§24, §15):
 *   1. create/verify directories
 *   2. verify SQLite
 *   3. validate the Topaz renderer (ffmpeg, ffprobe, tvai_up, h264_nvenc)
 *   4. recover interrupted jobs and re-queue the pending ones
 *   5. start the reconcile + cleanup timers
 *
 * Shutdown (§29): stop accepting work, stop the queue, terminate (or wait for)
 * the active render, persist state, close SQLite — never leave ffmpeg orphaned.
 */

const { killAllProcesses, isProcessAlive } = require('./utils/process');
const { AppError, errors } = require('./utils/errors');
const { JOB_STATUS } = require('./domain/job-status');
const fsp = require('node:fs/promises');
const path = require('node:path');

const LOCK_FILENAME = 'video-upscaler.lock';

/**
 * Single instance guard.
 *
 * One Node process owns the queue, the SQLite file and the GPU renderer, so a
 * second instance (e.g. `npm start` while PM2 already runs the service) would
 * render two videos at once. The lock file is released on shutdown, and a lock
 * left behind by a dead process is taken over.
 */
async function acquireInstanceLock({ paths, logger }) {
  const lockFile = path.join(paths.dataDir, LOCK_FILENAME);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fsp.open(lockFile, 'wx');
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
      await handle.close();
      return { lockFile };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw errors.filesystem(`Could not create the instance lock ${lockFile}: ${error.message}`, error);
      }
    }

    let existing = null;
    try {
      existing = JSON.parse(await fsp.readFile(lockFile, 'utf8'));
    } catch {
      /* unreadable/corrupt lock: treat as stale below */
    }

    const holderPid = Number(existing?.pid);
    if (Number.isInteger(holderPid) && holderPid !== process.pid && isProcessAlive(holderPid)) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        `Another ${path.basename(process.argv[1] || 'instance')} is already running with pid ` +
          `${holderPid} (lock: ${lockFile}). Only one renderer may own the GPU at a time.`,
        { expose: true },
      );
    }

    logger?.warn?.(`removing stale instance lock ${lockFile} (holder pid ${holderPid || 'unknown'} is gone)`);
    await fsp.rm(lockFile, { force: true });
  }

  throw errors.internal(`Could not acquire the single instance lock at ${lockFile}.`);
}

async function releaseInstanceLock(lock) {
  if (!lock?.lockFile) return;
  await fsp.rm(lock.lockFile, { force: true }).catch(() => {});
}

async function initialize({ container, config, logger }) {
  const { paths, database, rendererService, jobService, queue, cleanupService } = container;
  const result = {};

  for (const warning of config.warnings || []) {
    logger.warn(warning);
  }

  result.dirsCreated = await paths.ensureRuntimeDirs();
  if (result.dirsCreated.length > 0) {
    logger.info(`created directories: ${result.dirsCreated.join(', ')}`);
  }

  if (config.singleInstance) {
    result.lock = await acquireInstanceLock({ paths, logger });
    container.instanceLock = result.lock;
  }

  result.database = database.check();
  logger.info(
    `SQLite ready at ${result.database.file} (journal_mode=${result.database.journalMode})`,
  );

  const validation = await rendererService.validate();
  result.validation = {
    ok: validation.ok,
    state: validation.state,
    usable: validation.usable,
    available: validation.status.available,
    status: validation.status,
    fatalErrors: validation.fatalErrors,
    warnings: validation.warnings,
  };
  for (const warning of validation.warnings) {
    logger.warn(`renderer: ${warning}`);
  }
  if (validation.ok && !validation.status.available) {
    // Validation passed but a self test failed: the renderer cannot produce output.
    logger.error(
      `renderer is NOT usable for rendering: ${validation.status.reason || 'self test failed'}`,
    );
    logger.error(
      'New uploads are rejected with 503 RENDERER_UNAVAILABLE and queued jobs stay queued until ' +
        'the renderer passes its self test again (retried every ' +
        `${Math.round(config.rendererRecheckCooldownMs / 1000)}s). Set ALLOW_DEGRADED_START=true ` +
        'to accept jobs anyway (they will fail at render time).',
    );
  } else if (validation.ok) {
    logger.info(
      `renderer ready: ffmpeg ${validation.status.version || '(version unknown)'} ` +
        `tvai_up=${validation.status.tvaiUp} h264_nvenc=${validation.status.h264Nvenc} ` +
        `nvenc_selftest=${validation.status.nvencWorking} render_selftest=${validation.status.renderWorking}`,
    );
  } else {
    for (const fatal of validation.fatalErrors) logger.error(fatal);
    if (!config.allowDegradedStart) {
      const error = new Error(
        `Renderer validation failed. Fix the Topaz Video AI paths or set ALLOW_DEGRADED_START=true ` +
          `to start anyway. First error: ${validation.fatalErrors[0]}`,
      );
      error.code = 'RENDERER_VALIDATION_FAILED';
      throw error;
    }
    logger.warn('ALLOW_DEGRADED_START=true — starting without a validated renderer');
  }

  result.recovery = await jobService.recoverInterruptedJobs();
  if (result.recovery.failed || result.recovery.cancelled || result.recovery.killedPids.length) {
    logger.warn(
      `recovery: ${result.recovery.failed} interrupted job(s) marked failed, ` +
        `${result.recovery.cancelled} cancelled, killed pids: ` +
        `${result.recovery.killedPids.join(', ') || 'none'}`,
    );
  }

  result.queued = await queue.reconcile();
  logger.info(
    `queue hydrated (concurrency=${config.queueConcurrency}, enqueued=${result.queued.enqueued}, ` +
      `pending in db=${container.repository.countAll({ status: JOB_STATUS.QUEUED })})`,
  );

  queue.startReconcile();
  cleanupService.start();

  return result;
}

/**
 * Shuts the runtime down without leaving ffmpeg processes behind.
 *
 * @param {{ container: object, config: object, logger: object, signal?: string }} options
 */
async function shutdown({ container, config, logger, signal = 'shutdown' }) {
  const { queue, renderService, cleanupService, database, repository } = container;
  const summary = {};

  cleanupService.stop();
  queue.stopReconcile();

  // 1. Stop starting new renders; the queued jobs stay `queued` in SQLite and are
  //    picked up again after the restart. `queue.stop()` also marks the queue as
  //    stopped so an in-flight reconcile pass cannot resume it.
  await queue.stop({ timeoutMs: 1000 });

  const activeIds = renderService.activeIds();
  summary.activeRenders = activeIds.length;

  if (activeIds.length > 0) {
    if (config.shutdownPolicy === 'wait') {
      logger.info(`waiting up to ${config.shutdownTimeoutMs} ms for ${activeIds.length} active render(s)`);
      const idle = await renderService.waitForIdle(config.shutdownTimeoutMs);
      if (!idle) {
        logger.warn('renderer did not finish in time; terminating it');
        renderService.markShuttingDown();
        await renderService.stopAll({ graceMs: config.killGraceMs });
      }
    } else {
      logger.info(`terminating ${activeIds.length} active render(s) (SHUTDOWN_POLICY=terminate)`);
      renderService.markShuttingDown();
      await renderService.stopAll({ graceMs: 2000 });
    }
    summary.stoppedRenders = activeIds.length;
  }

  // 2. Let the workers persist their final state before the database closes.
  await queue.drain(Math.min(config.shutdownTimeoutMs, 10000));

  // 3. Belt and braces: no ffmpeg may survive this process.
  summary.killedChildren = await killAllProcesses({ graceMs: 1000, logger });

  summary.queueRemaining = repository.countAll({ status: JOB_STATUS.QUEUED });
  database.close();
  await releaseInstanceLock(container.instanceLock);
  logger.info(
    `shutdown complete (stopped renders: ${summary.stoppedRenders ?? 0}, ` +
      `queued jobs preserved: ${summary.queueRemaining})`,
  );

  return summary;
}

module.exports = { acquireInstanceLock, initialize, releaseInstanceLock, shutdown };
