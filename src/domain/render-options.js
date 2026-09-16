'use strict';

/**
 * Per-job render options.
 *
 * The API only ever accepts **named, whitelisted** options — never an ffmpeg
 * argument or a filter string (AGENTS.md §11/§12). Every option defaults to the
 * frozen Topaz baseline, so a request without options behaves exactly like the
 * documented baseline command.
 *
 * This module is the single source of truth for
 *  - the accepted multipart field names (`RENDER_OPTION_FIELDS`),
 *  - strict validation of API input (`parseRenderOptions`),
 *  - lenient normalization of stored values (`normalizeRenderOptions`),
 *  - the machine-readable option description exposed by `/api/v1/system/status`
 *    (`describeRenderOptions`), which the frontend uses to build its form.
 */

const {
  DEFAULT_NVENC_PRESET,
  DEFAULT_QP,
  FPS_RANGE,
  NVENC_PRESETS,
  QP_RANGE,
  TOPAZ_FILTER_DEFAULTS,
  TVAI_TUNABLE_KEYS,
  TVAI_TUNABLE_RANGES,
} = require('../utils/ffmpeg');
const { resolutionLabel, sanitizeOutputName } = require('../utils/filename');
const { errors } = require('../utils/errors');

const AUDIO_MODES = Object.freeze(['auto', 'copy', 'aac', 'reencode', 'none']);
const BOOLEAN_WORDS = Object.freeze({ true: 1, false: 0, yes: 1, no: 0, on: 1, off: 0 });

const integerRange = (min, max) => ({ min, max, integer: true });

/**
 * Option table. `group`/`key` describe the shape returned to clients, `field`
 * is the multipart field name the API accepts.
 */
const OPTION_SPECS = Object.freeze([
  {
    field: 'model',
    group: 'root',
    key: 'model',
    type: 'model',
    label: 'Topaz model',
    defaultValue: (config) => config.topazModel,
  },
  {
    field: 'device',
    group: 'root',
    key: 'device',
    type: 'integer',
    label: 'GPU device index',
    range: (config) => integerRange(0, config.maxGpuIndex),
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.device,
  },
  {
    field: 'vram',
    group: 'root',
    key: 'vram',
    type: 'integer',
    label: 'Low VRAM mode',
    range: () => TVAI_TUNABLE_RANGES.vram,
    booleanWords: true,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.vram,
  },
  {
    field: 'instances',
    group: 'root',
    key: 'instances',
    type: 'integer',
    label: 'Model instances',
    range: () => TVAI_TUNABLE_RANGES.instances,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.instances,
  },
  {
    field: 'preblur',
    group: 'topaz',
    key: 'preblur',
    type: 'number',
    label: 'Pre-blur',
    range: () => TVAI_TUNABLE_RANGES.preblur,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.preblur,
  },
  {
    field: 'noise',
    group: 'topaz',
    key: 'noise',
    type: 'number',
    label: 'Noise reduction',
    range: () => TVAI_TUNABLE_RANGES.noise,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.noise,
  },
  {
    field: 'details',
    group: 'topaz',
    key: 'details',
    type: 'number',
    label: 'Details recovery',
    range: () => TVAI_TUNABLE_RANGES.details,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.details,
  },
  {
    field: 'halo',
    group: 'topaz',
    key: 'halo',
    type: 'number',
    label: 'Halo',
    range: () => TVAI_TUNABLE_RANGES.halo,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.halo,
  },
  {
    field: 'blur',
    group: 'topaz',
    key: 'blur',
    type: 'number',
    label: 'Blur',
    range: () => TVAI_TUNABLE_RANGES.blur,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.blur,
  },
  {
    field: 'compression',
    group: 'topaz',
    key: 'compression',
    type: 'number',
    label: 'Compression recovery',
    range: () => TVAI_TUNABLE_RANGES.compression,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.compression,
  },
  {
    field: 'blend',
    group: 'topaz',
    key: 'blend',
    type: 'number',
    label: 'Original blend',
    range: () => TVAI_TUNABLE_RANGES.blend,
    defaultValue: () => TOPAZ_FILTER_DEFAULTS.blend,
  },
  {
    field: 'qp',
    group: 'encoder',
    key: 'qp',
    type: 'integer',
    label: 'H.264 quantization (lower = better)',
    range: () => integerRange(QP_RANGE.min, QP_RANGE.max),
    defaultValue: () => DEFAULT_QP,
  },
  {
    field: 'preset',
    group: 'encoder',
    key: 'preset',
    type: 'enum',
    label: 'NVENC preset (p1 fastest … p7 best)',
    values: () => NVENC_PRESETS,
    defaultValue: () => DEFAULT_NVENC_PRESET,
  },
  {
    field: 'audio',
    group: 'root',
    key: 'audio',
    type: 'enum',
    label: 'Audio handling',
    values: () => AUDIO_MODES,
    defaultValue: (config) => (AUDIO_MODES.includes(config.audioMode) ? config.audioMode : 'auto'),
  },
  {
    field: 'fps',
    group: 'root',
    key: 'fps',
    type: 'number',
    label: 'Output frame rate (frame duplication/dropping)',
    range: () => ({ min: FPS_RANGE.min, max: FPS_RANGE.max, integer: false }),
    defaultValue: () => null,
    hint: 'Omit to keep the source frame rate. Fractional rates are allowed (23.976, 29.97, 59.94).',
  },
  {
    field: 'filename',
    group: 'root',
    key: 'filename',
    type: 'string',
    label: 'Output filename (without extension)',
    transform: (raw) => sanitizeOutputName(raw, { maxLength: 80 }),
    defaultValue: () => null,
    hint: 'When set, the render is named "<filename> <label>.mp4" instead of the automatic name.',
  },
  {
    field: 'label',
    group: 'root',
    key: 'label',
    type: 'string',
    label: 'Output name suffix',
    transform: (raw) => sanitizeOutputName(raw, { maxLength: 24 }),
    defaultValue: () => null,
    hint: 'Only used with "filename"; defaults to the resolution label (4K, 1440p, 1080p, 720p, WxH).',
  },
]);

