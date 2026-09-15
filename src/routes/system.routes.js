'use strict';

const express = require('express');

/**
 * System routes. Mounted at `/api/v1/system` -> `GET /api/v1/system/status`.
 */
function createSystemRouter({ controller }) {
  const router = express.Router();
  router.get('/status', controller.status);
  return router;
}

module.exports = { createSystemRouter };
