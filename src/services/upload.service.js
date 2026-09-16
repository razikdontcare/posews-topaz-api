'use strict';

/**
 * Streaming multipart upload.
 *
 * The video is piped straight to disk while the request is still being received:
 * the body is never buffered in memory, `Buffer.concat` is never used and the
 * original filename never becomes part of a filesystem path.
 *
 *   HTTP request -> Busboy -> file stream -> fs.createWriteStream()
 *                                  -> TEMP_DIR/<jobId>/input.<ext>
 *
 * Guard rails: upload size limit, single file, extension allowlist, client
 * disconnect handling, disk write errors and backpressure via `stream.pipe()`.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError, errors, toAppError } = require('../utils/errors');
const { formatBytes, sanitizeExtension, stripDirectory } = require('../utils/filename');
const { RENDER_OPTION_FIELDS, parseRenderOptions } = require('../domain/render-options');

/**
 * Multipart framing (boundaries, headers, and the form fields themselves) is not
 * part of the video size limit.
 */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
/** How much extra data we keep reading before hard-closing the connection. */
const DRAIN_SLACK_BYTES = 64 * 1024 * 1024;

function parseContentLength(header) {
  if (header === undefined || header === null) return null;
  const value = String(Array.isArray(header) ? header[0] : header).trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Fields the endpoint understands: dimensions plus the render options (§22). */
const ACCEPTED_FIELDS = new Set(['width', 'height', ...RENDER_OPTION_FIELDS]);

function createUploadService({ config, paths, logger, Busboy = require('busboy') }) {
  const maxBytes = config.maxUploadSizeBytes;
  const allowedExtensions = config.allowedExtensions;

  function parseDimension(value, name) {
    const raw = value === undefined || value === null ? '' : String(value).trim();
    if (!raw) {
      throw errors.validation(`"${name}" is required.`, { field: name });
    }
    if (!/^\d+$/.test(raw)) {
      throw errors.validation(`"${name}" must be a positive integer.`, {
        field: name,
        received: raw.slice(0, 32),
      });
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw errors.validation(`"${name}" is not a valid number.`, { field: name });
    }
    if (parsed < config.minDimension) {
      throw errors.validation(`"${name}" must be at least ${config.minDimension}.`, { field: name });
    }
    if (parsed > config.maxDimension) {
      throw errors.validation(`"${name}" must be at most ${config.maxDimension}.`, { field: name });
    }
    if (config.enforceEvenDimensions && parsed % 2 !== 0) {
      throw errors.validation(
        `"${name}" must be an even number because the result is encoded as H.264 yuv420p.`,
        { field: name },
      );
    }
    return parsed;
  }

  /** Best-effort recursive removal of a job's temporary directory. */
  async function discardUpload(upload) {
    const dir = typeof upload === 'string' ? upload : upload?.tempDir;
    if (!dir) return;
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      logger?.warn?.(`could not remove ${dir}: ${error.message}`);
    }
  }

  /**
   * Consumes the multipart request.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<{
   *   jobId: string, originalFilename: string, extension: string, mimeType: string|null,
   *   inputPath: string, tempDir: string, bytes: number, width: number, height: number
   * }>}
   */
  function receiveUpload(req) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (settler, value) => {
        if (settled) return;
        settled = true;
        settler(value);
      };

      // Cheap pre-check: reject oversized uploads before reading a single byte.
      const contentLength = parseContentLength(req.headers['content-length']);
      if (contentLength !== null && contentLength > maxBytes + MULTIPART_OVERHEAD_BYTES) {
        return settle(
          reject,
          new AppError(
            'UPLOAD_TOO_LARGE',
            `Upload is larger than the allowed maximum of ${formatBytes(maxBytes)}.`,
            { details: { maxUploadSizeBytes: maxBytes, contentLength } },
          ),
        );
      }

      let parser;
      try {
        parser = Busboy({
          headers: req.headers,
          limits: {
            fileSize: maxBytes,
            files: 1,
            fields: ACCEPTED_FIELDS.size + 4,
            fieldSize: 256,
            fieldNameSize: 64,
            parts: ACCEPTED_FIELDS.size + 6,
          },
        });
      } catch (error) {
        return settle(
          reject,
          new AppError(
            'UNSUPPORTED_MEDIA_TYPE',
            'Expected a multipart/form-data request with a "video" file field.',
            { cause: error },
          ),
        );
      }

      const fields = Object.create(null);
      /** @type {null | { originalFilename: string, extension: string, mimeType: string|null, inputPath: string, tempDir: string, fieldName: string }} */
      let entry = null;
      let fileStream = null;
      let writeStream = null;
      let writeResolve = null;
      let writePromise = Promise.resolve();
      let bytes = 0;
      let failure = null;
      let aborted = false;
      let receivedBeyondLimit = 0;
      let jobLog = logger;

      const trackWrite = () => {
        writePromise = new Promise((resolveWrite) => {
          writeResolve = resolveWrite;
        });
      };
      const settleWrite = () => {
        if (writeResolve) {
          const resolveWrite = writeResolve;
          writeResolve = null;
          resolveWrite();
        }
      };

      const fail = (error) => {
        if (!failure) failure = error;
      };

      /** Stops writing and drains the rest of the request. */
      const abortWrite = (error) => {
        fail(error);
        if (fileStream && writeStream) {
          try {
            fileStream.unpipe(writeStream);
          } catch {
            /* ignore */
          }
        }
        if (writeStream && !writeStream.destroyed) {
          writeStream.destroy();
        }
        // Keep reading (and discarding) so the parser can finish normally.
        fileStream?.resume?.();
        settleWrite();
      };

      const onClientAbort = () => {
        if (settled || aborted) return;
        aborted = true;
        abortWrite(new AppError('REQUEST_ABORTED', 'Upload aborted by the client.'));
        void fsp.rm(entry?.tempDir, { recursive: true, force: true }).catch(() => {});
        settle(reject, new AppError('REQUEST_ABORTED', 'Upload aborted by the client.'));
      };

      req.on('aborted', onClientAbort);
      req.on('close', () => {
        if (!req.complete) onClientAbort();
      });
      req.on('error', (error) => {
        fail(new AppError('UPLOAD_ERROR', `Upload stream error: ${error.message}`, { cause: error }));
      });

      parser.on('file', (fieldName, stream, info) => {
        if (failure) {
          stream.resume();
          return;
        }
        if (fieldName !== 'video') {
          fail(
            errors.validation(
              `Unexpected file field "${String(fieldName).slice(0, 32)}"; use the "video" field.`,
            ),
          );
          stream.resume();
          return;
        }
        if (entry) {
          fail(errors.validation('Only one video file per job is allowed.'));
          stream.resume();
          return;
        }

        const originalFilename = stripDirectory(info.filename) || 'video';
        const extension = sanitizeExtension(path.extname(originalFilename));
        if (!extension || !allowedExtensions.has(extension.slice(1))) {
          fail(
            errors.validation(
              `Unsupported video format "${extension || path.extname(originalFilename) || '(none)'}".`,
              { allowedExtensions: [...allowedExtensions] },
            ),
          );
          stream.resume();
          return;
        }

        const jobId = randomUUID();
        jobLog = logger?.withJob ? logger.withJob(jobId) : logger;

        let tempDir;
        try {
          tempDir = paths.jobTempDir(jobId);
          paths.ensureDirSync(tempDir);
        } catch (error) {
          fail(toAppError(error, 'FILESYSTEM_ERROR', `Could not prepare ${tempDir}: ${error.message}`));
          stream.resume();
          return;
        }

        const inputPath = path.join(tempDir, `input${extension}`);
        entry = {
          jobId,
          fieldName,
          originalFilename,
          extension,
          mimeType: info.mimeType || null,
          inputPath,
          tempDir,
        };

        fileStream = stream;
        trackWrite();
        writeStream = fs.createWriteStream(inputPath, { flags: 'wx' });

        writeStream.on('finish', settleWrite);
        writeStream.on('close', settleWrite);
        writeStream.on('error', (error) => {
          abortWrite(
            toAppError(
              error,
              'FILESYSTEM_ERROR',
              `Could not write the upload to disk: ${error.message}`,
            ),
          );
        });

        stream.on('limit', () => {
          abortWrite(
            new AppError(
              'UPLOAD_TOO_LARGE',
              `Upload is larger than the allowed maximum of ${formatBytes(maxBytes)}.`,
              { details: { maxUploadSizeBytes: maxBytes } },
            ),
          );
        });
        stream.on('error', (error) => {
          abortWrite(
            new AppError('UPLOAD_ERROR', `Upload stream error: ${error.message}`, { cause: error }),
          );
        });
        // Byte counter (defense in depth on top of busboy's own limit).
        stream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            receivedBeyondLimit += chunk.length;
            abortWrite(
              new AppError(
                'UPLOAD_TOO_LARGE',
                `Upload is larger than the allowed maximum of ${formatBytes(maxBytes)}.`,
                { details: { maxUploadSizeBytes: maxBytes } },
              ),
            );
            if (receivedBeyondLimit > DRAIN_SLACK_BYTES) {
              // The client keeps streaming far beyond the limit: stop reading.
              req.destroy();
            }
          }
        });

        jobLog?.info?.(`upload started (${originalFilename}, ${info.mimeType || 'unknown type'})`);
        stream.pipe(writeStream);
      });

      parser.on('field', (name, value, info) => {
        const key = String(name || '').toLowerCase();
        if (info?.valueTruncated) {
          fail(errors.validation(`Field "${key}" is too long.`, { field: key }));
          return;
        }
        // Unknown fields are ignored on purpose (the response echoes the
        // resolved options, so a typo is visible without breaking clients).
        if (ACCEPTED_FIELDS.has(key) && fields[key] === undefined) {
          fields[key] = value;
        }
      });

      parser.on('filesLimit', () => fail(errors.validation('Only one video file per job is allowed.')));
      parser.on('fieldsLimit', () => fail(errors.validation('Too many form fields.')));
      parser.on('partsLimit', () => fail(errors.validation('Too many multipart parts.')));
      parser.on('error', (error) => {
        fail(new AppError('UPLOAD_ERROR', `Malformed multipart request: ${error.message}`, { cause: error }));
        settleWrite();
      });

      parser.on('close', async () => {
        try {
          await writePromise;
        } catch {
          /* the write error was captured through writeStream.on('error') */
        }

        if (failure) {
          await discardUpload(entry);
          return settle(reject, failure);
        }
        if (aborted) {
          return settle(reject, new AppError('REQUEST_ABORTED', 'Upload aborted by the client.'));
        }
        if (!entry) {
          return settle(reject, errors.validation('The "video" file field is required.'));
        }
        if (bytes === 0) {
          await discardUpload(entry);
          return settle(reject, errors.validation('The uploaded file is empty.'));
        }

        let width;
        let height;
        let renderOptions;
        try {
          width = parseDimension(fields.width, 'width');
          height = parseDimension(fields.height, 'height');
          renderOptions = parseRenderOptions(fields, config, { width, height });
        } catch (error) {
          await discardUpload(entry);
          return settle(reject, error);
        }

        jobLog?.info?.(
          `upload finished (${formatBytes(bytes)}, ${width}x${height})`,
        );
        return settle(resolve, {
          jobId: entry.jobId,
          originalFilename: entry.originalFilename,
          extension: entry.extension,
          mimeType: entry.mimeType,
          inputPath: entry.inputPath,
          tempDir: entry.tempDir,
          bytes,
          width,
          height,
          renderOptions,
        });
      });

      req.pipe(parser);
    });
  }

  return {
    discardUpload,
    parseDimension,
    receiveUpload,
    maxUploadSizeBytes: maxBytes,
    allowedExtensions: [...allowedExtensions],
    MULTIPART_OVERHEAD_BYTES,
  };
}

module.exports = { createUploadService, parseContentLength, MULTIPART_OVERHEAD_BYTES };
