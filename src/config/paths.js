'use strict';

/**
 * Filesystem layout helpers.
 *
 * All paths used by the service are derived here from the validated config, and
 * every path built from a job id is validated so a malformed id can never escape
 * the configured directories.
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

function createPaths(config) {
  const projectRoot = config.projectRoot;
  const dataDir = config.dataDir;
  const logsDir = config.logsDir;
  const tempDir = config.tempDir;
  const outputDir = config.outputDir;
  const dbFile = config.dbFile;

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
  function tempOutputPath(jobId, extension = '.mp4') {
    assertSafeJobId(jobId);
    return path.join(outputDir, `.${jobId}.rendering${extension}`);
  }

  function outputPath(filename) {
    const target = path.join(outputDir, filename);
    if (!isInside(outputDir, target)) {
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

  /** Creates TEMP_DIR, OUTPUT_DIR, DATA_DIR and LOGS_DIR when missing. */
  async function ensureRuntimeDirs() {
    const created = [];
    for (const dir of [tempDir, outputDir, dataDir, logsDir]) {
      const existed = fs.existsSync(dir);
      await ensureDir(dir);
      if (!existed) created.push(dir);
    }
    return created;
  }

  /**
   * Replaces the configured runtime directories inside a message, so an error
   * that reaches a client never reveals where the server keeps its files.
   */
  function redact(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    let output = text;
    for (const [dir, label] of [
      [tempDir, '<temp>'],
      [outputDir, '<output>'],
      [dataDir, '<data>'],
    ]) {
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
    outputDir,
    dbFile,
    jobTempDir,
    jobInputPath,
    tempOutputPath,
    outputPath,
    redact,
    ensureDir,
    ensureDirSync,
    ensureRuntimeDirs,
    isInside,
    assertSafeJobId,
  };
}

module.exports = { createPaths, assertSafeJobId, isInside, SAFE_JOB_ID };
