'use strict';

/**
 * Composition root.
 *
 * Builds every singleton exactly once (database, repository, services, queue,
 * worker, controllers, express app) and wires them together. Nothing else in the
 * codebase instantiates a service, which keeps the dependency graph explicit and
 * makes the whole runtime configurable for tests.
 */

const { createLogger } = require('./utils/logger');
const { runCommand, spawnProcess, terminateProcessTree, killAllProcesses } = require('./utils/process');
const { createPaths } = require('./config/paths');
const { createDatabase } = require('./database/database');
const { runMigrations } = require('./database/migrations');
const { createJobRepository } = require('./database/repositories/job.repository');
const { createRendererService } = require('./services/renderer.service');
const { createProbeService } = require('./services/probe.service');
const { createRenderService } = require('./services/render.service');
const { createUploadService } = require('./services/upload.service');
const { createCleanupService } = require('./services/cleanup.service');
const { createJobService } = require('./services/job.service');
const { createRenderWorker } = require('./workers/render.worker');
const { createRenderQueue } = require('./queue/render.queue');
const { createJobController } = require('./controllers/job.controller');
const { createSystemController } = require('./controllers/system.controller');
const { createApp } = require('./app');
const { JOB_STATUS } = require('./domain/job-status');

/** How many consecutive runner failures a job may accumulate before it fails. */
const QUEUE_FAILURE_LIMIT = 3;

function createContainer(config, options = {}) {
  const ownsLogger = !options.logger;
  const logger =
    options.logger ||
    createLogger({
      level: config.logLevel,
      toFile: config.logToFile,
      logsDir: config.logsDir,
      name: config.serviceName,
    });

  const paths = createPaths(config);
  paths.ensureDirSync(paths.dataDir);
  if (config.logToFile) paths.ensureDirSync(paths.logsDir);

  const database = createDatabase({ file: config.dbFile, logger });
  runMigrations(database, logger);
  const repository = createJobRepository({ database });

  const rendererService = createRendererService({
    config,
    logger: logger.child('renderer'),
    runCommand,
  });
  const probeService = createProbeService({
    config,
    paths,
    logger: logger.child('probe'),
    runCommand,
  });
  const renderService = createRenderService({ config, logger, terminateProcessTree });
  const cleanupService = createCleanupService({
    config,
    paths,
    repository,
    renderService,
    logger: logger.child('cleanup'),
  });
  const uploadService = createUploadService({ config, paths, logger: logger.child('upload') });

  const worker = createRenderWorker({
    config,
    paths,
    repository,
    probeService,
    renderService,
    rendererService,
    cleanupService,
    logger: logger.child('worker'),
    spawn: options.spawn || spawnProcess,
  });

  const queue = createRenderQueue({
    concurrency: config.queueConcurrency,
    runner: (jobId) => worker.run(jobId),
    logger: logger.child('queue'),
    loadQueuedJobIds: () => repository.findQueuedIds(),
    isRunnerAvailable: () => rendererService.isAvailable(),
    ensureRunnerAvailable: () => rendererService.ensureAvailable(),
    reconcileIntervalMs: config.reconcileIntervalMs,
    onRunnerError: (jobId, error, { attempts = 1 } = {}) => {
      // Safety net: a runner that throws must never leave a job "processing",
      // and a job that keeps failing to start must not be retried forever.
      const fromStatuses = [JOB_STATUS.PROBING, JOB_STATUS.PROCESSING, JOB_STATUS.CANCEL_REQUESTED];
      const giveUp = attempts >= QUEUE_FAILURE_LIMIT;
      if (giveUp) fromStatuses.push(JOB_STATUS.QUEUED);
      try {
        repository.transition(jobId, fromStatuses, JOB_STATUS.FAILED, {
          completed_at: new Date().toISOString(),
          pid: null,
          error_code: 'INTERNAL_ERROR',
          error_message: (giveUp
            ? `Queue runner failed ${attempts} times, giving up: ${error.message}`
            : `Queue runner failed: ${error.message}`
          ).slice(0, 500),
        });
      } catch (transitionError) {
        logger.error(`could not mark job ${jobId} as failed: ${transitionError.message}`);
      }
    },
  });

  const jobService = createJobService({
    config,
    paths,
    repository,
    queue,
    renderService,
    probeService,
    cleanupService,
    uploadService,
    logger: logger.child('job'),
  });

  const jobController = createJobController({ jobService, uploadService, rendererService });
  const systemController = createSystemController({
    config,
    repository,
    queue,
    renderService,
    rendererService,
    startedAt: Date.now(),
  });

  const app = createApp({
    config,
    logger: logger.child('http'),
    jobController,
    systemController,
  });

  function dispose() {
    cleanupService.stop();
    queue.stopReconcile();
    try {
      database.close();
    } catch (error) {
      logger.warn(`database close failed: ${error.message}`);
    }
  }

  return {
    app,
    cleanupService,
    config,
    database,
    jobService,
    logger,
    ownsLogger,
    paths,
    probeService,
    queue,
    renderService,
    rendererService,
    repository,
    uploadService,
    worker,
    dispose,
    killAllProcesses: (opts) => killAllProcesses({ logger, ...opts }),
  };
}

module.exports = { createContainer };
