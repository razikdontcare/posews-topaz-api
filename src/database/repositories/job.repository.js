'use strict';

/**
 * Job repository: every SQL statement touching the `jobs` table lives here.
 * All values are passed as bound parameters (`?`); only whitelisted column names
 * are ever interpolated into SQL.
 */

const {
  JOB_STATUS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  isKnownStatus,
} = require('../../domain/job-status');
const { errors } = require('../../utils/errors');

const COLUMNS = Object.freeze([
  'id',
  'status',
  'original_filename',
  'input_path',
  'output_path',
  'temp_output_path',
  'width',
  'height',
  'duration_seconds',
  'progress_percent',
  'frame',
  'fps',
  'speed',
  'elapsed_seconds',
  'total_size',
  'pid',
  'error_code',
  'error_message',
  'has_audio',
  'audio_codec',
  'created_at',
  'started_at',
  'completed_at',
  'updated_at',
]);

const UPDATABLE_COLUMNS = new Set(COLUMNS.filter((column) => column !== 'id'));
const REQUIRED_COLUMNS = ['id', 'status', 'original_filename', 'input_path', 'width', 'height'];

const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM jobs`;

/** Coerces SQLite integers to booleans/nulls for the service layer. */
function mapRow(row) {
  if (!row) return undefined;
  return {
    ...row,
    has_audio: row.has_audio === null || row.has_audio === undefined ? null : Boolean(row.has_audio),
    progress_percent: Number.isFinite(row.progress_percent) ? row.progress_percent : 0,
  };
}

function placeholders(count) {
  return new Array(count).fill('?').join(', ');
}

function createJobRepository({ database }) {
  if (!database) throw errors.internal('createJobRepository requires a database instance.');

  function map(rows) {
    return Array.isArray(rows) ? rows.map(mapRow) : rows;
  }

  function create(job) {
    const missing = REQUIRED_COLUMNS.filter(
      (column) => job[column] === undefined || job[column] === null,
    );
    if (missing.length > 0) {
      throw errors.internal(`Cannot create job, missing fields: ${missing.join(', ')}`);
    }
    if (!isKnownStatus(job.status)) {
      throw errors.internal(`Cannot create job with unknown status "${job.status}".`);
    }

    const now = new Date().toISOString();
    const record = {
      status: JOB_STATUS.QUEUED,
      duration_seconds: null,
      output_path: null,
      temp_output_path: null,
      progress_percent: 0,
      frame: null,
      fps: null,
      speed: null,
      elapsed_seconds: null,
      total_size: null,
      pid: null,
      error_code: null,
      error_message: null,
      has_audio: null,
      started_at: null,
      completed_at: null,
      ...job,
      created_at: job.created_at || now,
      updated_at: job.updated_at || now,
    };

    const columns = COLUMNS.filter((column) => record[column] !== undefined);
    const sql = `INSERT INTO jobs (${columns.join(', ')}) VALUES (${placeholders(columns.length)})`;
    database.withRetry(() => database.run(sql, columns.map((column) => record[column])));
    return findById(record.id);
  }

  function findById(id) {
    return mapRow(database.get(`${SELECT_ALL} WHERE id = ?`, [id]));
  }

  function findAll({ limit = 20, offset = 0, status = null } = {}) {
    if (status) {
      return map(
        database.all(
          `${SELECT_ALL} WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
          [status, limit, offset],
        ),
      );
    }
    return map(
      database.all(
        `${SELECT_ALL} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        [limit, offset],
      ),
    );
  }

  function countAll({ status = null } = {}) {
    const row = status
      ? database.get('SELECT COUNT(*) AS total FROM jobs WHERE status = ?', [status])
      : database.get('SELECT COUNT(*) AS total FROM jobs');
    return row ? Number(row.total) : 0;
  }

  function findQueued(limit = 1000) {
    return map(
      database.all(
        `${SELECT_ALL} WHERE status = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
        [JOB_STATUS.QUEUED, limit],
      ),
    );
  }

  function findQueuedIds(limit = 1000) {
    return database
      .all(
        'SELECT id FROM jobs WHERE status = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
        [JOB_STATUS.QUEUED, limit],
      )
      .map((row) => row.id);
  }

  /** Jobs that may hold (or have held) a renderer process. */
  function findActive() {
    return map(
      database.all(
        `${SELECT_ALL} WHERE status IN (${placeholders(ACTIVE_STATUSES.length)}) ORDER BY created_at ASC`,
        ACTIVE_STATUSES,
      ),
    );
  }

  function findByStatuses(statuses) {
    if (!Array.isArray(statuses) || statuses.length === 0) return [];
    const valid = statuses.filter(isKnownStatus);
    if (valid.length === 0) return [];
    return map(
      database.all(
        `${SELECT_ALL} WHERE status IN (${placeholders(valid.length)}) ORDER BY created_at ASC`,
        valid,
      ),
    );
  }

  /** Terminal jobs whose retention window has expired. */
  function findExpired({ completedBefore, failedBefore, limit = 200 }) {
    return map(
      database.all(
        `${SELECT_ALL}
           WHERE (status = ? AND completed_at IS NOT NULL AND completed_at < ?)
              OR (status = ? AND completed_at IS NOT NULL AND completed_at < ?)
           ORDER BY completed_at ASC
           LIMIT ?`,
        [
          JOB_STATUS.COMPLETED,
          completedBefore,
          JOB_STATUS.FAILED,
          failedBefore,
          limit,
        ],
      ),
    );
  }

  function findCancelled({ limit = 200 } = {}) {
    return map(
      database.all(
        `${SELECT_ALL} WHERE status = ? ORDER BY created_at ASC LIMIT ?`,
        [JOB_STATUS.CANCELLED, limit],
      ),
    );
  }

  function countByStatus() {
    const rows = database.all('SELECT status, COUNT(*) AS total FROM jobs GROUP BY status');
    const counts = {};
    for (const status of Object.values(JOB_STATUS)) counts[status] = 0;
    for (const row of rows) counts[row.status] = Number(row.total);
    return counts;
  }

  /** How many jobs reference this exact output file. */
  function countByOutputPath(outputPath) {
    const row = database.get('SELECT COUNT(*) AS total FROM jobs WHERE output_path = ?', [outputPath]);
    return row ? Number(row.total) : 0;
  }

  /**
   * How many jobs are still ahead of this one in the render pipeline
   * (`queued`/`probing`/`processing`/`cancel_requested`, oldest first). Used for
   * the informational `position` of a newly created job.
   */
  function countPipelineAhead(id, createdAt) {
    const pipelineStatuses = [...ACTIVE_STATUSES, JOB_STATUS.QUEUED];
    const row = database.get(
      `SELECT COUNT(*) AS ahead FROM jobs
         WHERE status IN (${placeholders(pipelineStatuses.length)})
           AND id != ?
           AND (created_at < ?
                OR (created_at = ? AND rowid < (SELECT rowid FROM jobs WHERE id = ?)))`,
      [...pipelineStatuses, id, createdAt, createdAt, id],
    );
    return row ? Number(row.ahead) : 0;
  }

  /** Ids of the jobs currently in the pipeline, oldest first. */
  function findPipelineIds(limit = 1000) {
    const pipelineStatuses = [...ACTIVE_STATUSES, JOB_STATUS.QUEUED];
    return database
      .all(
        `SELECT id FROM jobs
           WHERE status IN (${placeholders(pipelineStatuses.length)})
           ORDER BY created_at ASC, rowid ASC
           LIMIT ?`,
        [...pipelineStatuses, limit],
      )
      .map((row) => row.id);
  }

  /**
   * Generic partial update. `undefined` values are ignored, `null` clears a
   * column (except for NOT NULL columns which callers must not clear).
   */
  function update(id, patch) {
    const entries = Object.entries(patch).filter(
      ([column, value]) => UPDATABLE_COLUMNS.has(column) && value !== undefined,
    );
    if (entries.length === 0) return findById(id);

    const hasUpdatedAt = entries.some(([column]) => column === 'updated_at');
    const columns = entries.map(([column]) => column);
    const values = entries.map(([, value]) => value);
    if (!hasUpdatedAt) {
      columns.push('updated_at');
      values.push(new Date().toISOString());
    }

    database.withRetry(() =>
      database.run(
        `UPDATE jobs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
        [...values, id],
      ),
    );
    return findById(id);
  }

  /**
   * Atomic status transition. Only succeeds when the row is currently in one of
   * `fromStatuses`, which is what makes "one job is only ever executed once"
   * (and cancel racing with start) safe.
   */
  function transition(id, fromStatuses, status, patch = {}) {
    if (!isKnownStatus(status)) {
      throw errors.internal(`Refusing to set unknown job status "${status}".`);
    }
    const from = (Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses]).filter(isKnownStatus);
    if (from.length === 0) return false;

    const entries = Object.entries(patch).filter(
      ([column, value]) => UPDATABLE_COLUMNS.has(column) && value !== undefined,
    );
    const columns = entries.map(([column]) => column);
    const values = entries.map(([, value]) => value);

    columns.push('status');
    values.push(status);
    columns.push('updated_at');
    values.push(new Date().toISOString());

    const result = database.withRetry(() =>
      database.run(
        `UPDATE jobs SET ${columns.map((column) => `${column} = ?`).join(', ')}
           WHERE id = ? AND status IN (${placeholders(from.length)})`,
        [...values, id, ...from],
      ),
    );
    return result.changes > 0;
  }

  /** queued -> processing, the only path that may start a render. */
  function tryMarkProcessing(id, patch = {}) {
    return transition(id, [JOB_STATUS.QUEUED], JOB_STATUS.PROCESSING, {
      started_at: patch.started_at || new Date().toISOString(),
      error_code: null,
      error_message: null,
      ...patch,
    });
  }

  function deleteById(id) {
    const result = database.withRetry(() => database.run('DELETE FROM jobs WHERE id = ?', [id]));
    return result.changes > 0;
  }

  function deleteOlderThan(isoDate, { statuses = TERMINAL_STATUSES } = {}) {
    const valid = statuses.filter(isKnownStatus);
    if (valid.length === 0) return 0;
    const result = database.withRetry(() =>
      database.run(
        `DELETE FROM jobs
           WHERE status IN (${placeholders(valid.length)})
             AND COALESCE(completed_at, updated_at) < ?`,
        [...valid, isoDate],
      ),
    );
    return result.changes;
  }

  return {
    COLUMNS,
    countAll,
    countByOutputPath,
    countByStatus,
    countPipelineAhead,
    create,
    deleteById,
    deleteOlderThan,
    findAll,
    findActive,
    findById,
    findByStatuses,
    findCancelled,
    findExpired,
    findPipelineIds,
    findQueued,
    findQueuedIds,
    transition,
    tryMarkProcessing,
    update,
  };
}

module.exports = { COLUMNS, UPDATABLE_COLUMNS, createJobRepository, mapRow };
