'use strict';

/**
 * Environment configuration.
 *
 * Every tunable value of the service is resolved here, once, at require time.
 * No other module reads `process.env` directly so that the whole runtime can be
 * reconfigured (and unit tested) through a single object.
 */

const path = require('node:path');
const dotenv = require('dotenv');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// `.env` is optional: PM2 ecosystem files or the OS environment may provide the values.
dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

const DEFAULTS = Object.freeze({
  port: 3000,
  tempDir: 'D:\\VideoTemp',
  outputDir: 'D:\\Hasil Render',
  ffmpegPath: 'C:\\Program Files\\Topaz Labs LLC\\Topaz Video AI\\ffmpeg.exe',
  ffprobePath: 'C:\\Program Files\\Topaz Labs LLC\\Topaz Video AI\\ffprobe.exe',
  maxUploadSizeBytes: 53687091200, // 50 GiB
  queueConcurrency: 1,
  jobRetentionHours: 72,
  failedJobRetentionHours: 24,
  tempStaleHours: 24,
  minDimension: 16,
  maxDimension: 7680,
  probeTimeoutMs: 60000,
  progressPersistIntervalMs: 500,
  cleanupIntervalMs: 1800000, // 30 minutes
  reconcileIntervalMs: 30000,
  rendererCheckTimeoutMs: 30000,
  rendererSelftestTimeoutMs: 60000,
  rendererProbeTimeoutMs: 180000,
  rendererRecheckCooldownMs: 60000,
  shutdownTimeoutMs: 15000,
  killGraceMs: 5000,
  stderrTailBytes: 16384,
  maxStderrSummaryLength: 1000,
  allowedExtensions: ['mp4', 'mkv', 'mov', 'webm', 'm4v', 'avi', 'mpg', 'mpeg', 'ts', 'm2ts'],
});

class ConfigError extends Error {
  constructor(message) {
    super(`Invalid configuration: ${message}`);
    this.name = 'ConfigError';
    this.code = 'CONFIG_ERROR';
  }
}

/**
 * Normalizes a path coming from env/`.env`. Windows drives are normalized with
 * win32 semantics so `D:\Hasil Render` keeps its native separators.
 */
function normalizePathInput(value, fallback) {
  let raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) raw = fallback;
  if (!raw) return '';
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  if (path.win32.isAbsolute(raw)) return path.win32.normalize(raw);
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(PROJECT_ROOT, raw);
}

function readString(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).trim();
}

function readPath(name, fallback) {
  return normalizePathInput(process.env[name], fallback);
}

function readInt(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = readString(name, null);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer (received "${raw}")`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max} (received ${value})`);
  }
  return value;
}

function readBool(name, fallback) {
  const raw = readString(name, null);
  if (raw === null) return fallback;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean (received "${raw}")`);
}

function readEnum(name, fallback, allowed) {
  const raw = readString(name, fallback);
  const value = String(raw).toLowerCase();
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')} (received "${raw}")`);
  }
  return value;
}

