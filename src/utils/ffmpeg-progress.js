'use strict';

/**
 * FFmpeg `-progress pipe:1` parser.
 *
 * FFmpeg emits blocks of `key=value` lines terminated by the `progress` key:
 *
 *   frame=12842
 *   fps=31.4
 *   total_size=...
 *   out_time_us=513000000
 *   out_time_ms=513000
 *   out_time=00:08:33.00
 *   dup_frames=0
 *   drop_frames=0
 *   speed=0.82x
 *   progress=continue
 *
 * Notes on tolerance (the parser must never crash the worker):
 *  - field order is irrelevant, keys may be missing, lines may be CRLF,
 *  - unknown keys (`stream_0_0_q`, `bitrate`, ...) are ignored,
 *  - values that cannot be parsed are skipped so the previous value is kept,
 *  - `out_time_ms` is *microseconds* in real FFmpeg builds (historical naming
 *    quirk) and is only used when `out_time` / `out_time_us` are missing.
 */

const NUMERIC_FIELDS = new Set([
  'frame',
  'fps',
  'total_size',
  'dup_frames',
  'drop_frames',
]);

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.toUpperCase() === 'N/A') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value) {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

/** `00:08:33.00` -> 513 (seconds). */
function parseTimecode(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.toUpperCase() === 'N/A') return null;
  const match = /^(-)?(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(normalized);
  if (match) {
    const sign = match[1] ? -1 : 1;
    const fraction = match[5] ? Number(`0.${match[5]}`) : 0;
    return (
      sign *
      (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]) + fraction)
    );
  }
  // Some builds print plain seconds.
  return toNumber(normalized);
}

function parseSpeed(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.toUpperCase() === 'N/A') return null;
  return normalized;
}

function createProgressState() {
  return {
    frame: null,
    fps: null,
    speed: null,
    speedNumeric: null,
    elapsedSeconds: null,
    outTime: null,
    totalSize: null,
    bitrate: null,
    dupFrames: null,
    dropFrames: null,
    progress: null,
  };
}

class FfmpegProgressParser {
  /**
   * @param {{ onUpdate?: (state: object) => void, maxLineLength?: number, logger?: object }} [options]
   */
  constructor(options = {}) {
    this.onUpdate = options.onUpdate;
    this.maxLineLength = options.maxLineLength ?? 8192;
    this.logger = options.logger ?? null;
    this.state = createProgressState();
    this.buffer = '';
    this.pending = {};
    this.malformedLines = 0;
  }

  /** Feeds raw stdout and returns every completed progress snapshot. */
  push(chunk) {
    if (chunk === null || chunk === undefined) return [];
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    const updates = [];
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const update = this.#consumeLine(line);
      if (update) updates.push(update);
      index = this.buffer.indexOf('\n');
    }

    // Only the leftover *partial* line may be dropped, and only when it is
    // absurdly long: complete lines must never be discarded (a burst of progress
    // blocks arriving in one chunk is normal for a busy pipe).
    if (this.buffer.length > this.maxLineLength) {
      this.buffer = '';
      this.malformedLines += 1;
    }
    return updates;
  }

  /** Snapshot of the last completed progress block. */
  snapshot() {
    return { ...this.state };
  }

  #consumeLine(rawLine) {
    const line = String(rawLine).replace(/\r$/, '').trim();
    if (!line || !line.includes('=')) return null;

    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) return null;

    const parsed = parseEntry(key, value);
    if (!parsed) {
      if (!isKnownIgnoredKey(key)) this.malformedLines += 1;
      return null;
    }

    Object.assign(this.pending, parsed.fields);

    if (key === 'progress') {
      const merged = { ...this.state, ...this.pending };
      merged.elapsedSeconds = resolveElapsedSeconds(this.pending, this.state);
      // Internal (microsecond) helpers must not leak into the public snapshot.
      delete merged._outTimeUs;
      delete merged._outTimeMs;
      this.pending = {};
      this.state = merged;
      const snapshot = { ...merged };
      try {
        this.onUpdate?.(snapshot);
      } catch (error) {
        this.logger?.warn('progress listener failed:', error.message);
      }
      return snapshot;
    }
    return null;
  }
}

function isKnownIgnoredKey(key) {
  return (
    NUMERIC_FIELDS.has(key) ||
    key === 'bitrate' ||
    key === 'stream_0_0_q' ||
    key.startsWith('stream_') ||
    key === 'out_time' ||
    key === 'out_time_us' ||
    key === 'out_time_ms'
  );
}

/**
 * Maps one `key=value` pair onto progress fields; returns null when unusable.
 * @returns {{ fields: Record<string, unknown> } | null}
 */
function parseEntry(key, value) {
  switch (key) {
    case 'frame':
      return { fields: { frame: toInteger(value) } };
    case 'fps': {
      const fps = toNumber(value);
      return fps === null ? null : { fields: { fps: Number(fps.toFixed(3)) } };
    }
    case 'speed': {
      const speed = parseSpeed(value);
      if (speed === null) return null;
      return { fields: { speed, speedNumeric: toNumber(speed.replace(/x$/i, '')) } };
    }
    case 'total_size':
      return { fields: { totalSize: toInteger(value) } };
    case 'bitrate': {
      const normalized = String(value).trim();
      return normalized && normalized.toUpperCase() !== 'N/A'
        ? { fields: { bitrate: normalized } }
        : null;
    }
    case 'out_time': {
      const seconds = parseTimecode(value);
      return seconds === null ? null : { fields: { outTime: seconds } };
    }
    case 'out_time_us': {
      const microseconds = toNumber(value);
      return microseconds === null ? null : { fields: { _outTimeUs: microseconds / 1e6 } };
    }
    case 'out_time_ms': {
      // Historically printed in microseconds by ffmpeg; only used as a fallback.
      const microseconds = toNumber(value);
      return microseconds === null ? null : { fields: { _outTimeMs: microseconds / 1e6 } };
    }
    case 'dup_frames':
      return { fields: { dupFrames: toInteger(value) } };
    case 'drop_frames':
      return { fields: { dropFrames: toInteger(value) } };
    case 'progress': {
      const normalized = String(value).trim().toLowerCase();
      return normalized === 'continue' || normalized === 'end'
        ? { fields: { progress: normalized } }
        : null;
    }
    default:
      return null;
  }
}

/** `out_time` wins, then `out_time_us`, then `out_time_ms` (microseconds). */
function resolveElapsedSeconds(pending, previousState) {
  const candidates = [pending.outTime, pending._outTimeUs, pending._outTimeMs];
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return previousState?.elapsedSeconds ?? null;
}

/** Clamped 0..100 percentage, or null when it cannot be computed yet. */
function computeProgressPercent(elapsedSeconds, durationSeconds) {
  if (
    !Number.isFinite(elapsedSeconds) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null;
  }
  const percent = (elapsedSeconds / durationSeconds) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100;
}

module.exports = {
  FfmpegProgressParser,
  computeProgressPercent,
  createProgressState,
  parseTimecode,
  resolveElapsedSeconds,
};
