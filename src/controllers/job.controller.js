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

function createJobController({ jobService, uploadService }) {
  return {
    /** POST /api/v1/jobs (multipart/form-data: video, width, height, render options). */
    async create(req, res) {
      const upload = await uploadService.receiveUpload(req);
      const { job, position } = await jobService.createFromUpload(upload);
      res.status(202).json({
        id: job.id,
        status: job.status,
        position,
        width: job.width,
        height: job.height,
        render: renderDescriptor(job),
      });
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