function readList(name, fallback) {
  const raw = readString(name, null);
  if (raw === null) return fallback.slice();
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildConfig() {
  const warnings = [];
  const nodeEnv = readEnum('NODE_ENV', 'development', ['development', 'production', 'test']);

  const configuredConcurrency = readInt('QUEUE_CONCURRENCY', DEFAULTS.queueConcurrency, {
    min: 1,
    max: 64,
  });
  // A single Topaz/GPU renderer is a hard architectural guarantee of this service.
  const queueConcurrency = 1;
  if (configuredConcurrency !== 1) {
    warnings.push(
      `QUEUE_CONCURRENCY=${configuredConcurrency} is not supported; forcing 1 because the Topaz ` +
        'Video AI renderer owns the GPU exclusively.',
    );
  }

  const minDimension = readInt('MIN_DIMENSION', DEFAULTS.minDimension, { min: 16, max: 16384 });
  const maxDimension = readInt('MAX_DIMENSION', DEFAULTS.maxDimension, { min: 16, max: 32768 });
  if (maxDimension < minDimension) {
    throw new ConfigError(
      `MAX_DIMENSION (${maxDimension}) must be >= MIN_DIMENSION (${minDimension})`,
    );
  }

  const dataDir = readPath('DATA_DIR', path.join(PROJECT_ROOT, 'data'));
  const logsDir = readPath('LOGS_DIR', path.join(PROJECT_ROOT, 'logs'));

  // Per-job render tuning (the `POST /api/v1/jobs` options below).
  const topazModel = readString('TOPAZ_MODEL', 'prob-3').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(topazModel)) {
    throw new ConfigError(`TOPAZ_MODEL is not a valid model name (received "${topazModel}")`);
  }
  const allowedModels = [topazModel];
  for (const model of readList('ALLOWED_MODELS', ['prob-3', 'prob-4'])) {
    const normalized = model.toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(normalized)) {
      throw new ConfigError(`ALLOWED_MODELS contains an invalid model name ("${model}")`);
    }
    if (!allowedModels.includes(normalized)) allowedModels.push(normalized);
  }

  const config = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    serviceName: 'video-upscaler-api',

    port: readInt('PORT', DEFAULTS.port, { min: 1, max: 65535 }),
    host: readString('HOST', '0.0.0.0'),

    // Filesystem layout
    projectRoot: PROJECT_ROOT,
    dataDir,
    logsDir,
    dbFile: readPath('DB_FILE', path.join(dataDir, 'jobs.sqlite')),
    tempDir: readPath('TEMP_DIR', DEFAULTS.tempDir),
    outputDir: readPath('OUTPUT_DIR', DEFAULTS.outputDir),

    // Topaz Video AI binaries (never the system ffmpeg)
    ffmpegPath: readPath('FFMPEG_PATH', DEFAULTS.ffmpegPath),
    ffprobePath: readPath('FFPROBE_PATH', DEFAULTS.ffprobePath),

    // Upload handling
    maxUploadSizeBytes: readInt('MAX_UPLOAD_SIZE_BYTES', DEFAULTS.maxUploadSizeBytes, { min: 1024 }),
    allowedExtensions: new Set(
      readList('ALLOWED_VIDEO_EXTENSIONS', DEFAULTS.allowedExtensions).map((ext) =>
        ext.replace(/^\./, '').toLowerCase(),
      ),
    ),

    // Renderer / queue
    queueConcurrency,
    topazModel,
    allowedModels: Object.freeze(allowedModels),
    // `false` accepts only video/width/height — the strict baseline command.
    allowRenderTuning: readBool('ALLOW_RENDER_TUNING', true),
    maxGpuIndex: readInt('MAX_GPU_INDEX', 0, { min: 0, max: 15 }),
    // Process name used to verify that a pid from a crashed run still belongs to
    // the renderer before it is force-killed (guards against Windows pid reuse).
    rendererProcessName: readString('RENDERER_PROCESS_NAME', 'ffmpeg'),
    singleInstance: readBool('SINGLE_INSTANCE', true),
    audioMode: readEnum('AUDIO_MODE', 'auto', ['auto', 'copy', 'reencode']),
    progressPersistIntervalMs: readInt(
      'PROGRESS_PERSIST_INTERVAL_MS',
      DEFAULTS.progressPersistIntervalMs,
      { min: 100, max: 60000 },
    ),
    reconcileIntervalMs: readInt('RECONCILE_INTERVAL_MS', DEFAULTS.reconcileIntervalMs, { min: 1000 }),
    ffmpegStderrTailBytes: readInt('FFMPEG_STDERR_TAIL_BYTES', DEFAULTS.stderrTailBytes, {
      min: 1024,
      max: 1048576,
    }),
    maxStderrSummaryLength: readInt('MAX_STDERR_SUMMARY_LENGTH', DEFAULTS.maxStderrSummaryLength, {
      min: 100,
      max: 8000,
    }),

    // Dimensions accepted by the API
    minDimension,
    maxDimension,
    enforceEvenDimensions: readBool('ENFORCE_EVEN_DIMENSIONS', true),

    // Probing
    probeTimeoutMs: readInt('PROBE_TIMEOUT_MS', DEFAULTS.probeTimeoutMs, { min: 1000 }),

    // Retention / cleanup
    jobRetentionHours: readInt('JOB_RETENTION_HOURS', DEFAULTS.jobRetentionHours, { min: 1 }),
    failedJobRetentionHours: readInt(
      'FAILED_JOB_RETENTION_HOURS',
      DEFAULTS.failedJobRetentionHours,
      { min: 1 },
    ),
    tempStaleHours: readInt('TEMP_STALE_HOURS', DEFAULTS.tempStaleHours, { min: 1 }),
    cleanupIntervalMs: readInt('CLEANUP_INTERVAL_MS', DEFAULTS.cleanupIntervalMs, { min: 1000 }),

    // Startup validation
    requireNvenc: readBool('REQUIRE_NVENC', true),
    rendererSelftest: readBool('RENDERER_SELFTEST', true),
    rendererModelSelftest: readBool('RENDERER_MODEL_SELFTEST', true),
    rendererCheckTimeoutMs: readInt('RENDERER_CHECK_TIMEOUT_MS', DEFAULTS.rendererCheckTimeoutMs, {
      min: 1000,
    }),
    rendererSelftestTimeoutMs: readInt(
      'RENDERER_SELFTEST_TIMEOUT_MS',
      DEFAULTS.rendererSelftestTimeoutMs,
      { min: 1000 },
    ),
    // The end-to-end probe is a real render (model load + a second of video), so it
    // gets its own, much larger budget.
    rendererProbeTimeoutMs: readInt('RENDERER_PROBE_TIMEOUT_MS', DEFAULTS.rendererProbeTimeoutMs, {
      min: 1000,
    }),
    rendererRecheckCooldownMs: readInt(
      'RENDERER_RECHECK_COOLDOWN_MS',
      DEFAULTS.rendererRecheckCooldownMs,
      { min: 1000 },
    ),
    allowDegradedStart: readBool('ALLOW_DEGRADED_START', false),

    // Lifecycle
    shutdownPolicy: readEnum('SHUTDOWN_POLICY', 'terminate', ['terminate', 'wait']),
    shutdownTimeoutMs: readInt('SHUTDOWN_TIMEOUT_MS', DEFAULTS.shutdownTimeoutMs, { min: 1000 }),
    killGraceMs: readInt('KILL_GRACE_MS', DEFAULTS.killGraceMs, { min: 500 }),

    // HTTP
    corsOrigins: readList('CORS_ORIGIN', ['*']),
    jsonBodyLimit: readString('JSON_BODY_LIMIT', '100kb'),
    // Uploads of tens of gigabytes can take hours: Node's default 300s request
    // timeout would cut them off, so it is disabled by default (0).
    httpRequestTimeoutMs: readInt('HTTP_REQUEST_TIMEOUT_MS', 0, { min: 0 }),
    httpKeepAliveTimeoutMs: readInt('HTTP_KEEP_ALIVE_TIMEOUT_MS', 65000, { min: 1000 }),
    httpHeadersTimeoutMs: readInt('HTTP_HEADERS_TIMEOUT_MS', 66000, { min: 1000 }),

    // Logging
    logLevel: readEnum('LOG_LEVEL', 'info', ['error', 'warn', 'info', 'debug']),
    logToFile: readBool('LOG_TO_FILE', nodeEnv === 'production'),
  };

  return { config, warnings };
}

