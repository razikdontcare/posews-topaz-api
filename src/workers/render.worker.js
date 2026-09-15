'use strict';

/**
 * Render worker.
 *
 * Executes exactly one job per call, in the shape described by AGENTS.md §16:
 *
 *   queue -> claim (queued -> processing) -> (ffprobe) -> temp output path
 *         -> spawn Topaz ffmpeg -> parse -progress pipe:1 -> persist throttled
 *         -> wait for exit -> rename temp output to the final name -> completed
 *         -> remove the uploaded input -> next job
 *
 * The worker never rejects: every failure path ends with a terminal job status so
 * the queue can move on, and the render service is always cleaned up first.
 */

const fsp = require('node:fs/promises');
const { isAppError, toAppError } = require('../utils/errors');
const {
  buildFfmpegArgs,
  classifyFfmpegFailure,
} = require('../utils/ffmpeg');
const { FfmpegProgressParser, computeProgressPercent } = require('../utils/ffmpeg-progress');
const {
  buildOutputFilename,
  formatBytes,
  renameWithRetry,
  reserveUniqueOutputPath,
} = require('../utils/filename');
const { createTailBuffer, spawnProcess } = require('../utils/process');
const { JOB_STATUS } = require('../domain/job-status');

const CLAIMABLE = [JOB_STATUS.QUEUED];
const ACTIVE_FOR_TERMINAL = [
  JOB_STATUS.PROBING,
  JOB_STATUS.PROCESSING,
  JOB_STATUS.CANCEL_REQUESTED,
  JOB_STATUS.QUEUED,
];
/** Statuses in which a claimed job is still allowed to spawn ffmpeg. */
const RENDERABLE_STATUSES = new Set([JOB_STATUS.PROBING, JOB_STATUS.PROCESSING]);

/** Resolves once the child process closed *and* its stdio streams are drained. */
function waitForChildExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      return finish({ code: child.exitCode, signal: child.signalCode, spawnError: null });
    }
    child.once('error', (error) => finish({ code: null, signal: null, spawnError: error }));
    child.once('close', (code, signal) => finish({ code, signal, spawnError: null }));
  });
}

/**
 * Throttled progress persistence: the in-memory snapshot is always fresh (for
 * cheap polling), SQLite is written at most once per interval, and a final
 * synchronous write happens when the render stops (§19).
 */
function createProgressPersister({
  jobId,
  repository,
  renderService,
  logger,
  durationSeconds,
  intervalMs,
  onMilestone = null,
}) {
  let latest = null;
  let lastFlushAt = 0;
  let timer = null;
  let stopped = false;
  let lastMilestone = 0;

  function persist() {
    if (!latest) return;
    lastFlushAt = Date.now();
    const patch = {
      frame: latest.frame,
      fps: latest.fps,
      speed: latest.speed,
      elapsed_seconds: latest.elapsedSeconds,
      total_size: latest.totalSize,
    };
    if (latest.progressPercent !== null) patch.progress_percent = latest.progressPercent;
    try {
      repository.update(jobId, patch);
    } catch (error) {
      logger?.warn?.(`could not persist progress: ${error.message}`);
    }
  }

  function scheduleFlush(delayMs) {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, Math.max(0, delayMs));
    timer.unref?.();
  }

  return {
    update(snapshot) {
      const progressPercent = computeProgressPercent(snapshot.elapsedSeconds, durationSeconds);
      latest = { ...snapshot, progressPercent };
      renderService.updateProgress(jobId, latest);

      if (progressPercent !== null) {
        const milestone = Math.floor(progressPercent / 10) * 10;
        if (milestone > lastMilestone) {
          lastMilestone = milestone;
          if (onMilestone) onMilestone(progressPercent);
          else logger?.info?.(`progress=${progressPercent.toFixed(2)}%`);
        }
      }

      if (stopped) return;
      const sinceLastFlush = Date.now() - lastFlushAt;
      if (sinceLastFlush >= intervalMs) persist();
      else scheduleFlush(intervalMs - sinceLastFlush);
    },
    /** Stops the timer and writes the last known values synchronously. */
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      persist();
    },
    get latest() {
      return latest;
    },
  };
}

