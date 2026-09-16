'use strict';

/**
 * Test harness: boots a complete instance of the service (database, services,
 * queue, worker, express app, HTTP server) against a throwaway directory tree and
 * the fake Topaz binaries.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { createConfig } = require('../../src/config/env');
const { createLogger } = require('../../src/utils/logger');
const { createContainer } = require('../../src/container');
const startup = require('../../src/startup');

const FAKE_FFMPEG = path.join(__dirname, 'fixtures', 'fake-ffmpeg.cjs');
const FAKE_FFPROBE = path.join(__dirname, 'fixtures', 'fake-ffprobe.cjs');

/** Environment switches understood by the fake renderer. */
function setRendererEnv(values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function resetRendererEnv() {
  setRendererEnv({
    FAKE_FFMPEG_MODE: 'success',
    FAKE_FFMPEG_DURATION: '10',
    FAKE_FFMPEG_STEPS: '5',
    FAKE_FFMPEG_DELAY_MS: '0',
    FAKE_FFMPEG_OUTPUT_BYTES: '4096',
    FAKE_FFMPEG_FORCE: undefined,
    FAKE_FFMPEG_ARGS_FILE: undefined,
    FAKE_FFPROBE_MODE: 'ok',
    FAKE_FFPROBE_DURATION: '10',
    FAKE_FFPROBE_AUDIO: undefined,
    FAKE_FFPROBE_VIDEO: undefined,
    FAKE_FFPROBE_AUDIO_CODEC: undefined,
    FAKE_FFPROBE_NO_FORMAT_DURATION: undefined,
    FAKE_FFPROBE_NO_STREAM_DURATION: undefined,
  });
}

async function startTestServer(rawOverrides = {}) {
  const {
    skipInitialize = false,
    root: reusedRoot,
    preserveRoot = false,
    logger: loggerOverride,
    rendererEnv,
    ...overrides
  } = rawOverrides;
  resetRendererEnv();
  // Environment for the fake renderer *before* startup validation runs.
  if (rendererEnv) setRendererEnv(rendererEnv);
  const root = reusedRoot || path.join(os.tmpdir(), `vua-test-${randomUUID()}`);
  const dirs = {
    temp: path.join(root, 'temp'),
    output: path.join(root, 'output'),
    data: path.join(root, 'data'),
    logs: path.join(root, 'logs'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const config = createConfig({
    nodeEnv: 'test',
    tempDir: dirs.temp,
    outputDir: dirs.output,
    dataDir: dirs.data,
    logsDir: dirs.logs,
    ffmpegPath: FAKE_FFMPEG,
    ffprobePath: FAKE_FFPROBE,
    rendererSelftest: false,
    rendererModelSelftest: false,
    // The fake renderer runs through node.exe, so that is the process name the
    // recovery pid check must expect.
    rendererProcessName: 'node',
    logToFile: false,
    logLevel: process.env.TEST_LOG_LEVEL || 'error',
    progressPersistIntervalMs: 100,
    reconcileIntervalMs: 60000,
    cleanupIntervalMs: 3600000,
    killGraceMs: 500,
    shutdownTimeoutMs: 5000,
    ...overrides,
  });

  const logger =
    loggerOverride || createLogger({ level: config.logLevel, console: true, toFile: false });
  const container = createContainer(config, { logger });

  let init = null;
  let initialized = false;
  if (!skipInitialize) {
    init = await startup.initialize({ container, config, logger });
    initialized = true;
  }

  const server = http.createServer(container.app);
  server.requestTimeout = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function stop({ graceful = true } = {}) {
    if (graceful && initialized) {
      await startup.shutdown({ container, config, logger, signal: 'test' });
    } else {
      // Simulated abrupt stop: kill the renderer, but let the workers settle so
      // the harness does not race the database close.
      container.cleanupService.stop();
      container.queue.stopReconcile();
      container.renderService.markShuttingDown();
      await container.renderService.stopAll({ graceMs: 500 });
      await container.queue.drain(5000);
    }
    await new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    container.dispose();
    if (!preserveRoot) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows may still hold a handle; the OS temp cleaner will get it */
      }
    }
  }

  function removeRoot() {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* ignore */
    }
  }

  return {
    baseUrl,
    config,
    container,
    dirs,
    init,
    logger,
    port,
    removeRoot,
    root,
    server,
    stop,
    repository: container.repository,
    queue: container.queue,
    renderService: container.renderService,
    rendererService: container.rendererService,
    jobService: container.jobService,
    paths: container.paths,
    async api(pathname, options) {
      const response = await fetch(`${baseUrl}${pathname}`, options);
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body, headers: response.headers };
    },
    /** Polls a job until it reaches one of `statuses` (or the timeout expires). */
    async waitForStatus(jobId, statuses, timeoutMs = 15000) {
      const wanted = Array.isArray(statuses) ? statuses : [statuses];
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = container.repository.findById(jobId);
        if (last && wanted.includes(last.status)) return last;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `job ${jobId} did not reach ${wanted.join('/')} in ${timeoutMs}ms ` +
          `(last status: ${last ? last.status : 'missing'})`,
      );
    },
    /** Polls until a predicate over the job row is satisfied. */
    async waitForJob(jobId, predicate, description = 'condition', timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = container.repository.findById(jobId);
        if (last && predicate(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `job ${jobId} did not satisfy ${description} in ${timeoutMs}ms ` +
          `(last: ${last ? `${last.status} pid=${last.pid}` : 'missing'})`,
      );
    },
  };
}

module.exports = { FAKE_FFMPEG, FAKE_FFPROBE, resetRendererEnv, setRendererEnv, startTestServer };
