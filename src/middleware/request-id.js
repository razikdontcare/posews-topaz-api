'use strict';

/**
 * Request correlation id: every request gets an id that is echoed back in the
 * `x-request-id` header and included in logs, which makes a single upload/job
 * traceable across services and log files.
 */

const { randomUUID } = require('node:crypto');

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

function createRequestIdMiddleware({ headerName = 'x-request-id' } = {}) {
  return function requestIdMiddleware(req, res, next) {
    const incoming = req.headers[headerName];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    req.id = typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
    res.setHeader(headerName, req.id);
    next();
  };
}

/** Debug-level access log; progress polling at 1 Hz stays out of the info log. */
function createRequestLogger({ logger }) {
  return function requestLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger?.debug?.(
        `${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs.toFixed(1)}ms) ` +
          `req=${req.id}`,
      );
    });
    res.on('close', () => {
      if (res.writableEnded) return;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger?.warn?.(
        `${req.method} ${req.originalUrl} aborted by the client after ${durationMs.toFixed(1)}ms ` +
          `req=${req.id}`,
      );
    });
    next();
  };
}

module.exports = { createRequestIdMiddleware, createRequestLogger, SAFE_REQUEST_ID };
