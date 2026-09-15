'use strict';

/**
 * Execution queue.
 *
 * Guarantees:
 *  - at most `concurrency` jobs run at the same time (always 1: the GPU renderer),
 *  - FIFO order by job creation time,
 *  - a job id can be queued at most once (duplicate protection on top of the
 *    atomic `queued -> processing` transition in SQLite),
 *  - periodically reconciles the in-memory queue with `jobs.status = 'queued'`
 *    so a failed enqueue or a restart can never lose a job,
 *  - a job whose runner keeps throwing is marked failed after N attempts instead
 *    of being retried forever,
 *  - the queue pauses itself while the renderer is unavailable and resumes
 *    automatically once it is back.
 *
 * SQLite stays the source of truth for what *should* run; this module only
 * decides what runs *now*.
 */

function createRenderQueue({
  concurrency = 1,
  runner,
  logger,
  loadQueuedJobIds = () => [],
  isRunnerAvailable = () => true,
  ensureRunnerAvailable = async () => true,
  onRunnerError = null,
  reconcileIntervalMs = 30000,
}) {
  const pending = [];
  const pendingSet = new Set();
  const active = new Map();
  /** Consecutive runner failures per job, used to stop retry storms. */
  const failures = new Map();
  let paused = false;
  let pausedReason = null;
  let stopped = false;
  let reconcileTimer = null;

  function isPending(jobId) {
    return pendingSet.has(jobId);
  }

  function enqueue(jobId, { front = false } = {}) {
    if (stopped || !jobId) return false;
    if (pendingSet.has(jobId) || active.has(jobId)) return false;
    if (front) pending.unshift(jobId);
    else pending.push(jobId);
    pendingSet.add(jobId);
    schedule();
    return true;
  }

  /** Removes a job that has not started yet (cancellation of queued jobs). */
  function remove(jobId) {
    const index = pending.indexOf(jobId);
    if (index === -1) return false;
    pending.splice(index, 1);
    pendingSet.delete(jobId);
    return true;
  }

  function start(jobId) {
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    active.set(jobId, done);
    let deferred = false;

    Promise.resolve()
      .then(() => runner(jobId))
      .then((result) => {
        deferred = Boolean(result && result.deferred);
        if (!deferred) failures.delete(jobId);
      })
      .catch((error) => {
        const attempts = (failures.get(jobId) || 0) + 1;
        failures.set(jobId, attempts);
        logger?.error?.(
          `runner failed for job ${jobId} (attempt ${attempts}): ${error.stack || error.message}`,
        );
        try {
          onRunnerError?.(jobId, error, { attempts });
        } catch (handlerError) {
          logger?.error?.(`runner error handler failed: ${handlerError.message}`);
        }
      })
      .finally(() => {
        active.delete(jobId);
        if (deferred) {
          // Renderer is not usable right now: keep the job queued and wait for
          // the next reconcile pass instead of burning through the queue.
          pause('renderer-unavailable');
          if (enqueue(jobId, { front: true })) {
            logger?.warn?.(`renderer unavailable, job ${jobId} stays queued`);
          }
        }
        resolveDone();
        schedule();
      });
  }

  function schedule() {
    if (stopped || paused) return;
    while (active.size < concurrency && pending.length > 0) {
      const jobId = pending.shift();
      pendingSet.delete(jobId);
      start(jobId);
    }
  }

  function pause(reason = 'manual') {
    if (paused) return;
    paused = true;
    pausedReason = reason;
    logger?.warn?.(`queue paused (${reason})`);
  }

  function resume() {
    if (!paused) return;
    paused = false;
    pausedReason = null;
    logger?.info?.('queue resumed');
    schedule();
  }

  /**
   * Re-aligns the execution queue with the database and with renderer
   * availability. Also used as the startup hydration step.
   */
  async function reconcile() {
    if (stopped) return { enqueued: 0, paused: true };

    if (!isRunnerAvailable()) {
      const available = await ensureRunnerAvailable();
      if (!available) {
        pause('renderer-unavailable');
        return { enqueued: 0, paused: true };
      }
    }
    if (paused && pausedReason === 'renderer-unavailable') resume();

    let enqueued = 0;
    for (const jobId of loadQueuedJobIds()) {
      if (enqueue(jobId)) enqueued += 1;
    }
    return { enqueued, paused };
  }

  function startReconcile() {
    if (reconcileTimer || !reconcileIntervalMs) return;
    reconcileTimer = setInterval(() => {
      reconcile().catch((error) => logger?.error?.(`queue reconcile failed: ${error.message}`));
    }, reconcileIntervalMs);
    reconcileTimer.unref?.();
  }

  function stopReconcile() {
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
  }

  async function drain(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (active.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...active.values()]);
    }
    return active.size === 0;
  }

  /** Stops picking up new work and waits for the running job (graceful shutdown). */
  async function stop({ timeoutMs = 30000 } = {}) {
    stopped = true;
    stopReconcile();
    pending.length = 0;
    pendingSet.clear();
    return drain(timeoutMs);
  }

  function snapshot() {
    return {
      concurrency,
      queued: pending.length,
      pending: [...pending],
      active: [...active.keys()],
      activeCount: active.size,
      paused,
      pausedReason,
      stopped,
    };
  }

  return {
    drain,
    enqueue,
    isPending,
    pause,
    reconcile,
    remove,
    resume,
    schedule,
    snapshot,
    startReconcile,
    stop,
    stopReconcile,
    get activeCount() {
      return active.size;
    },
    get queuedCount() {
      return pending.length;
    },
    get isPaused() {
      return paused;
    },
  };
}

module.exports = { createRenderQueue };
