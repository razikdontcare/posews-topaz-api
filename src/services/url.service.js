'use strict';

/**
 * Create-from-URL input service.
 *
 * Sibling of the streaming multipart upload service: instead of receiving bytes
 * from the client, the *server* downloads the video from a remote URL and stores
 * it in the same `TEMP_DIR/<jobId>/input.<ext>` location, then hands the job
 * service an input descriptor shaped exactly like a finished upload.
 *
 *   POST /api/v1/jobs/url -> validate URL + SSRF guard -> stream download to disk
 *                         -> TEMP_DIR/<jobId>/input.<ext> -> job created -> 202
 *
 * The download is streamed (never buffered), bounded by URL_MAX_SIZE_BYTES and
 * URL_DOWNLOAD_TIMEOUT_MS, re-validated on every redirect hop, and the temporary
 * directory is removed again when anything fails.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AppError, errors, isAppError, toAppError } = require('../utils/errors');
const { formatBytes } = require('../utils/filename');
const {
  assertHostAllowed,
  extensionFromContentType,
  filenameFromContentDisposition,
  filenameFromUrl,
  isObviousNonVideoContentType,
  parseTargetUrl,
  videoExtensionFromUrl,
} = require('../utils/url');
const { RENDER_OPTION_FIELDS, parseRenderOptions } = require('../domain/render-options');
const { OUTPUT_DIR_FIELD } = require('./upload.service');

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const ACCEPTED_FIELDS = new Set(['url', 'width', 'height', OUTPUT_DIR_FIELD, ...RENDER_OPTION_FIELDS]);

function createUrlService({
  config,
  paths,
  logger,
  parseDimension,
  fetchImpl = globalThis.fetch,
  lookup,
}) {
  const maxBytes = config.urlMaxSizeBytes;
  const timeoutMs = config.urlDownloadTimeoutMs;
  const maxRedirects = config.urlDownloadMaxRedirects;
  const allowedExtensions = config.allowedExtensions;

  if (typeof fetchImpl !== 'function') {
    throw errors.internal('This Node.js runtime does not provide fetch(); URL jobs are unavailable.');
  }

  /** Lowercased field map; JSON keys are case-insensitive like the multipart fields. */
  function normalizeFields(body) {
    const fields = Object.create(null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fields;
    for (const [key, value] of Object.entries(body)) {
      const name = String(key).toLowerCase();
      if (ACCEPTED_FIELDS.has(name) && fields[name] === undefined) fields[name] = value;
    }
    return fields;
  }

  function resolveOutputDir(fields) {
    const raw = fields[OUTPUT_DIR_FIELD];
    const requested = raw === undefined || String(raw).trim() === '' ? undefined : String(raw);
    if (requested !== undefined && !config.allowOutputDirOverride) {
      throw errors.validation(
        'This server does not accept a per-job "outputDir"; renders go to the configured output directory.',
        { field: 'outputDir' },
      );
    }
    return paths.resolveOutputDir(requested);
  }

  /**
   * Streams the remote video into `paths.jobTempDir(jobId)/input.<ext>`.
   *
   * @returns {Promise<{ inputPath: string, extension: string, originalFilename: string,
   *   bytes: number, mimeType: string|null, finalUrl: string }>}
   */
  async function downloadToFile({ url, jobId, signal }) {
    const log = logger?.withJob ? logger.withJob(jobId) : logger;
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new Error('download timeout')),
      timeoutMs,
    );
    timer.unref?.();
    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    let response = null;
    let target = url;
    let redirects = 0;

    try {
      // 1. Follow redirects manually so every hop is re-validated (SSRF).
      for (;;) {
        target = parseTargetUrl(target.toString());
        await assertHostAllowed(target.hostname, {
          allowPrivate: config.urlAllowPrivateHosts,
          lookup,
        });

        response = await fetchImpl(target.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: combined,
          headers: {
            accept: 'video/*,application/octet-stream;q=0.8,*/*;q=0.5',
            'user-agent': config.urlUserAgent,
          },
        });

        if (REDIRECT_STATUS.has(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel?.().catch(() => {});
          response = null;
          if (!location) {
            throw errors.urlDownload('The remote server redirected without a Location header.');
          }
          if (redirects >= maxRedirects) {
            throw errors.urlDownload(`Too many redirects (maximum ${maxRedirects}).`);
          }
          redirects += 1;
          target = new URL(location, target);
          continue;
        }
        break;
      }

      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel?.().catch(() => {});
        response = null;
        throw errors.urlDownload(`The remote server responded with HTTP ${status}.`);
      }
      if (!response.body) {
        throw errors.urlDownload('The remote server returned an empty response body.');
      }

      const contentType = String(response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase() || null;

      if (isObviousNonVideoContentType(contentType)) {
        await response.body.cancel?.().catch(() => {});
        response = null;
        throw errors.invalidVideo('The URL did not return a video file.');
      }

      // 2. Reject oversized downloads up front when the server declares a length.
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body.cancel?.().catch(() => {});
        response = null;
        throw errors.urlDownloadTooLarge(
          `The remote video is larger than the allowed maximum of ${formatBytes(maxBytes)}.`,
          { maxSizeBytes: maxBytes, contentLength: declaredLength },
        );
      }

      const extension =
        videoExtensionFromUrl(target, allowedExtensions) ||
        extensionFromContentType(contentType, allowedExtensions) ||
        '.mp4';
      const originalFilename =
        filenameFromContentDisposition(response.headers.get('content-disposition')) ||
        filenameFromUrl(target) ||
        `video${extension}`;

      const tempDir = paths.jobTempDir(jobId);
      await fsp.mkdir(tempDir, { recursive: true });
      const inputPath = path.join(tempDir, `input${extension}`);

      // 3. Stream to disk with a hard byte ceiling (defense in depth on top of the
      //    Content-Length pre-check).
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            callback(
              errors.urlDownloadTooLarge(
                `The remote video is larger than the allowed maximum of ${formatBytes(maxBytes)}.`,
                { maxSizeBytes: maxBytes },
              ),
            );
            return;
          }
          callback(null, chunk);
        },
      });

      const source = Readable.fromWeb(response.body);
      const writeStream = fs.createWriteStream(inputPath, { flags: 'wx' });
      try {
        await pipeline(source, counter, writeStream, { signal: combined });
      } catch (error) {
        await fsp.rm(inputPath, { force: true }).catch(() => {});
        if (isAppError(error)) throw error;
        if (timeoutController.signal.aborted) {
          throw errors.urlDownload(`The download timed out after ${timeoutMs} ms.`);
        }
        if (combined.aborted) {
          throw new AppError('REQUEST_ABORTED', 'Job creation was aborted by the client.');
        }
        throw errors.urlDownload(`The video could not be downloaded: ${error.message}`, {
          cause: error,
        });
      }

      if (bytes === 0) {
        await fsp.rm(inputPath, { force: true }).catch(() => {});
        throw errors.invalidVideo('The URL returned an empty file.');
      }

      log?.info?.(`download finished (${formatBytes(bytes)}, ${contentType || 'unknown type'})`);
      return {
        inputPath,
        extension,
        originalFilename,
        bytes,
        mimeType: contentType,
        finalUrl: target.toString(),
      };
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel?.().catch(() => {});
    }
  }

  /**
   * Validates the request body, downloads the video and returns the same input
   * descriptor a completed multipart upload produces, so the job service can
   * create the job without knowing where the file came from.
   *
   * @param {{ body: unknown, signal?: AbortSignal }} request
   */
  async function receiveUrl({ body, signal } = {}) {
    if (!config.allowUrlJobs) {
      throw errors.urlNotAllowed(
        'Creating jobs from a URL is disabled on this server (ALLOW_URL_JOBS=false).',
      );
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw errors.validation(
        'Send a JSON body of the form { "url": "https://…", "width": 3840, "height": 1620 }.',
      );
    }

    const fields = normalizeFields(body);
    const jobId = randomUUID();
    const log = logger?.withJob ? logger.withJob(jobId) : logger;
    const tempDir = paths.jobTempDir(jobId);

    try {
      const url = parseTargetUrl(body.url);
      const width = parseDimension(body.width, 'width');
      const height = parseDimension(body.height, 'height');
      const renderOptions = parseRenderOptions(fields, config, { width, height });
      const outputDir = resolveOutputDir(fields);

      paths.ensureDirSync(tempDir);
      log?.info?.(`download started (${url.host})`);

      const downloaded = await downloadToFile({ url, jobId, signal });
      if (downloaded.bytes > maxBytes) {
        throw errors.urlDownloadTooLarge(
          `The remote video is larger than the allowed maximum of ${formatBytes(maxBytes)}.`,
          { maxSizeBytes: maxBytes },
        );
      }

      return {
        jobId,
        originalFilename: downloaded.originalFilename,
        extension: downloaded.extension,
        mimeType: downloaded.mimeType,
        inputPath: downloaded.inputPath,
        tempDir,
        bytes: downloaded.bytes,
        width,
        height,
        outputDir,
        renderOptions,
      };
    } catch (error) {
      // Nothing is persisted yet: a failed download must not leave a temp dir.
      await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      if (isAppError(error)) throw error;
      throw toAppError(error, 'URL_DOWNLOAD_ERROR');
    }
  }

  return {
    downloadToFile,
    receiveUrl,
    maxSizeBytes: maxBytes,
    timeoutMs,
    maxRedirects,
    allowPrivateHosts: config.urlAllowPrivateHosts,
  };
}

module.exports = { createUrlService, REDIRECT_STATUS };
