'use strict';

/**
 * Windows-safe filename handling.
 *
 * The original upload filename is *metadata only*: it is never used to build a
 * filesystem path. These helpers turn it into a safe basename for the rendered
 * output and make sure an existing file is never overwritten silently.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { AppError, errors } = require('./errors');

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Strips any directory component (`..\..\evil.mp4` -> `evil.mp4`). */
function stripDirectory(name) {
  const value = String(name ?? '');
  if (!value) return '';
  // Handle both separator styles regardless of the host platform.
  const normalized = value.replace(/\//g, '\\');
  const base = path.win32.basename(normalized);
  return base === '.' || base === '..' ? '' : base;
}

function removeExtension(name) {
  const base = String(name ?? '');
  const index = base.lastIndexOf('.');
  if (index <= 0) return base;
  return base.slice(0, index);
}

/** Strips characters/sequences that are invalid on Windows and truncates safely. */
function sanitizeFilename(name, { fallback = 'video', maxLength = 120 } = {}) {
  let base = stripDirectory(name);
  base = base.normalize('NFC').replace(INVALID_FILENAME_CHARS, '_');
  base = base.replace(/\s+/g, ' ').trim();
  base = base.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!base) base = fallback;
  if (WINDOWS_RESERVED_NAMES.has(base.split('.')[0].toUpperCase())) base = `_${base}`;
  if (base.length > maxLength) {
    base = base.slice(0, maxLength).replace(/[.\s]+$/, '');
    if (!base) base = fallback;
  }
  return base;
}

/** Returns a whitelisted, lowercased extension (`.mp4`) or an empty string. */
function sanitizeExtension(extension) {
  const raw = String(extension ?? '').trim().toLowerCase();
  if (!raw) return '';
  const cleaned = raw.startsWith('.') ? raw.slice(1) : raw;
  return /^[a-z0-9]{1,5}$/.test(cleaned) ? `.${cleaned}` : '';
}

/** `prob-3` -> `prob3` (used inside the output filename). */
function modelSlug(model) {
  const slug = String(model ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug || 'model';
}

function insertSuffix(filename, suffix) {
  const extension = path.extname(filename);
  const stem = removeExtension(filename);
  return `${stem}_${suffix}${extension}`;
}

/**
 * `sosul eater rev.mp4` + 3840x1620 -> `sosul eater rev_prob3_3840x1620.mp4`
 * The output container is always the ffmpeg muxer we configure (mp4).
 */
function buildOutputFilename({
  originalFilename,
  width,
  height,
  model = 'prob-3',
  extension = '.mp4',
  maxLength = 180,
}) {
  const suffix = `_${modelSlug(model)}_${width}x${height}`;
  const stem = sanitizeFilename(removeExtension(stripDirectory(originalFilename)), {
    fallback: 'video',
    maxLength: Math.max(16, maxLength - suffix.length - extension.length),
  });
  return `${stem}${suffix}${extension}`;
}

/** `.769337925.rendering.mp4` files live in OUTPUT_DIR while rendering. */
function isRenderingTempFile(filename) {
  return /^\..+\.rendering\.[a-z0-9]+$/i.test(String(filename ?? ''));
}

/**
 * Atomically reserves an unused filename inside `dir` by creating it empty
 * (`wx`). Any collision gets a `_<suffix>-<n>` marker before the extension, so
 * an existing render is never overwritten.
 *
 * The caller is expected to `fs.rename()` over the reserved placeholder (or
 * remove it if the render fails).
 */
async function reserveUniqueOutputPath(dir, filename, { suffix = '', maxAttempts = 50 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidateName =
      attempt === 0 || !suffix ? filename : insertSuffix(filename, `${suffix}-${attempt}`);
    const candidatePath = path.join(dir, candidateName);
    try {
      const handle = await fsp.open(candidatePath, 'wx');
      await handle.close();
      return { filename: candidateName, path: candidatePath };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw errors.filesystem(`Could not reserve output file: ${error.message}`, error);
    }
  }
  throw new AppError(
    'FILESYSTEM_ERROR',
    `Could not find an unused filename for "${filename}" in ${dir}.`,
  );
}

/** Windows can briefly hold a lock on freshly written files; retry a few times. */
async function renameWithRetry(source, destination, { attempts = 5, delayMs = 200 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw errors.filesystem(
    `Could not move "${path.basename(source)}" to "${path.basename(destination)}": ${lastError?.message}`,
    lastError,
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

module.exports = {
  buildOutputFilename,
  formatBytes,
  insertSuffix,
  isRenderingTempFile,
  modelSlug,
  removeExtension,
  renameWithRetry,
  reserveUniqueOutputPath,
  sanitizeExtension,
  sanitizeFilename,
  stripDirectory,
};