/** Multipart field names understood by `POST /api/v1/jobs`. */
const RENDER_OPTION_FIELDS = Object.freeze(OPTION_SPECS.map((spec) => spec.field));

const TOPAZ_FILTER_FIELDS = Object.freeze(
  OPTION_SPECS.filter((spec) => spec.group === 'topaz').map((spec) => spec.key),
);

function assign(options, spec, value) {
  if (spec.group === 'root') options[spec.key] = value;
  else options[spec.group][spec.key] = value;
}

function readValue(options, spec) {
  if (!options || typeof options !== 'object') return undefined;
  if (spec.group === 'root') return options[spec.key];
  const group = options[spec.group];
  return group && typeof group === 'object' ? group[spec.key] : undefined;
}

/** The resolved baseline: identical to the documented default ffmpeg command. */
function defaultRenderOptions(config) {
  const options = { topaz: {}, encoder: {} };
  for (const spec of OPTION_SPECS) assign(options, spec, spec.defaultValue(config));
  return options;
}

/** Multipart fields are always strings: normalize empty values to `undefined`. */
function readRawField(fields, name) {
  const value = fields?.[name];
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  return raw === '' ? undefined : raw;
}

function parseFieldValue(spec, raw, config) {
  const label = `"${spec.field}"`;

  if (spec.transform) {
    const value = spec.transform(raw);
    if (!value) {
      throw errors.validation(
        `${label} must contain at least one usable character (letters, digits, spaces, _ - .).`,
        { field: spec.field },
      );
    }
    return value;
  }

  if (spec.type === 'model') {
    if (!config.allowedModels.includes(raw.toLowerCase())) {
      throw errors.validation(
        `${label} must be one of: ${config.allowedModels.join(', ')}.`,
        { field: spec.field, allowed: [...config.allowedModels] },
      );
    }
    return config.allowedModels[config.allowedModels.indexOf(raw.toLowerCase())];
  }

  if (spec.type === 'enum') {
    const allowed = spec.values(config);
    const normalized = raw.toLowerCase();
    const match = allowed.find((value) => value.toLowerCase() === normalized);
    if (!match) {
      throw errors.validation(`${label} must be one of: ${allowed.join(', ')}.`, {
        field: spec.field,
        allowed: [...allowed],
      });
    }
    return match;
  }

  if (spec.booleanWords) {
    const word = BOOLEAN_WORDS[raw.toLowerCase()];
    if (word !== undefined) return word;
  }

  const { min, max, integer } = spec.range(config);
  const pattern = integer ? /^-?\d+$/ : /^-?(?:\d+|\d*\.\d+)$/;
  if (!pattern.test(raw)) {
    throw errors.validation(`${label} must be ${integer ? 'an integer' : 'a number'}.`, {
      field: spec.field,
      received: raw.slice(0, 32),
    });
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw errors.validation(`${label} must be between ${min} and ${max}.`, {
      field: spec.field,
      min,
      max,
      received: Number.isFinite(value) ? value : raw.slice(0, 32),
    });
  }
  return value;
}

/**
 * Strict parsing of multipart fields (used by the upload endpoint).
 *
 * @param {Record<string, string>} fields lowercased multipart form fields
 * @param {object} config
 * @param {{ width?: number, height?: number }} [context] target resolution, used
 *   to derive the default output label ("4K") for custom filenames
 * @returns {object} resolved options
 * @throws {AppError} VALIDATION_ERROR for unknown values, out-of-range values or
 *   when tuning is disabled server-side
 */
