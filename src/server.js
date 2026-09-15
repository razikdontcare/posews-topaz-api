'use strict';

/**
 * Entry point (PM2 runs this file: `script: './src/server.js'`).
 *
 * Boot order: logger -> container (database + services) -> startup validation &
 * recovery -> HTTP listener -> signal handlers.
 */

const http = require('node:http');
const { config } = require('./config/env');
const { createLogger } = require('./utils/logger');
const { createContainer } = require('./container');
const startup = require('./startup');

async function main() {
  const logger = createLogger({
    level: config.logLevel,
    toFile: config.logToFile,
    logsDir: config.logsDir,
    name: config.serviceName,
  });

  logger.info(
    `${config.serviceName} starting (node ${process.version}, env=${config.nodeEnv}, port=${config.port})`,
  );
  logger.info(`renderer: ffmpeg=${config.ffmpegPath} ffprobe=${config.ffprobePath}`);
  logger.info(`paths: temp=${config.tempDir} output=${config.outputDir} db=${config.dbFile}`);

  let container;
  try {
    container = createContainer(config, { logger });
  } catch (error) {
    logger.error(`startup failed: ${error.stack || error.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    await startup.initialize({ container, config, logger });
  } catch (error) {
    logger.error(`initialization failed: ${error.message}`);
    container.dispose();
    await logger.close();
    process.exitCode = 1;
    return;
  }

  const server = http.createServer(container.app);
  // Long uploads/renders: no request timeout by default (see HTTP_REQUEST_TIMEOUT_MS).
  server.requestTimeout = config.httpRequestTimeoutMs;
  server.headersTimeout = config.httpHeadersTimeoutMs;
  server.keepAliveTimeout = config.httpKeepAliveTimeoutMs;

  server.on('clientError', (error, socket) => {
    logger.debug(`client error: ${error.message}`);
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) {
    logger.error(`could not listen on ${config.host}:${config.port}: ${error.message}`);
    container.dispose();
    await logger.close();
    process.exitCode = 1;
    return;
  }

  logger.info(`listening on http://${config.host}:${config.port} (health: /health)`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);

    const hardExit = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs + 15000);
    hardExit.unref();

    try {
      // 1. Stop accepting new connections. This is deliberately *not* awaited
      //    before shutting the renderer down: one slow download must never keep
      //    ffmpeg alive past the graceful shutdown budget.
      const httpClosed = new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
      const forceClose = setTimeout(() => {
        logger.warn('closing remaining http connections');
        server.closeAllConnections?.();
      }, Math.max(2000, Math.min(config.shutdownTimeoutMs, 10000)));
      forceClose.unref?.();

      // 2. Stop the queue and the renderer, persist state, close SQLite.
      await startup.shutdown({ container, config, logger, signal });

      // 3. Give in-flight requests a bounded moment, then force the rest.
      await Promise.race([httpClosed, new Promise((resolve) => setTimeout(resolve, 3000))]);
      clearTimeout(forceClose);
      server.closeAllConnections?.();
      await httpClosed;
      logger.info('http server closed');
    } catch (error) {
      logger.error(`shutdown error: ${error.stack || error.message}`);
    } finally {
      clearTimeout(hardExit);
      container.dispose();
      await logger.close();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK')); // Windows Ctrl+Break
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandled promise rejection: ${reason?.stack || String(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`uncaught exception: ${error.stack || error.message}`);
    void shutdown('uncaughtException');
  });
}

main().catch((error) => {
  process.stderr.write(`fatal startup error: ${error?.stack || error}\n`);
  process.exit(1);
});
