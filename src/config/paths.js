'use strict';

/**
 * Filesystem layout helpers.
 *
 * All paths used by the service are derived here from the validated config, and
 * every path built from a job id is validated so a malformed id can never escape
 * the configured directories.
 *
 * The default output directory is also the one runtime-adjustable value in this
 * module: `PUT /api/v1/system/output-dir` moves it, so `paths.outputDir` is
 * exposed as a getter and can only be changed through `setDefaultOutputDir()`.
 *
 * There is no output-directory allowlist: this API is deployed on a trusted
 * machine, so any destination the caller asks for is honoured (owner decision,
 * supersedes the earlier `OUTPUT_DIR_ALLOWLIST` requirement in AGENTS.md §25).
 * Path validation is limited to what protects the server itself — job ids stay
 * single safe segments and every directory is resolved to an absolute path.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { errors } = require('../utils/errors');

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Throws unless `jobId` is a safe, single path segment. */
function assertSafeJobId(jobId) {
  if (
    typeof jobId !== 'string' ||
    !SAFE_JOB_ID.test(jobId) ||
    jobId === '.' ||
    jobId === '..'
  ) {
    throw errors.validation('Invalid job id.', { jobId: typeof jobId === 'string' ? jobId : null });
  }
  return jobId;
}

/** True when `child` is inside `parent` (after resolution). */
function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** True when both paths point at the same location (Windows paths are case-insensitive). */
function isSamePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function createPaths(config) {
  const projectRoot = config.projectRoot;
  const dataDir = config.dataDir;
  const logsDir = config.logsDir;
  const tempDir = config.tempDir;
  const dbFile = config.dbFile;
  // `OUTPUT_DIR`: the immutable, configured default (used to reset the runtime one).
  const configuredOutputDir = config.outputDir;

  // Runtime-adjustable default directory for jobs that do not carry their own
  // `output_dir`.
  let defaultOutputDir = configuredOutputDir;

  /** Resolves any accepted directory value to an absolute path. */
  function asDirectory(dir) {
    if (typeof dir === 'string' && dir.trim()) return path.resolve(dir.trim());
    return defaultOutputDir;
  }

  /**
   * Moves the runtime default output directory. Used by the settings service,
   * which is the only writer. Any usable path is accepted.
   */
  function setDefaultOutputDir(dir) {
    defaultOutputDir =
      dir && String(dir).trim() ? path.resolve(String(dir).trim()) : configuredOutputDir;
    return defaultOutputDir;
  }

  /** The current default output directory (configured `OUTPUT_DIR` unless changed). */
  function currentOutputDir() {
    return defaultOutputDir;
  }

  /**
   * Resolves a client-provided output directory (AGENTS.md §25).
   *
   *  - empty/absent        -> the current default output directory,
   *  - relative            -> resolved under `baseDir` (the default output dir),
   *  - absolute            -> used as-is.
   *
   * Every destination is accepted; missing directories are created on demand by
   * `ensureOutputDir()`.
   */
  function resolveOutputDir(value, { baseDir } = {}) {
    if (value === undefined || value === null) return defaultOutputDir;
    let raw = String(value).trim();
    if (!raw) return defaultOutputDir;
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1).trim();
    }
    if (!raw) return defaultOutputDir;

    const base = baseDir ? path.resolve(baseDir) : path.resolve(defaultOutputDir);
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
  }

  /**
   * The directory a job renders into. Falls back to the default when the stored
   * value is missing (rows created before per-job output directories existed).
   */
  function outputDirFor(job) {
    const stored = job?.output_dir;
    if (typeof stored === 'string' && stored.trim()) return path.resolve(stored.trim());
    return defaultOutputDir;
  }

  function jobTempDir(jobId) {
    assertSafeJobId(jobId);
    const dir = path.join(tempDir, jobId);
    if (!isInside(tempDir, dir)) {
      throw errors.validation('Invalid job id.');
    }
    return dir;
  }

  function jobInputPath(jobId, extension) {
    return path.join(jobTempDir(jobId), `input${extension}`);
  }

  /**
   * Renders are written here first and only renamed to their final name once
   * ffmpeg exited successfully (see the render worker).
   */
  function tempOutputPath(jobId, extension = '.mp4', dir = defaultOutputDir) {
    assertSafeJobId(jobId);
    return path.join(asDirectory(dir), `.${jobId}.rendering${extension}`);
  }

  function outputPath(filename, dir = defaultOutputDir) {
    const targetDir = dir || defaultOutputDir;
    const target = path.join(targetDir, filename);
    if (!isInside(targetDir, target)) {
      throw errors.validation('Invalid output filename.');
    }
    return target;
  }

  function ensureDirSync(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Creates an output directory, e.g. a per-job subdirectory. */
  async function ensureOutputDir(dir) {
    const target = asDirectory(dir);
    await ensureDir(target);
    return target;
  }

  /** Creates TEMP_DIR, the output directory, DATA_DIR and LOGS_DIR when missing. */
  async function ensureRuntimeDirs() {
    const created = [];
    const targets = new Set([tempDir, defaultOutputDir, dataDir, logsDir]);
    for (const dir of targets) {
      if (!dir) continue;
      const existed = fs.existsSync(dir);
      await ensureDir(dir);
      if (!existed) created.push(dir);
    }
    return created;
  }

  /**
   * Replaces the runtime directories inside a message, so an error that reaches a
   * client never reveals where the server keeps its files.
   */
  function redact(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    let output = text;
    const replacements = [
      [tempDir, '<temp>'],
      [defaultOutputDir, '<output>'],
      [configuredOutputDir, '<output>'],
      [dataDir, '<data>'],
    ];
    for (const [dir, label] of replacements) {
      if (!dir) continue;
      for (const variant of new Set([dir, dir.replace(/\\/g, '/'), dir.replace(/\//g, '\\')])) {
        output = output.split(variant).join(label);
      }
    }
    return output;
  }

  return {
    projectRoot,
    dataDir,
    logsDir,
    tempDir,
    /** The current default output directory (runtime-adjustable). */
    get outputDir() {
      return defaultOutputDir;
    },
    /** The immutable `OUTPUT_DIR` from the environment. */
    configuredOutputDir,
    dbFile,
    jobTempDir,
    jobInputPath,
    tempOutputPath,
    outputPath,
    resolveOutputDir,
    outputDirFor,
    currentOutputDir,
    setDefaultOutputDir,
    isSamePath,
    redact,
    ensureDir,
    ensureOutputDir,
    ensureDirSync,
    ensureRuntimeDirs,
    isInside,
    assertSafeJobId,
  };
}

module.exports = { createPaths, assertSafeJobId, isInside, isSamePath, SAFE_JOB_ID };
