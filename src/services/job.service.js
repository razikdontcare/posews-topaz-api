'use strict';

/**
 * Job lifecycle service.
 *
 * Owns: creating a job from a finished upload, listing/getting jobs, cancelling,
 * deleting, and deterministic recovery after a server restart. It never runs
 * ffmpeg itself — that is the render worker's job — and it never touches the
 * HTTP response.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { AppError, errors, isAppError } = require('../utils/errors');
const { isProcessAlive, terminatePidTree } = require('../utils/process');
const {
  JOB_STATUS,
  isActiveStatus,
  isTerminalStatus,
} = require('../domain/job-status');
const { toJobDetail, toJobSummary, toProgressResponse } = require('../domain/job-serializer');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_FAILED_MESSAGE = 'Renderer interrupted by server restart';
/** Grace period for the worker to register its ffmpeg process during cancel. */
const REGISTRATION_WAIT_MS = 3000;

function createJobService({
  config,
  paths,
  repository,
  queue,
  renderService,
  probeService,
  cleanupService,
  uploadService,
  logger,
}) {
  const now = () => new Date().toISOString();

  /**
   * 1-based position in the render pipeline (1 = rendering or next to render),
   * used by the informational `position`/`queuePosition` fields.
   */
  function queuePositions() {
    const ids = repository.findPipelineIds();
    const map = new Map();
    ids.forEach((id, index) => map.set(id, index + 1));
    return map;
  }

  /**
   * Creates a job from a completed upload.
   *
   * The uploaded file is probed *before* the job row exists: an unreadable file
   * never becomes a job, and the temporary directory is removed again.
   */
  async function createFromUpload(upload) {
    const log = logger?.withJob ? logger.withJob(upload.jobId) : logger;

    let media;
    try {
      media = await probeService.inspect(upload.inputPath);
    } catch (error) {
      await uploadService?.discardUpload?.(upload);
      log?.warn?.(`rejected upload: ${error.message}`);
      throw error;
    }

    let job;
    try {
      job = repository.create({
        id: upload.jobId,
        status: JOB_STATUS.QUEUED,
        original_filename: upload.originalFilename,
        input_path: upload.inputPath,
        width: upload.width,
        height: upload.height,
        duration_seconds: media.durationSeconds,
        has_audio: media.hasAudio ? 1 : 0,
        audio_codec: media.audioCodec,
        progress_percent: 0,
      });
    } catch (error) {
      await uploadService?.discardUpload?.(upload);
      throw error;
    }

    if (!job) {
      await uploadService?.discardUpload?.(upload);
      throw errors.internal('Job row could not be created.');
    }

    const position = repository.countPipelineAhead(job.id, job.created_at) + 1;
    log?.info?.(
      `created (${upload.originalFilename}, ${upload.width}x${upload.height}, ` +
        `${media.durationSeconds === null ? 'unknown duration' : `${media.durationSeconds.toFixed(2)}s`}, ` +
        `audio=${media.hasAudio ? media.audioCodec || 'yes' : 'none'})`,
    );

    queue.enqueue(job.id);
    log?.info?.('queued');

    const fresh = repository.findById(job.id) || job;
    return {
      job: fresh,
      // Once the job is already rendering its position is 1 (it is the active one).
      position,
    };
  }

  function findOrThrow(id) {
    const job = repository.findById(id);
    if (!job) throw errors.jobNotFound(id);
    return job;
  }

  function getDetail(id) {
    const job = findOrThrow(id);
    return toJobDetail(job, { live: renderService.getProgress(id) });
  }

  function getProgress(id) {
    const job = findOrThrow(id);
    return toProgressResponse(job, { live: renderService.getProgress(id) });
  }

  function list({ page = 1, limit = DEFAULT_PAGE_SIZE, status = null } = {}) {
    const pageNumber = Number.isFinite(Number(page)) ? Math.trunc(Number(page)) : 1;
    const pageSize = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : DEFAULT_PAGE_SIZE;
    const safePage = Math.max(1, pageNumber);
    const safeLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));

    let statusFilter = null;
    if (status) {
      if (!Object.values(JOB_STATUS).includes(String(status))) {
        throw errors.validation(`Unknown status filter "${String(status).slice(0, 32)}".`, {
          allowed: Object.values(JOB_STATUS),
        });
      }
      statusFilter = String(status);
    }

    const total = repository.countAll({ status: statusFilter });
    const rows = repository.findAll({
      limit: safeLimit,
      offset: (safePage - 1) * safeLimit,
      status: statusFilter,
    });
    const positions = queuePositions();

    return {
      data: rows.map((row) =>
        toJobSummary(row, {
          live: renderService.getProgress(row.id),
          queuePosition: positions.get(row.id) ?? null,
        }),
      ),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      },
    };
  }

  /** Download descriptor; validates state and that the file still exists. */
  async function getDownload(id) {
    const job = findOrThrow(id);
    if (job.status !== JOB_STATUS.COMPLETED) {
      throw errors.jobNotCompleted(id, job.status);
    }
    if (!job.output_path) {
      throw new AppError('OUTPUT_FILE_MISSING', `Rendered file for job ${id} is not available.`);
    }
    let stats;
    try {
      stats = await fsp.stat(job.output_path);
    } catch (error) {
      throw new AppError(
        'OUTPUT_FILE_MISSING',
        `Rendered file for job ${id} is missing on disk.`,
        { cause: error },
      );
    }
    return {
      job,
      path: job.output_path,
      filename: path.basename(job.output_path),
      size: stats.size,
      modifiedAt: stats.mtime,
    };
  }

  async function waitForRenderToStop(id, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (renderService.isActive(id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !renderService.isActive(id);
  }

  /**
   * Waits until the worker either registered its ffmpeg process or settled the
   * job. Resolves with `'active'`, `'terminal'` or `'timeout'`.
   */
  async function waitForRegistrationOrTerminal(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (renderService.isActive(id)) return 'active';
      const row = repository.findById(id);
      if (!row || isTerminalStatus(row.status)) return 'terminal';
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return 'timeout';
  }

  /**
   * Cancellation.
   *  - `queued`            -> `cancelled` immediately (removed from the queue)
   *  - `processing`        -> `cancel_requested`, ffmpeg terminated, then `cancelled`
   */
  async function cancel(id) {
    const job = findOrThrow(id);
    const log = logger?.withJob ? logger.withJob(id) : logger;

    if (isTerminalStatus(job.status)) {
      if (job.status === JOB_STATUS.COMPLETED) {
        throw new AppError('JOB_ALREADY_COMPLETED', `Job ${id} is already completed.`);
      }
      throw errors.jobNotCancellable(id, job.status);
    }

    if (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.PROBING) {
      const cancelled = repository.transition(
        id,
        [JOB_STATUS.QUEUED, JOB_STATUS.PROBING],
        JOB_STATUS.CANCELLED,
        { completed_at: now(), error_code: null, error_message: null },
      );
      if (cancelled) {
        queue.remove(id);
        await cleanupService?.removeJobTemp?.(id);
        log?.info?.('cancelled while queued');
        return repository.findById(id);
      }
      // Lost the race with the worker starting it: fall through to the active path.
    }

    const fresh = repository.findById(id);
    if (!fresh) throw errors.jobNotFound(id);
    if (isTerminalStatus(fresh.status)) return fresh;

    const flagged = renderService.requestCancel(id, 'client requested cancellation');
    repository.transition(
      id,
      [JOB_STATUS.PROCESSING, JOB_STATUS.PROBING, JOB_STATUS.QUEUED],
      JOB_STATUS.CANCEL_REQUESTED,
      {},
    );

    // The worker may be between its atomic claim and registering the ffmpeg
    // process. Wait for it to either register (then we kill it) or settle the
    // job itself, so "cancelled" is never reported while ffmpeg keeps running.
    await waitForRegistrationOrTerminal(id, REGISTRATION_WAIT_MS);

    if (flagged || renderService.isActive(id)) {
      log?.info?.('cancellation requested, stopping ffmpeg');
      await renderService.stop(id, { graceMs: config.killGraceMs });
      await waitForRenderToStop(id, config.shutdownTimeoutMs);
    }

    const finalJob = repository.findById(id);
    if (finalJob && !isTerminalStatus(finalJob.status) && !renderService.isActive(id)) {
      // Nothing is rendering and the worker is gone: settle the state here.
      repository.transition(
        id,
        [JOB_STATUS.CANCEL_REQUESTED, JOB_STATUS.PROCESSING, JOB_STATUS.PROBING],
        JOB_STATUS.CANCELLED,
        { completed_at: now() },
      );
      await cleanupService?.removeJobTemp?.(id);
      return repository.findById(id);
    }
    return finalJob;
  }

  /**
   * Safe deletion: queued jobs are cancelled atomically first, active jobs must be
   * cancelled by the caller before they can be removed.
   */
  async function remove(id, { deleteOutput = false } = {}) {
    const job = findOrThrow(id);
    const log = logger?.withJob ? logger.withJob(id) : logger;

    if (job.status === JOB_STATUS.QUEUED) {
      const cancelled = repository.transition(id, [JOB_STATUS.QUEUED], JOB_STATUS.CANCELLED, {
        completed_at: now(),
      });
      if (!cancelled) throw errors.jobActive(id, repository.findById(id)?.status ?? 'unknown');
      queue.remove(id);
    } else if (isActiveStatus(job.status)) {
      throw errors.jobActive(id, job.status);
    }

    await cleanupService?.removeJobTemp?.(id);

    let outputDeleted = false;
    if (deleteOutput && job.output_path && paths.isInside(paths.outputDir, job.output_path)) {
      try {
        await fsp.rm(job.output_path, { force: true });
        outputDeleted = true;
      } catch (error) {
        log?.warn?.(`could not delete rendered file: ${error.message}`);
      }
    }

    repository.deleteById(id);
    log?.info?.(`deleted${outputDeleted ? ' (rendered file removed)' : ''}`);
    return { id, deleted: true, outputDeleted };
  }

  /**
   * Deterministic recovery after a restart (§15).
   *
   *  - `processing` / `probing` jobs are marked `failed` ("Renderer interrupted
   *    by server restart"); their pid is terminated first if it somehow survived.
   *  - `cancel_requested` jobs end up `cancelled`.
   *  - `queued` jobs are pushed back into the execution queue (in creation order).
   */
  async function recoverInterruptedJobs() {
    const interrupted = repository.findActive();
    const summary = { failed: 0, cancelled: 0, killedPids: [], requeued: 0 };

    for (const job of interrupted) {
      const log = logger?.withJob ? logger.withJob(job.id) : logger;

      // A job that this process is actively rendering must never be touched
      // (recovery is called at startup, but it must also be safe afterwards).
      if (renderService.isActive(job.id)) {
        log?.debug?.('skipping recovery, the job is rendering right now');
        continue;
      }

      if (job.pid) {
        if (isProcessAlive(job.pid)) {
          log?.warn?.(`renderer process pid ${job.pid} survived the restart; terminating it`);
          // Verify the image name: Windows recycles pids, and killing a stranger
          // would be much worse than leaving the stale pid alone.
          const killed = await terminatePidTree(job.pid, {
            logger,
            expectedImage: config.rendererProcessName,
          });
          if (killed) summary.killedPids.push(job.pid);
          else log?.warn?.(`pid ${job.pid} was left alone (not a renderer process)`);
        }
        repository.update(job.id, { pid: null });
      }

      if (job.temp_output_path) {
        await fsp.rm(job.temp_output_path, { force: true }).catch(() => {});
      }

      if (job.status === JOB_STATUS.CANCEL_REQUESTED) {
        repository.transition(job.id, [JOB_STATUS.CANCEL_REQUESTED], JOB_STATUS.CANCELLED, {
          completed_at: now(),
          progress_percent: job.progress_percent ?? 0,
        });
        await cleanupService?.removeJobTemp?.(job.id);
        summary.cancelled += 1;
        log?.info?.('job was cancelled before the restart');
        continue;
      }

      repository.transition(
        job.id,
        [JOB_STATUS.PROCESSING, JOB_STATUS.PROBING],
        JOB_STATUS.FAILED,
        {
          completed_at: now(),
          pid: null,
          temp_output_path: null,
          error_code: 'RENDERER_INTERRUPTED',
          error_message: DEFAULT_FAILED_MESSAGE,
        },
      );
      summary.failed += 1;
      log?.warn?.('marked as failed (renderer interrupted by server restart)');
    }

    const queuedIds = repository.findQueuedIds();
    for (const id of queuedIds) {
      if (queue.enqueue(id)) summary.requeued += 1;
    }

    return summary;
  }

  return {
    cancel,
    createFromUpload,
    getDetail,
    getDownload,
    getProgress,
    list,
    queuePositions,
    recoverInterruptedJobs,
    remove,
    findOrThrow,
  };
}

module.exports = { createJobService, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, DEFAULT_FAILED_MESSAGE };
