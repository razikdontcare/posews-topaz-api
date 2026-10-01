'use strict';

/**
 * Job endpoints (AGENTS.md §22).
 *
 * Controllers only translate HTTP <-> service calls: no ffmpeg, no SQL, no
 * business rules live here.
 */

const { errors } = require('../utils/errors');
const { renderDescriptor } = require('../domain/job-serializer');

function contentDisposition(filename) {
  const fallback = String(filename)
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  // RFC 5987: only attr-char may appear unescaped inside `filename*`.
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parsePagination(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? undefined : Number(query.limit);
  if (page !== undefined && (!Number.isFinite(page) || page < 1)) {
    throw errors.validation('"page" must be a positive integer.', { parameter: 'page' });
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw errors.validation('"limit" must be a positive integer.', { parameter: 'limit' });
  }
  return { page, limit };
}

function createJobController({ jobService, uploadService, urlService, rendererService }) {
  /** The renderer must be usable before a (potentially huge) input is accepted. */
  function assertRendererAvailable() {
    if (rendererService && !rendererService.isAvailable()) {
      const status = rendererService.getStatus();
      throw errors.rendererUnavailable(
        `The video renderer is not available (${status.reason || status.state}) and no jobs are ` +
          'accepted right now. See GET /api/v1/system/status for details.',
      );
    }
  }

  /** Same 202 payload for both creation paths (upload and URL). */
  function createdJobResponse(job, position) {
    return {
      id: job.id,
      status: job.status,
      position,
      width: job.width,
      height: job.height,
      outputDir: job.output_dir || null,
      render: renderDescriptor(job),
    };
  }

  /**
   * Aborts the in-flight download when the client disconnects. `req.complete` is
   * already true (the JSON body was parsed), so a normal `close` is ignored.
   */
  function clientAbortSignal(req) {
    const controller = new AbortController();
    const onAborted = () => controller.abort();
    req.on('aborted', onAborted);
    req.on('close', () => {
      if (!req.complete) onAborted();
    });
    req.on('error', onAborted);
    return controller.signal;
  }

  return {
    /** POST /api/v1/jobs (multipart/form-data: video, width, height, render options). */
    async create(req, res) {
      // Reject before reading a single byte: a renderer that cannot render must not
      // accept multi-gigabyte uploads that are doomed to fail. The server keeps
      // re-validating in the background and starts accepting jobs again by itself.
      assertRendererAvailable();

      const upload = await uploadService.receiveUpload(req);
      const { job, position } = await jobService.createFromSource(upload);
      res.status(202).json(createdJobResponse(job, position));
    },

    /**
     * POST /api/v1/jobs/url (application/json: url, width, height, render options).
     *
     * The server downloads the video itself before the job exists, so the request
     * stays open for the duration of the transfer — just like an upload.
     */
    async createFromUrl(req, res) {
      assertRendererAvailable();
      if (!urlService) {
        throw errors.rendererUnavailable('Creating jobs from a URL is not available on this server.');
      }

      const source = await urlService.receiveUrl({
        body: req.body,
        signal: clientAbortSignal(req),
      });
      const { job, position } = await jobService.createFromSource(source);
      res.status(202).json(createdJobResponse(job, position));
    },

    /** GET /api/v1/jobs?page=&limit=&status= */
    list(req, res) {
      const { page, limit } = parsePagination(req.query);
      res.json(jobService.list({ page, limit, status: req.query.status }));
    },

    /** GET /api/v1/jobs/:id */
    get(req, res) {
      res.json(jobService.getDetail(req.params.id));
    },

    /** GET /api/v1/jobs/:id/progress (cheap, polled by the frontend). */
    progress(req, res) {
      res.json(jobService.getProgress(req.params.id));
    },

    /** POST /api/v1/jobs/:id/cancel */
    async cancel(req, res) {
      const job = await jobService.cancel(req.params.id);
      res.json(jobService.getDetail(job.id));
    },

    /** DELETE /api/v1/jobs/:id[?deleteOutput=true] */
    async remove(req, res) {
      const deleteOutput = ['1', 'true', 'yes'].includes(String(req.query.deleteOutput ?? '').toLowerCase());
      const result = await jobService.remove(req.params.id, { deleteOutput });
      res.json(result);
    },

    /** GET /api/v1/jobs/:id/download — streams the rendered file. */
    async download(req, res) {
      const info = await jobService.getDownload(req.params.id);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(info.size));
      res.setHeader('Content-Disposition', contentDisposition(info.filename));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.sendFile(info.path, (error) => {
        if (!error) return;
        if (error.code === 'ECONNABORTED' || res.writableEnded || res.destroyed) return;
        res.destroy?.();
      });
    },
  };
}

module.exports = { createJobController, contentDisposition, parsePagination };
