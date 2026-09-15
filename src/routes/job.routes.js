'use strict';

const express = require('express');

/**
 * Job routes. Mounted at `/api/v1`, so `POST /jobs` -> `POST /api/v1/jobs`.
 */
function createJobRouter({ controller }) {
  const router = express.Router();

  router.post('/jobs', controller.create);
  router.get('/jobs', controller.list);
  router.get('/jobs/:id', controller.get);
  router.get('/jobs/:id/progress', controller.progress);
  router.get('/jobs/:id/download', controller.download);
  router.post('/jobs/:id/cancel', controller.cancel);
  router.delete('/jobs/:id', controller.remove);

  return router;
}

module.exports = { createJobRouter };
