'use strict';

const express = require('express');

/**
 * System routes. Mounted at `/api/v1/system`.
 */
function createSystemRouter({ controller }) {
  const router = express.Router();
  router.get('/status', controller.status);
  router.get('/output-dir', controller.getOutputDir);
  router.put('/output-dir', controller.setOutputDir);
  return router;
}

module.exports = { createSystemRouter };
