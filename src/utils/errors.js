'use strict';

/**
 * Error model shared by the HTTP layer, services and the worker.
 *
 * Every failure that reaches a client is an `AppError` with a stable `code`,
 * an HTTP status and a message that is safe to expose. Anything else becomes an
 * `INTERNAL_ERROR` and is only logged server side.
 */

const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 400,
  UPLOAD_ERROR: 400,
  UPLOAD_TOO_LARGE: 413,
  INVALID_VIDEO: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  JOB_NOT_FOUND: 404,
  JOB_NOT_CANCELLABLE: 409,
  JOB_NOT_COMPLETED: 409,
  JOB_ALREADY_COMPLETED: 409,
  JOB_ACTIVE: 409,
  RENDERER_UNAVAILABLE: 503,
  RENDERER_INTERRUPTED: 500,
  FFMPEG_ERROR: 500,
  FFPROBE_ERROR: 500,
  FILESYSTEM_ERROR: 500,
  OUTPUT_FILE_MISSING: 500,
  INPUT_FILE_MISSING: 500,
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  REQUEST_ABORTED: 499,
  SERVICE_UNAVAILABLE: 503,
});

class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} code
   * @param {string} message client-safe message
   * @param {{ status?: number, details?: unknown, cause?: Error, expose?: boolean }} [options]
   */
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'AppError';
    this.code = ERROR_CODES[code] ? code : 'INTERNAL_ERROR';
    this.status = options.status ?? ERROR_CODES[this.code] ?? 500;
    this.details = options.details;
    this.expose = options.expose ?? true;
    if (options.cause) this.cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    const payload = { code: this.code, message: this.message };
    if (this.details !== undefined) payload.details = this.details;
    return payload;
  }
}

function isAppError(error) {
  return error instanceof AppError;
}

function toAppError(error, fallbackCode = 'INTERNAL_ERROR', fallbackMessage) {
  if (isAppError(error)) return error;
  const message =
    fallbackMessage || (error && error.message ? String(error.message) : 'Unexpected server error.');
  return new AppError(fallbackCode, message, { cause: error });
}

const errors = {
  validation: (message, details) => new AppError('VALIDATION_ERROR', message, { details }),
  invalidVideo: (message, details) => new AppError('INVALID_VIDEO', message, { details }),
  jobNotFound: (id) => new AppError('JOB_NOT_FOUND', `Job ${id} was not found.`),
  jobNotCancellable: (id, status) =>
    new AppError(
      'JOB_NOT_CANCELLABLE',
      `Job ${id} cannot be cancelled while it is in status "${status}".`,
    ),
  jobNotCompleted: (id, status) =>
    new AppError('JOB_NOT_COMPLETED', `Job ${id} is not completed yet (status "${status}").`),
  jobActive: (id, status) =>
    new AppError(
      'JOB_ACTIVE',
      `Job ${id} is "${status}". Cancel it and wait until it stops before deleting it.`,
    ),
  rendererUnavailable: (reason) =>
    new AppError('RENDERER_UNAVAILABLE', reason || 'The video renderer is not available.', {
      expose: true,
    }),
  filesystem: (message, cause) => new AppError('FILESYSTEM_ERROR', message, { cause }),
  internal: (message, cause) => new AppError('INTERNAL_ERROR', message, { cause }),
};

module.exports = { AppError, ERROR_CODES, errors, isAppError, toAppError };
