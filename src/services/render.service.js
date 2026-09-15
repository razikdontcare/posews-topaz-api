'use strict';

/**
 * Render coordination: the registry of job ids that currently own an ffmpeg
 * process, the latest in-memory progress for cheap polling, and Windows-aware
 * cancellation.
 *
 * The HTTP layer never talks to ffmpeg directly; it asks this service to stop a
 * job and the worker observes the outcome.
 */

function createRenderService({ config, logger, terminateProcessTree }) {
  /** @type {Map<string, { jobId: string, child: import('node:child_process').ChildProcess|null, pid: number|null, startedAt: number, cancelRequested: boolean, cancelReason: string|null, progress: object|null, shuttingDown: boolean, exitHandled: boolean }>} */
  const active = new Map();
  let shuttingDown = false;

  function register(jobId, child, meta = {}) {
    const entry = {
      jobId,
      child: child || null,
      pid: child?.pid ?? meta.pid ?? null,
      startedAt: Date.now(),
      cancelRequested: false,
      cancelReason: null,
      progress: null,
      shuttingDown: false,
      exitHandled: false,
      ...meta,
    };
    active.set(jobId, entry);
    return entry;
  }

  function get(jobId) {
    return active.get(jobId) || null;
  }

  function unregister(jobId) {
    return active.delete(jobId);
  }

  function isActive(jobId) {
    return active.has(jobId);
  }

  function updateProgress(jobId, snapshot) {
    const entry = active.get(jobId);
    if (!entry) return;
    entry.progress = snapshot;
  }

  function getProgress(jobId) {
    const entry = active.get(jobId);
    return entry?.progress ?? null;
  }

  /** Marks the render for cancellation; returns false when it is not active. */
  function requestCancel(jobId, reason = 'client requested cancellation') {
    const entry = active.get(jobId);
    if (!entry) return false;
    entry.cancelRequested = true;
    entry.cancelReason = reason;
    return true;
  }

  function isCancellationRequested(jobId) {
    return Boolean(active.get(jobId)?.cancelRequested);
  }

  function activeIds() {
    return [...active.keys()];
  }

  function activeJobId() {
    for (const entry of active.values()) return entry.jobId;
    return null;
  }

  function count() {
    return active.size;
  }

  function markShuttingDown() {
    shuttingDown = true;
    for (const entry of active.values()) entry.shuttingDown = true;
  }

  function isShuttingDown() {
    return shuttingDown;
  }

  /**
   * Stops one render: graceful signal first, then `taskkill /T /F` on Windows.
   * Resolves `true` once the process is gone.
   */
  async function stop(jobId, options = {}) {
    const entry = active.get(jobId);
    if (!entry) return true;
    if (!entry.child) {
      // The process either never spawned or already exited.
      return !entry.child;
    }
    const stopped = await terminateProcessTree(entry.child, {
      graceMs: options.graceMs ?? config.killGraceMs,
      finalWaitMs: options.finalWaitMs ?? 5000,
      logger,
    });
    if (!stopped) {
      logger?.error?.(`Job ${jobId} could not be terminated (pid ${entry.pid})`);
    }
    return stopped;
  }

  /** Stops every active render (used by shutdown and by the cancel API). */
  async function stopAll(options = {}) {
    const ids = activeIds();
    const results = await Promise.all(
      ids.map((jobId) =>
        stop(jobId, { graceMs: options.graceMs ?? 2000, finalWaitMs: 5000 }).catch(() => false),
      ),
    );
    return ids.filter((id, index) => results[index]).length;
  }

  /** Waits until no render is active (bounded). */
  async function waitForIdle(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return active.size === 0;
  }

  return {
    activeIds,
    activeJobId,
    count,
    get,
    getProgress,
    isActive,
    isCancellationRequested,
    isShuttingDown,
    markShuttingDown,
    register,
    requestCancel,
    stop,
    stopAll,
    unregister,
    updateProgress,
    waitForIdle,
  };
}

module.exports = { createRenderService };
