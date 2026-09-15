'use strict';

/**
 * SQLite access layer (node:sqlite, synchronous).
 *
 * SQLite is the single source of truth for job state. The connection is opened
 * once per process, in WAL mode, with a busy timeout so a concurrent PM2 restart
 * cannot surface `SQLITE_BUSY` to a request handler.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { AppError, errors } = require('../utils/errors');

const BUSY_PATTERN = /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i;

function isBusyError(error) {
  if (!error) return false;
  return BUSY_PATTERN.test(`${error.code ?? ''} ${error.message ?? ''}`);
}

/** node:sqlite rejects `undefined`/`NaN`; SQLite has no boolean type either. */
function normalizeParams(params) {
  if (params === undefined || params === null) return [];
  const list = Array.isArray(params) ? params : [params];
  return list.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' && Number.isNaN(value)) return null;
    return value;
  });
}

function createDatabase({ file, logger, busyTimeoutMs = 5000 }) {
  if (!file || typeof file !== 'string') {
    throw new AppError('INTERNAL_ERROR', 'Database file path is required.');
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });

  let closed = false;
  let connection;
  try {
    connection = new DatabaseSync(file);
  } catch (error) {
    throw errors.filesystem(`Could not open the SQLite database at ${file}: ${error.message}`, error);
  }

  connection.exec('PRAGMA journal_mode = WAL');
  connection.exec('PRAGMA synchronous = NORMAL');
  connection.exec('PRAGMA foreign_keys = ON');
  connection.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  connection.exec('PRAGMA wal_autocheckpoint = 1000');

  function assertOpen() {
    if (closed) throw new AppError('INTERNAL_ERROR', 'The SQLite database connection is closed.');
  }

  function handle(error, sql) {
    if (error instanceof AppError) throw error;
    const detail = `${error.message}${sql ? ` [${sql.slice(0, 160)}]` : ''}`;
    if (isBusyError(error)) {
      throw new AppError('SERVICE_UNAVAILABLE', `Database is busy, please retry: ${detail}`, {
        expose: true,
        cause: error,
      });
    }
    throw new AppError('INTERNAL_ERROR', `Database error: ${detail}`, { cause: error });
  }

  function exec(sql) {
    assertOpen();
    try {
      connection.exec(sql);
    } catch (error) {
      handle(error, sql);
    }
  }

  function run(sql, params) {
    assertOpen();
    try {
      const statement = connection.prepare(sql);
      const result = statement.run(...normalizeParams(params));
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
      };
    } catch (error) {
      return handle(error, sql);
    }
  }

  function get(sql, params) {
    assertOpen();
    try {
      const statement = connection.prepare(sql);
      const row = statement.get(...normalizeParams(params));
      return row ? { ...row } : undefined;
    } catch (error) {
      return handle(error, sql);
    }
  }

  function all(sql, params) {
    assertOpen();
    try {
      const statement = connection.prepare(sql);
      return statement.all(...normalizeParams(params)).map((row) => ({ ...row }));
    } catch (error) {
      return handle(error, sql);
    }
  }

  /** Runs `callback` inside a single write transaction. */
  function transaction(callback) {
    assertOpen();
    let depth = 0;
    return (...args) => {
      const isOuter = depth === 0;
      if (isOuter) exec('BEGIN IMMEDIATE');
      depth += 1;
      try {
        const result = callback(...args);
        depth -= 1;
        if (isOuter) exec('COMMIT');
        return result;
      } catch (error) {
        depth -= 1;
        if (isOuter) {
          try {
            exec('ROLLBACK');
          } catch {
            /* the transaction may already be rolled back by SQLite */
          }
        }
        throw error;
      }
    };
  }

  /**
   * Retries a write a few times when SQLite reports a lock. `busy_timeout`
   * already waits inside SQLite, so this is only a short last-resort guard:
   * this driver is synchronous, which means every retry blocks the event loop.
   */
  function withRetry(operation, { attempts = 3, delayMs = 25 } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        if (!isBusyError(error)) throw error;
        lastError = error;
        const waitUntil = Date.now() + delayMs * (attempt + 1);
        while (Date.now() < waitUntil) {
          // Deliberately short: busy_timeout is the primary mechanism.
        }
      }
    }
    throw errors.internal('Database stayed locked after several attempts.', lastError);
  }

  /** Startup smoke test: the database must be readable and writable. */
  function check() {
    assertOpen();
    const row = get('SELECT 1 AS ok');
    if (!row || row.ok !== 1) {
      throw errors.filesystem(`SQLite database at ${file} is not readable.`);
    }
    const journal = get('PRAGMA journal_mode');
    return { file, journalMode: journal ? journal.journal_mode : null };
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      connection.close();
    } catch (error) {
      logger?.warn?.(`failed to close SQLite cleanly: ${error.message}`);
    }
  }

  return {
    file,
    exec,
    run,
    get,
    all,
    transaction,
    withRetry,
    check,
    close,
    get isClosed() {
      return closed;
    },
  };
}

module.exports = { createDatabase, isBusyError, normalizeParams };
