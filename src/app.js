'use strict';

/**
 * Express application factory.
 *
 * Dependencies are injected so the app can be booted against a temporary
 * database/temp directory in tests without touching the production paths.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { createJobRouter } = require('./routes/job.routes');
const { createSystemRouter } = require('./routes/system.routes');
const { createErrorHandler, notFoundHandler } = require('./middleware/error-handler');
const { createRequestIdMiddleware, createRequestLogger } = require('./middleware/request-id');

/** `CORS_ORIGIN=*` (default) or a comma separated allowlist. */
function resolveCorsOptions(config) {
  const origins = config.corsOrigins || ['*'];
  if (origins.includes('*')) {
    return { origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], maxAge: 86400 };
  }
  const allowed = origins.map((origin) => origin.toLowerCase().replace(/\/$/, ''));
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalized = origin.toLowerCase().replace(/\/$/, '');
      return callback(null, allowed.includes(normalized));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  };
}

function createApp({ config, logger, jobController, systemController }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    helmet({
      // This is a JSON/streaming API, not an HTML app.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  const corsOptions = resolveCorsOptions(config);
  app.use(
    cors({
      ...corsOptions,
      exposedHeaders: ['Content-Disposition', 'Content-Length', 'Accept-Ranges', 'x-request-id'],
    }),
  );
  app.use(createRequestIdMiddleware());
  app.use(createRequestLogger({ logger }));
  // JSON endpoints only; multipart uploads are streamed by the upload service.
  app.use(express.json({ limit: config.jsonBodyLimit }));

  app.get('/health', systemController.health);
  app.use('/api/v1/system', createSystemRouter({ controller: systemController }));
  app.use('/api/v1', createJobRouter({ controller: jobController }));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger }));

  return app;
}

module.exports = { createApp, resolveCorsOptions };