const { config, warnings } = buildConfig();
config.warnings = Object.freeze(warnings);

/**
 * Builds a config object for tests/tools: the environment values are used as a
 * base and `overrides` replace them (paths are re-normalized).
 */
function createConfig(overrides = {}) {
  const base = buildConfig().config;
  const merged = { ...base, ...overrides };

  for (const key of ['tempDir', 'outputDir', 'dataDir', 'logsDir', 'dbFile', 'ffmpegPath', 'ffprobePath']) {
    if (overrides[key] !== undefined) merged[key] = normalizePathInput(overrides[key], base[key]);
  }
  if (overrides.dataDir !== undefined && overrides.dbFile === undefined) {
    merged.dbFile = path.join(merged.dataDir, 'jobs.sqlite');
  }
  if (overrides.allowedExtensions !== undefined && !(overrides.allowedExtensions instanceof Set)) {
    merged.allowedExtensions = new Set(
      overrides.allowedExtensions.map((ext) => String(ext).replace(/^\./, '').toLowerCase()),
    );
  }
  if (Array.isArray(overrides.allowedModels)) {
    merged.allowedModels = Object.freeze([
      ...new Set([
        String(merged.topazModel).toLowerCase(),
        ...overrides.allowedModels.map((model) => String(model).toLowerCase()),
      ]),
    ]);
  }
  if (overrides.warnings === undefined) merged.warnings = base.warnings;
  return Object.freeze(merged);
}

module.exports = {
  ConfigError,
  DEFAULTS,
  buildConfig,
  config: Object.freeze(config),
  createConfig,
  normalizePathInput,
};
