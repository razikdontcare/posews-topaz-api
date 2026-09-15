'use strict';

/**
 * Minimal structured logger.
 *
 * Format: `2026-09-14T07:30:00.000Z [INFO] Job 769337925 created`
 * Every job related line carries the job id so logs stay grep-able.
 */

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });
const MAX_LINE_LENGTH = 4000;

function sanitizeArg(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary ${value.byteLength} bytes]`;
  }
  return value;
}

function formatLine(level, name, prefix, args) {
  const timestamp = new Date().toISOString();
  let message;
  try {
    message = util.format(...args.map(sanitizeArg));
  } catch {
    message = args.map((arg) => String(arg)).join(' ');
  }
  if (message.length > MAX_LINE_LENGTH) {
    message = `${message.slice(0, MAX_LINE_LENGTH)}…[truncated]`;
  }
  const scope = name ? ` ${name}:` : '';
  return `${timestamp} [${level.toUpperCase()}]${scope} ${prefix}${message}`;
}

function createLogger(options = {}) {
  const threshold = LEVELS[options.level] ?? LEVELS.info;
  const name = options.name || '';
  const prefix = options.prefix || '';
  const toConsole = options.console !== false;
  const toFile = Boolean(options.toFile && options.logsDir);

  let stream = null;
  let streamDate = null;
  let fileErrorReported = false;

  function dayStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function getStream() {
    if (!toFile) return null;
    const today = dayStamp();
    if (stream && streamDate === today) return stream;
    try {
      fs.mkdirSync(options.logsDir, { recursive: true });
      if (stream) stream.end();
      stream = fs.createWriteStream(path.join(options.logsDir, `app-${today}.log`), {
        flags: 'a',
        encoding: 'utf8',
      });
      streamDate = today;
      stream.on('error', (error) => {
        if (!fileErrorReported) {
          fileErrorReported = true;
          process.stderr.write(`[WARN] file logging disabled: ${error.message}\n`);
        }
        stream = null;
      });
    } catch (error) {
      if (!fileErrorReported) {
        fileErrorReported = true;
        process.stderr.write(`[WARN] file logging disabled: ${error.message}\n`);
      }
      stream = null;
    }
    return stream;
  }

  function write(level, args) {
    if (LEVELS[level] > threshold) return;
    const line = formatLine(level, name, prefix, args);
    if (toConsole) {
      if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    }
    const out = getStream();
    if (out) out.write(`${line}\n`);
  }

  const logger = {
    level: options.level || 'info',
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
    /** Adds a `Job <id> ` prefix (or any other scope) to every line. */
    withJob(jobId) {
      return createLogger({ ...options, prefix: jobId ? `Job ${jobId} ` : '' });
    },
    child(scope) {
      return createLogger({ ...options, name: name ? `${name}:${scope}` : scope });
    },
    /** Flushes and closes the file stream (used during graceful shutdown). */
    async close() {
      if (!stream) return;
      const closing = stream;
      stream = null;
      await new Promise((resolve) => closing.end(resolve));
    },
  };

  return logger;
}

module.exports = { createLogger, LEVELS };
