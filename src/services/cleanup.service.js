'use strict';

/**
 * Physical cleanup of temporary data.
 *
 *  - after a job reaches a terminal state its `TEMP_DIR/<jobId>` directory is
 *    removed (failed jobs keep it for `FAILED_JOB_RETENTION_HOURS`),
 *  - stale temp directories and orphan `.rendering.mp4` files are swept
 *    periodically,
 *  - terminal jobs older than their retention window are removed from SQLite.
 *
 * Final rendered files in OUTPUT_DIR are never deleted by cleanup.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { isRenderingTempFile } = require('../utils/filename');
const { JOB_STATUS } = require('../domain/job-status');

const HOUR_MS = 3600 * 1000;
/** A reserved-but-never-renamed output placeholder must be older than this. */
const EMPTY_OUTPUT_MIN_AGE_MS = 60 * 1000;

function createCleanupService({ config, paths, repository, renderService, logger }) {
  let timer = null;
  let initialTimer = null;

  /** Removes `TEMP_DIR/<jobId>` (the uploaded input of a finished job). */
  async function removeJobTemp(jobId) {
    let dir;
    try {
      dir = paths.jobTempDir(jobId);
    } catch {
      return false;
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      return true;
    } catch (error) {
      logger?.warn?.(`could not remove temp directory ${dir}: ${error.message}`);
      return false;
    }
  }

  /** Job ids whose temporary data must never be touched. */
  function protectedJobIds() {
    const ids = new Set(renderService.activeIds());
    for (const job of repository.findByStatuses([
      JOB_STATUS.QUEUED,
      JOB_STATUS.PROBING,
      JOB_STATUS.PROCESSING,
      JOB_STATUS.CANCEL_REQUESTED,
    ])) {
      ids.add(job.id);
    }
    return ids;
  }

  /** Deletes TEMP_DIR/<jobId> directories older than TEMP_STALE_HOURS. */
  async function cleanupStaleTempDirs() {
    const cutoff = Date.now() - config.tempStaleHours * HOUR_MS;
    const protectedIds = protectedJobIds();
    let removed = 0;

    let entries = [];
    try {
      entries = await fsp.readdir(paths.tempDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn?.(`temp directory sweep failed: ${error.message}`);
      }
      return { removed: 0 };
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || protectedIds.has(entry.name)) continue;
      const target = path.join(paths.tempDir, entry.name);
      if (!paths.isInside(paths.tempDir, target)) continue;
      try {
        const stats = await fsp.stat(target);
        if (stats.mtimeMs > cutoff) continue;
        await fsp.rm(target, { recursive: true, force: true, maxRetries: 3 });
        removed += 1;
        logger?.info?.(`removed stale temp directory ${entry.name}`);
      } catch (error) {
        logger?.warn?.(`could not remove ${target}: ${error.message}`);
      }
    }
    return { removed };
  }

  /** Deletes orphan `.<jobId>.rendering.mp4` files in OUTPUT_DIR. */
  async function cleanupOrphanTempOutputs() {
    const cutoff = Date.now() - config.tempStaleHours * HOUR_MS;
    const protectedIds = protectedJobIds();
    let removed = 0;

    let entries = [];
    try {
      entries = await fsp.readdir(paths.outputDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn?.(`output directory sweep failed: ${error.message}`);
      }
      return { removed: 0 };
    }

    for (const entry of entries) {
      if (!entry.isFile() || !isRenderingTempFile(entry.name)) continue;
      const jobId = entry.name.slice(1).split('.')[0];
      if (protectedIds.has(jobId)) continue;
      const target = path.join(paths.outputDir, entry.name);
      try {
        const stats = await fsp.stat(target);
        if (stats.mtimeMs > cutoff) continue;
        await fsp.rm(target, { force: true });
        removed += 1;
        logger?.info?.(`removed orphan render file ${entry.name}`);
      } catch (error) {
        logger?.warn?.(`could not remove ${target}: ${error.message}`);
      }
    }
    return { removed };
  }

  /**
   * Removes terminal jobs that are past their retention window. The rendered
   * output file is intentionally kept.
   */
  async function cleanupExpiredJobs() {
    const now = Date.now();
    const expired = repository.findExpired({
      completedBefore: new Date(now - config.jobRetentionHours * HOUR_MS).toISOString(),
      failedBefore: new Date(now - config.failedJobRetentionHours * HOUR_MS).toISOString(),
      limit: 500,
    });

    let removed = 0;
    for (const job of expired) {
      await removeJobTemp(job.id);
      if (repository.deleteById(job.id)) removed += 1;
    }
    if (removed > 0) logger?.info?.(`purged ${removed} expired job record(s)`);
    return { removed };
  }

  /**
   * Removes empty files that were reserved as output names but never filled in
   * (a crash between `reserveUniqueOutputPath()` and the rename). Only files no
   * job references and older than a minute are touched.
   */
  async function cleanupEmptyOutputFiles() {
    let entries = [];
    try {
      entries = await fsp.readdir(paths.outputDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn?.(`output directory sweep failed: ${error.message}`);
      }
      return { removed: 0 };
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || isRenderingTempFile(entry.name)) continue;
      const target = path.join(paths.outputDir, entry.name);
      if (!paths.isInside(paths.outputDir, target)) continue;
      try {
        const stats = await fsp.stat(target);
        if (stats.size !== 0) continue;
        if (Date.now() - stats.mtimeMs < EMPTY_OUTPUT_MIN_AGE_MS) continue;
        if (repository.countByOutputPath(target) > 0) continue;
        await fsp.rm(target, { force: true });
        removed += 1;
        logger?.info?.(`removed empty output placeholder ${entry.name}`);
      } catch (error) {
        logger?.warn?.(`could not inspect ${target}: ${error.message}`);
      }
    }
    return { removed };
  }

  async function runOnce() {
    const tempDirs = await cleanupStaleTempDirs();
    const orphanOutputs = await cleanupOrphanTempOutputs();
    const emptyOutputs = await cleanupEmptyOutputFiles();
    const expired = await cleanupExpiredJobs();
    return { tempDirs, orphanOutputs, emptyOutputs, expired };
  }

  function start({ runImmediately = true, delayMs = 5000 } = {}) {
    if (timer || initialTimer) return;
    const tick = () => {
      runOnce().catch((error) => logger?.error?.(`cleanup failed: ${error.message}`));
    };
    if (runImmediately) {
      initialTimer = setTimeout(() => {
        initialTimer = null;
        tick();
      }, delayMs);
      initialTimer.unref?.();
    }
    timer = setInterval(tick, config.cleanupIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    cleanupEmptyOutputFiles,
    cleanupExpiredJobs,
    cleanupOrphanTempOutputs,
    cleanupStaleTempDirs,
    removeJobTemp,
    runOnce,
    start,
    stop,
  };
}

module.exports = { createCleanupService };