function parseRenderOptions(fields, config, context = {}) {
  const provided = RENDER_OPTION_FIELDS.filter((field) => readRawField(fields, field) !== undefined);
  const options = defaultRenderOptions(config);

  if (provided.length === 0) return options;

  if (!config.allowRenderTuning) {
    throw errors.validation(
      'Per-job render tuning is disabled on this server; only "video", "width" and "height" ' +
        'are accepted.',
      { fields: provided, tuningEnabled: false },
    );
  }

  const labelProvided = readRawField(fields, 'label') !== undefined;
  if (labelProvided && readRawField(fields, 'filename') === undefined) {
    throw errors.validation('"label" can only be used together with "filename".', {
      field: 'label',
      requires: 'filename',
    });
  }

  for (const spec of OPTION_SPECS) {
    const raw = readRawField(fields, spec.field);
    if (raw === undefined) continue;
    assign(options, spec, parseFieldValue(spec, raw, config));
  }

  // The label only means something for a custom filename, and it defaults to the
  // resolution class so `filename=sosul eater rev` + 3840x2160 -> `sosul eater rev 4K.mp4`.
  if (!options.filename) {
    options.label = null;
  } else if (!options.label && context.width && context.height) {
    options.label = resolutionLabel(context.width, context.height);
  }

  return options;
}

/**
 * Lenient normalization of a stored/partial options object: invalid values fall
 * back to the baseline instead of failing a job (used when rendering a job row).
 */
function normalizeRenderOptions(input, config) {
  const options = defaultRenderOptions(config);
  for (const spec of OPTION_SPECS) {
    const value = readValue(input, spec);
    if (value === undefined || value === null) continue;
    try {
      assign(options, spec, parseFieldValue(spec, String(value), config));
    } catch {
      /* keep the baseline value */
    }
  }
  return options;
}

/** Reads the options stored on a job row (falling back to the baseline). */
function readStoredRenderOptions(row, config, logger) {
  const stored = row?.render_options;
  if (!stored) return defaultRenderOptions(config);
  try {
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return normalizeRenderOptions(parsed, config);
  } catch (error) {
    logger?.warn?.(`stored render options could not be read, using defaults: ${error.message}`);
    return defaultRenderOptions(config);
  }
}

/** Machine-readable description for `GET /api/v1/system/status`. */
function describeRenderOptions(config) {
  const fields = {};
  for (const spec of OPTION_SPECS) {
    const entry = {
      field: spec.field,
      type: spec.type === 'model' ? 'string' : spec.type,
      label: spec.label,
      defaultValue: spec.defaultValue(config),
    };
    if (spec.type === 'model') entry.allowed = [...config.allowedModels];
    if (spec.type === 'enum') entry.allowed = [...spec.values(config)];
    if (spec.range) {
      const range = spec.range(config);
      entry.min = range.min;
      entry.max = range.max;
      entry.integer = Boolean(range.integer);
    }
    if (spec.booleanWords) entry.booleanWordsAccepted = true;
    if (spec.hint) entry.hint = spec.hint;
    fields[spec.field] = entry;
  }

  return {
    tuningEnabled: config.allowRenderTuning,
    defaults: defaultRenderOptions(config),
    fields,
  };
}

/**
 * `tvai_up` filter parameters (`preblur`, `noise`, …, `device`, `vram`,
 * `instances`) derived from the resolved options. `w`/`h` are never part of it:
 * they always come from the request.
 */
function toFilterParameters(options) {
  const parameters = {};
  for (const spec of OPTION_SPECS) {
    if (!TVAI_TUNABLE_KEYS.includes(spec.key)) continue;
    parameters[spec.key] = readValue(options, spec);
  }
  return parameters;
}

/** Short log line listing only the values that differ from the baseline. */
function summarizeRenderOptions(options, config) {
  const defaults = defaultRenderOptions(config);
  const parts = [];
  for (const spec of OPTION_SPECS) {
    const value = readValue(options, spec);
    const fallback = readValue(defaults, spec);
    if (value !== fallback) parts.push(`${spec.field}=${value}`);
  }
  return parts.length === 0 ? 'baseline' : parts.join(' ');
}

module.exports = {
  AUDIO_MODES,
  OPTION_SPECS,
  RENDER_OPTION_FIELDS,
  TOPAZ_FILTER_FIELDS,
  defaultRenderOptions,
  describeRenderOptions,
  normalizeRenderOptions,
  parseRenderOptions,
  readStoredRenderOptions,
  summarizeRenderOptions,
  toFilterParameters,
};
