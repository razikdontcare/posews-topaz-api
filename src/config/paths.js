'use strict';

/**
 * Filesystem layout helpers.
 *
 * All paths used by the service are derived here from the validated config, and
 * every path built from a job id is validated so a malformed id can never escape
 * the configured directories.
 *
 * The default output directory is also the one runtime-adjustable value in this
 * module: `PUT /api/v1/system/output-dir` moves it (still restricted to
 * `allowedOutputRoots`), so `paths.outputDir` is exposed as a getter and can only
 * be changed through `setDefaultOutputDir()`.
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
  const allowedOutputRoots =
    Array.isArray(config.allowedOutputRoots) && config.allowedOutputRoots.length > 0
      ? config.allowedOutputRoots.slice()
      : [configuredOutputDir];

  // Runtime-adjustable default directory for jobs that do not carry their own
  // `output_dir`. Always inside `allowedOutputRoots`.
  let defaultOutputDir = configuredOutputDir;

  /** True when `dir` is one of the configured output roots or lives inside one. */
  function isAllowedOutputDir(dir) {
    if (typeof dir !== 'string' || dir.trim() === '') return false;
    const resolved = path.resolve(dir);
    return allowedOutputRoots.some((root) => isSamePath(root, resolved) || isInside(root, resolved));
  }

  /**
   * Moves the runtime default output directory. Used by the settings service,
   * which is the only writer; the target must still be an allowed root.
   */
  function setDefaultOutputDir(dir) {
    const target = dir || configuredOutputDir;
    if (!isAllowedOutputDir(target)) {
      throw errors.validation(
        'The output directory must point into one of the directories this server is allowed to ' +
          'write renders to.',
        { field: 'outputDir' },
      );
    }
    defaultOutputDir = target;
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
   * Whatever the input, the result must live inside one of `OUTPUT_DIR_ALLOWLIST`
   * (which always includes the default output dir), so a request can never choose
   * an arbitrary location on disk.
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
    const candidate = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
    if (!isAllowedOutputDir(candidate)) {
      throw errors.validation(
        '"outputDir" must point into one of the directories this server is allowed to write renders to.',
        { field: 'outputDir' },
      );
    }
    return candidate;
  }

  /**
   * The directory a job renders into. Falls back to the default when the stored
   * value is missing (legacy rows) or no longer inside an allowed root (an admin
   * narrowed `OUTPUT_DIR_ALLOWLIST` after the job was created).
   */
  function outputDirFor(job) {
    const stored = job?.output_dir;
    if (typeof stored === 'string' && stored.trim() && isAllowedOutputDir(stored)) {
      return stored;
    }
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
    const targetDir = dir || defaultOutputDir;
    if (!isAllowedOutputDir(targetDir)) {
      throw errors.validation('Invalid output directory.');
    }
    return path.join(targetDir, `.${jobId}.rendering${extension}`);
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

  /** Creates a (validated) output directory, e.g. a per-job subdirectory. */
  async function ensureOutputDir(dir) {
    const target = dir || defaultOutputDir;
    if (!isAllowedOutputDir(target)) {
      throw errors.validation('Invalid output directory.');
    }
    await ensureDir(target);
    return target;
  }

  /** Creates TEMP_DIR, the output roots, DATA_DIR and LOGS_DIR when missing. */
  async function ensureRuntimeDirs() {
    const created = [];
    const targets = new Set([tempDir, defaultOutputDir, dataDir, logsDir, ...allowedOutputRoots]);
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
      [dataDir, '<data>'],
      ...allowedOutputRoots.map((root) => [root, '<output>']),
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
    allowedOutputRoots,
    dbFile,
    jobTempDir,
    jobInputPath,
    tempOutputPath,
    outputPath,
    resolveOutputDir,
    outputDirFor,
    currentOutputDir,
    setDefaultOutputDir,
    isAllowedOutputDir,
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