function createRenderWorker({
  config,
  paths,
  repository,
  probeService,
  renderService,
  rendererService,
  cleanupService,
  logger,
  spawn = spawnProcess,
}) {
  const bounds = {
    min: config.minDimension,
    max: config.maxDimension,
    enforceEven: config.enforceEvenDimensions,
  };

  function fail(jobId, code, message, options = {}) {
    const log = options.log || logger?.withJob?.(jobId) || logger;
    const truncated = paths
      .redact(String(message || 'Render failed.'))
      .slice(0, config.maxStderrSummaryLength * 4);
    repository.transition(jobId, options.fromStatuses || ACTIVE_FOR_TERMINAL, JOB_STATUS.FAILED, {
      completed_at: new Date().toISOString(),
      pid: null,
      temp_output_path: options.keepTempOutput ? undefined : null,
      error_code: code,
      error_message: truncated,
    });
    log?.error?.(`failed [${code}] ${truncated}`);
    return { status: JOB_STATUS.FAILED, code };
  }

  async function cancelSettlement(jobId, options = {}) {
    const log = options.log || logger?.withJob?.(jobId) || logger;
    if (options.tempOutputPath) {
      await fsp.rm(options.tempOutputPath, { force: true }).catch(() => {});
    }
    repository.transition(jobId, ACTIVE_FOR_TERMINAL, JOB_STATUS.CANCELLED, {
      completed_at: new Date().toISOString(),
      pid: null,
      temp_output_path: null,
      error_code: null,
      error_message: null,
    });
    await cleanupService?.removeJobTemp?.(jobId);
    log?.info?.('cancelled');
    return { status: JOB_STATUS.CANCELLED };
  }

  async function complete(jobId, options = {}) {
    const { log, tempOutputPath, outputFilename, job } = options;

    let stats;
    try {
      stats = await fsp.stat(tempOutputPath);
    } catch {
      return fail(jobId, 'FFMPEG_ERROR', 'FFmpeg reported success but the output file is missing.', {
        log,
      });
    }
    if (!stats.size) {
      await fsp.rm(tempOutputPath, { force: true }).catch(() => {});
      return fail(jobId, 'FFMPEG_ERROR', 'FFmpeg produced an empty output file.', { log });
    }

    // Never overwrite an existing render: reserve an unused name first.
    let reservation;
    try {
      reservation = await reserveUniqueOutputPath(paths.outputDir, outputFilename, {
        suffix: jobId.slice(0, 8),
      });
    } catch (error) {
      return fail(jobId, error.code || 'FILESYSTEM_ERROR', error.message, {
        log,
        keepTempOutput: true,
      });
    }

    try {
      await renameWithRetry(tempOutputPath, reservation.path);
    } catch (error) {
      await fsp.rm(reservation.path, { force: true }).catch(() => {});
      return fail(jobId, 'FILESYSTEM_ERROR', error.message, { log, keepTempOutput: true });
    }

    const finalStats = await fsp.stat(reservation.path).catch(() => stats);
    const updated = repository.transition(jobId, ACTIVE_FOR_TERMINAL, JOB_STATUS.COMPLETED, {
      output_path: reservation.path,
      temp_output_path: null,
      total_size: finalStats.size,
      progress_percent: 100,
      completed_at: new Date().toISOString(),
      pid: null,
      error_code: null,
      error_message: null,
    });
    if (!updated) {
      // The job left the renderable state (cancelled by the client, marked
      // failed by recovery, ...): never leave an unreferenced render behind.
      log?.warn?.('job was no longer renderable, removing the finished file');
      await fsp.rm(reservation.path, { force: true }).catch(() => {});
      return { status: 'stale' };
    }

    log?.info?.(
      `completed -> ${reservation.filename} (${formatBytes(finalStats.size)}, ${job.width}x${job.height})`,
    );
    // The uploaded input is no longer needed once the render is safely on disk.
    await cleanupService?.removeJobTemp?.(jobId);
    return { status: JOB_STATUS.COMPLETED, outputFilename: reservation.filename };
  }

  /**
   * Why a claimed job must not (continue to) render. The atomic claim alone is
   * not enough: a cancellation can land between the claim and the spawn.
   *
   * @returns {null | 'cancelled' | 'stale' | 'shutdown'}
   */
  function abandonmentReason(jobId) {
    if (renderService.isCancellationRequested(jobId)) return 'cancelled';
    const current = repository.findById(jobId);
    if (!current) return 'cancelled';
    if (
      current.status === JOB_STATUS.CANCEL_REQUESTED ||
      current.status === JOB_STATUS.CANCELLED
    ) {
      return 'cancelled';
    }
    if (!RENDERABLE_STATUSES.has(current.status)) return 'stale';
    if (renderService.isShuttingDown()) return 'shutdown';
    return null;
  }

  async function runJob(jobId) {
    const log = logger?.withJob ? logger.withJob(jobId) : logger;

    let job = repository.findById(jobId);
    if (!job) {
      log?.warn?.('job no longer exists, skipping');
      return { status: 'missing' };
    }
    if (!CLAIMABLE.includes(job.status)) {
      log?.debug?.(`not runnable (status=${job.status}), skipping`);
      return { status: job.status };
    }

    // Never start a new render while the process is shutting down: the job stays
    // queued in SQLite and is picked up again by the next process.
    if (renderService.isShuttingDown()) {
      log?.info?.('shutdown in progress, leaving job queued');
      return { status: 'deferred', deferred: true, reason: 'shutting-down' };
    }

    // Renderer gate: a broken Topaz/driver setup must not burn through the queue.
    if (!rendererService.isAvailable()) {
      const available = await rendererService.ensureAvailable();
      if (!available) {
        log?.warn?.('renderer is unavailable; job stays queued');
        return { status: 'deferred', deferred: true, reason: 'renderer-unavailable' };
      }
    }

    const needsProbe =
      !Number.isFinite(job.duration_seconds) ||
      job.duration_seconds <= 0 ||
      job.has_audio === null ||
      (job.has_audio === true && !job.audio_codec);

    // Atomic claim: exactly one execution path can move a job out of `queued`.
    const claimed = repository.transition(jobId, CLAIMABLE, needsProbe ? JOB_STATUS.PROBING : JOB_STATUS.PROCESSING, {
      started_at: job.started_at || new Date().toISOString(),
      pid: null,
      progress_percent: 0,
      error_code: null,
      error_message: null,
    });
    if (!claimed) {
      log?.debug?.('job was claimed by another path, skipping');
      return { status: 'skipped' };
    }
    log?.info?.('started');
    job = repository.findById(jobId) || job;

    if (needsProbe) {
      let media;
      try {
        media = await probeService.probe(job.input_path);
      } catch (error) {
        const appError = toAppError(error, 'FFPROBE_ERROR');
        return fail(jobId, appError.code, appError.message, { log });
      }
      job =
        repository.update(jobId, {
          duration_seconds: media.durationSeconds,
          has_audio: media.hasAudio ? 1 : 0,
          audio_codec: media.audioCodec,
        }) || job;
      repository.transition(jobId, [JOB_STATUS.PROBING], JOB_STATUS.PROCESSING, {});
    }

    // Cancellation may have arrived while the job was being claimed/probed.
    const preSpawnReason = abandonmentReason(jobId);
    if (preSpawnReason === 'cancelled') {
      return cancelSettlement(jobId, { log });
    }
    if (preSpawnReason === 'stale') {
      log?.warn?.('job left the renderable state before ffmpeg was started');
      return cancelSettlement(jobId, { log });
    }

    try {
      await fsp.access(job.input_path);
    } catch {
      return fail(jobId, 'INPUT_FILE_MISSING', 'The uploaded input file is no longer available.', {
        log,
      });
    }

    const outputFilename = buildOutputFilename({
      originalFilename: job.original_filename,
      width: job.width,
      height: job.height,
      model: config.topazModel,
      extension: '.mp4',
    });
    const tempOutputPath = paths.tempOutputPath(jobId, '.mp4');
    await fsp.rm(tempOutputPath, { force: true }).catch(() => {});
    repository.update(jobId, { temp_output_path: tempOutputPath });

    let args;
    try {
      args = buildFfmpegArgs({
        inputPath: job.input_path,
        outputPath: tempOutputPath,
        width: job.width,
        height: job.height,
        model: config.topazModel,
        hasAudio: job.has_audio,
        audioCodec: job.audio_codec,
        audioMode: config.audioMode,
        bounds,
      });
    } catch (error) {
      return fail(jobId, isAppError(error) ? error.code : 'INTERNAL_ERROR', error.message, { log });
    }

    log?.debug?.(`ffmpeg ${config.ffmpegPath} ${args.join(' ')}`);

    const child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    renderService.register(jobId, child, {
      pid: child.pid ?? null,
      tempOutputPath,
      outputFilename,
      inputPath: job.input_path,
    });
    if (child.pid) {
      repository.update(jobId, { pid: child.pid });
      log?.info?.(`ffmpeg PID=${child.pid}`);
    }

    // The job may have been cancelled between the claim and this point (the
    // window right after `register()`): stop immediately and never report a
    // render that the API already considers finished.
    const postSpawnReason = abandonmentReason(jobId);
    if (postSpawnReason === 'cancelled' || postSpawnReason === 'stale') {
      log?.info?.('cancelled while starting ffmpeg, terminating it');
      await renderService.stop(jobId, { graceMs: config.killGraceMs });
      return cancelSettlement(jobId, { log, tempOutputPath });
    }

    const stderrTail = createTailBuffer(config.ffmpegStderrTailBytes);
    const parser = new FfmpegProgressParser({ logger: log });
    const persister = createProgressPersister({
      jobId,
      repository,
      renderService,
      logger: log,
      durationSeconds: job.duration_seconds,
      intervalMs: config.progressPersistIntervalMs,
    });

    child.stdout?.on('data', (chunk) => {
      for (const snapshot of parser.push(chunk)) persister.update(snapshot);
    });
    child.stdout?.on('error', () => {});
    child.stderr?.on('data', (chunk) => stderrTail.push(chunk));
    child.stderr?.on('error', () => {});

    const exit = await waitForChildExit(child);
    persister.stop();

    const cancellationRequested =
      renderService.isCancellationRequested(jobId) ||
      repository.findById(jobId)?.status === JOB_STATUS.CANCEL_REQUESTED;
    const shuttingDown = renderService.isShuttingDown();

    if (cancellationRequested && !exit.spawnError) {
      return cancelSettlement(jobId, { log, tempOutputPath });
    }

    if (exit.spawnError) {
      const reason = `ffmpeg could not be started (${config.ffmpegPath}): ${exit.spawnError.message}`;
      rendererService.markUnavailable(reason);
      return fail(jobId, 'RENDERER_UNAVAILABLE', reason, { log });
    }

    if (shuttingDown) {
      await fsp.rm(tempOutputPath, { force: true }).catch(() => {});
      return fail(jobId, 'RENDERER_INTERRUPTED', 'Renderer interrupted by server shutdown', {
        log,
      });
    }

    if (exit.code !== 0) {
      const stderr = stderrTail.toString();
      const failure = classifyFfmpegFailure(stderr, config.maxStderrSummaryLength);
      log?.error?.(
        `ffmpeg exited with code ${exit.code}${exit.signal ? ` signal=${exit.signal}` : ''} ` +
          `(stderr ${stderrTail.length} bytes, truncated=${stderrTail.truncated})`,
      );
      log?.error?.(`ffmpeg stderr tail:\n${stderr.trim()}`);
      if (failure.code === 'RENDERER_UNAVAILABLE') rendererService.markUnavailable(failure.message);
      await fsp.rm(tempOutputPath, { force: true }).catch(() => {});
      return fail(jobId, failure.code, failure.message, { log });
    }

    return complete(jobId, { log, tempOutputPath, outputFilename, job });
  }

  async function run(jobId) {
    const log = logger?.withJob ? logger.withJob(jobId) : logger;
    try {
      return await runJob(jobId);
    } catch (error) {
      log?.error?.(`unexpected renderer error: ${error.stack || error.message}`);
      // Make sure a half-started render cannot become an orphan process.
      if (renderService.isActive(jobId)) {
        renderService.requestCancel(jobId, 'renderer error');
        await renderService.stop(jobId, { graceMs: 2000 }).catch(() => {});
      }
      const appError = toAppError(error, 'INTERNAL_ERROR');
      try {
        return fail(jobId, appError.code, appError.message, { log });
      } catch (finalError) {
        log?.error?.(`could not record the failure: ${finalError.message}`);
        return { status: JOB_STATUS.FAILED, code: appError.code };
      }
    } finally {
      // Must happen last: the cancel API waits for this to consider the job stopped.
      renderService.unregister(jobId);
    }
  }

  return { run, runJob, createProgressPersister, waitForChildExit, bounds };
}

module.exports = { createRenderWorker, createProgressPersister, waitForChildExit };
