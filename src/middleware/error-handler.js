'use strict';

/**
 * Central error handling.
 *
 * The client always receives `{ error: { code, message, details? } }` with a
 * stable code (§26). Internal failures are logged with their stack trace but the
 * response only contains a generic message so nothing about the filesystem, SQL
 * or the host leaks.
 */

const { AppError, isAppError, toAppError } = require('../utils/errors');

/** Codes whose messages are curated and safe to expose. */
const PUBLIC_MESSAGE_OVERRIDES = Object.freeze({
  INTERNAL_ERROR: 'Unexpected server error.',
  FILESYSTEM_ERROR: 'A filesystem error occurred on the server while handling the job.',
});

function notFoundHandler(req, res, next) {
  next(
    new AppError('NOT_FOUND', `Route ${req.method} ${req.originalUrl} does not exist.`),
  );
}

function createErrorHandler({ logger } = {}) {
  // Express identifies middleware by arity: keep all four parameters.
  return function errorHandler(error, req, res, next) {
    let appError = isAppError(error) ? error : toAppError(error, 'INTERNAL_ERROR');

    // Body parser / upload limit errors must map onto our error contract.
    if (!isAppError(error)) {
      if (error?.type === 'entity.too.large') {
        appError = new AppError('UPLOAD_TOO_LARGE', 'Request body is too large.');
      } else if (error?.type === 'entity.parse.failed') {
        appError = new AppError('VALIDATION_ERROR', 'Request body is not valid JSON.');
      }
    }

    const requestLabel = `${req.method} ${req.originalUrl} req=${req.id}`;
    if (appError.status >= 500) {
      logger?.error?.(`${requestLabel} failed [${appError.code}]: ${error?.stack || appError.message}`);
    } else {
      logger?.warn?.(`${requestLabel} rejected [${appError.code}]: ${appError.message}`);
    }

    // A rejected oversized upload: tell the client to stop, then discard whatever
    // is still in flight so the response is actually delivered (destroying the
    // socket immediately would surface as ECONNRESET on the client).
    const stopClientUpload = appError.code === 'UPLOAD_TOO_LARGE';
    if (stopClientUpload) res.setHeader('Connection', 'close');

    if (res.headersSent || res.writableEnded) {
      // The response already started (e.g. a streaming download aborted).
      res.destroy?.();
      return;
    }
    if (res.destroyed) return;

    const message = PUBLIC_MESSAGE_OVERRIDES[appError.code] ?? appError.message;
    const body = { error: { code: appError.code, message } };
    if (appError.details !== undefined && appError.expose !== false) {
      body.error.details = appError.details;
    }

    res.status(appError.status || 500).json(body);

    if (stopClientUpload && req.complete === false) {
      // Drains the remaining body; Node closes the connection afterwards because
      // of the `Connection: close` header.
      req.resume?.();
    }
  };
}

module.exports = { createErrorHandler, notFoundHandler, PUBLIC_MESSAGE_OVERRIDES };
