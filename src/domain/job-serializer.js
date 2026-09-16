'use strict';

/**
 * API serializers.
 *
 * Database rows are snake_case; the HTTP contract is the nested camelCase shape
 * documented in AGENTS.md §32. Filesystem paths are never exposed — only the
 * output *filename* is.
 */

const path = require('node:path');
const { JOB_STATUS, isTerminalStatus } = require('./job-status');

function toNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function outputDescriptor(job) {
  if (!job.output_path) return null;
  return {
    filename: path.basename(job.output_path),
    sizeBytes: toNumberOrNull(job.total_size),
  };
}

function errorDescriptor(job) {
  if (!job.error_code && !job.error_message) return null;
  return {
    code: job.error_code || 'INTERNAL_ERROR',
    message: job.error_message || 'The render failed.',
  };
}

/**
 * Resolved render options of a job (model, Topaz tunables, encoder quality,
 * audio handling). `null` for jobs created before the option existed.
 */
function renderDescriptor(job) {
  if (!job.render_options) return null;
  try {
    const parsed = JSON.parse(job.render_options);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function progressPercent(job, live) {
  if (live && Number.isFinite(live.progressPercent)) return live.progressPercent;
  if (job.status === JOB_STATUS.COMPLETED) return 100;
  const stored = toNumberOrNull(job.progress_percent);
  return stored === null ? 0 : stored;
}

/** Full job representation (GET /api/v1/jobs/:id). */
function toJobDetail(job, options = {}) {
  const live = options.live || null;
  return {
    id: job.id,
    status: job.status,
    input: {
      filename: job.original_filename,
    },
    output: outputDescriptor(job),
    resolution: {
      width: job.width,
      height: job.height,
    },
    render: renderDescriptor(job),
    progress: {
      percent: progressPercent(job, live),
      frame: live && live.frame !== null ? live.frame : toNumberOrNull(job.frame),
      fps: live && live.fps !== null ? live.fps : toNumberOrNull(job.fps),
      speed: (live && live.speed) || job.speed || null,
      elapsedSeconds: toNumberOrNull(
        live && live.elapsedSeconds !== null ? live.elapsedSeconds : job.elapsed_seconds,
      ),
      durationSeconds: toNumberOrNull(job.duration_seconds),
    },
    timestamps: {
      createdAt: job.created_at,
      startedAt: job.started_at || null,
      completedAt: job.completed_at || null,
      updatedAt: job.updated_at,
    },
    error: errorDescriptor(job),
  };
}

/** List item: same contract, plus the (best effort) queue position. */
function toJobSummary(job, options = {}) {
  const detail = toJobDetail(job, options);
  return {
    ...detail,
    queuePosition: job.status === JOB_STATUS.QUEUED ? (options.queuePosition ?? null) : null,
  };
}

/** Lightweight polling payload (GET /api/v1/jobs/:id/progress). */
function toProgressResponse(job, options = {}) {
  const live = options.live || null;
  const payload = {
    id: job.id,
    status: job.status,
    progress: progressPercent(job, live),
    frame: live && live.frame !== null ? live.frame : toNumberOrNull(job.frame),
    fps: live && live.fps !== null ? live.fps : toNumberOrNull(job.fps),
    speed: (live && live.speed) || job.speed || null,
    elapsed: toNumberOrNull(
      live && live.elapsedSeconds !== null ? live.elapsedSeconds : job.elapsed_seconds,
    ),
    duration: toNumberOrNull(job.duration_seconds),
    output: outputDescriptor(job),
  };
  const error = errorDescriptor(job);
  if (error) payload.error = error;
  if (isTerminalStatus(job.status)) payload.completed = job.status === JOB_STATUS.COMPLETED;
  return payload;
}

module.exports = { toJobDetail, toJobSummary, toProgressResponse, outputDescriptor, renderDescriptor };
