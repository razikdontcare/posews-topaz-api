'use strict';

/**
 * Per-job render options: defaults, strict API parsing, lenient stored reads and
 * the ffmpeg-facing projection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createConfig } = require('../../src/config/env');
const {
  AUDIO_MODES,
  RENDER_OPTION_FIELDS,
  defaultRenderOptions,
  describeRenderOptions,
  normalizeRenderOptions,
  parseRenderOptions,
  readStoredRenderOptions,
  summarizeRenderOptions,
  toFilterParameters,
} = require('../../src/domain/render-options');
const { TOPAZ_FILTER_DEFAULTS } = require('../../src/utils/ffmpeg');

const BASE_CONFIG = createConfig();
const TUNED_CONFIG = createConfig({ maxGpuIndex: 3, allowedModels: ['prob-3', 'prob-4', 'ahq-12'] });
const NO_TUNING_CONFIG = createConfig({ allowRenderTuning: false });

test('defaults reproduce the frozen Topaz baseline', () => {
  const options = defaultRenderOptions(BASE_CONFIG);

  assert.deepEqual(options, {
    model: BASE_CONFIG.topazModel,
    device: TOPAZ_FILTER_DEFAULTS.device,
    vram: TOPAZ_FILTER_DEFAULTS.vram,
    instances: TOPAZ_FILTER_DEFAULTS.instances,
    topaz: {
      preblur: TOPAZ_FILTER_DEFAULTS.preblur,
      noise: TOPAZ_FILTER_DEFAULTS.noise,
      details: TOPAZ_FILTER_DEFAULTS.details,
      halo: TOPAZ_FILTER_DEFAULTS.halo,
      blur: TOPAZ_FILTER_DEFAULTS.blur,
      compression: TOPAZ_FILTER_DEFAULTS.compression,
      blend: TOPAZ_FILTER_DEFAULTS.blend,
    },
    encoder: { qp: 25, preset: 'p7' },
    audio: BASE_CONFIG.audioMode,
    fps: null,
    filename: null,
    label: null,
  });

  // No options at all must not be an error and must not drift from the baseline.
  assert.deepEqual(parseRenderOptions({}, BASE_CONFIG), options);
  assert.deepEqual(parseRenderOptions({ width: '1280', height: '720' }, BASE_CONFIG), options);
});

test('parses every option field and echoes the resolved shape', () => {
  const options = parseRenderOptions(
    {
      width: '3840',
      height: '2160',
      model: 'PROB-4',
      device: '2',
      vram: 'false',
      instances: '2',
      preblur: '0.2',
      noise: '0.5',
      details: '0.9',
      halo: '0.1',
      blur: '0.4',
      compression: '0.3',
      blend: '0.75',
      qp: '18',
      preset: 'P5',
      audio: 'None',
    },
    TUNED_CONFIG,
  );

  assert.deepEqual(options, {
    model: 'prob-4',
    device: 2,
    vram: 0,
    instances: 2,
    topaz: {
      preblur: 0.2,
      noise: 0.5,
      details: 0.9,
      halo: 0.1,
      blur: 0.4,
      compression: 0.3,
      blend: 0.75,
    },
    encoder: { qp: 18, preset: 'p5' },
    audio: 'none',
    fps: null,
    filename: null,
    label: null,
  });
});

test('parses fps, filename and the derived output label', () => {
  const options = parseRenderOptions(
    { filename: 'sosul eater rev.mp4', fps: '59.94' },
    TUNED_CONFIG,
    { width: 3840, height: 2160 },
  );
  assert.equal(options.filename, 'sosul eater rev', 'the extension is stripped for the client');
  assert.equal(options.fps, 59.94);
  assert.equal(options.label, '4K', 'the label is derived from the target resolution');

  const explicit = parseRenderOptions(
    { filename: 'clip', label: 'Final Cut', fps: '30' },
    TUNED_CONFIG,
    { width: 1920, height: 1080 },
  );
  assert.equal(explicit.filename, 'clip');
  assert.equal(explicit.label, 'Final Cut');
  assert.equal(explicit.fps, 30);

  const noCustomName = parseRenderOptions({ fps: '24' }, TUNED_CONFIG, { width: 3840, height: 2160 });
  assert.equal(noCustomName.filename, null);
  assert.equal(noCustomName.label, null, 'without a filename there is no label');
  assert.equal(noCustomName.fps, 24);
});

test('fps and filename values are validated', () => {
  assert.throws(
    () => parseRenderOptions({ fps: '0' }, TUNED_CONFIG),
    /"fps" must be between 1 and 240/,
  );
  assert.throws(
    () => parseRenderOptions({ fps: '241' }, TUNED_CONFIG),
    /"fps" must be between 1 and 240/,
  );
  assert.throws(() => parseRenderOptions({ fps: 'fast' }, TUNED_CONFIG), /"fps" must be a number/);

  assert.throws(
    () => parseRenderOptions({ label: '4K' }, TUNED_CONFIG),
    /"label" can only be used together with "filename"/,
  );
  assert.throws(
    () => parseRenderOptions({ filename: '...' }, TUNED_CONFIG),
    /"filename" must contain at least one usable character/,
  );
  assert.throws(
    () => parseRenderOptions({ filename: 'clip', label: '...' }, TUNED_CONFIG),
    /must contain at least one usable character/,
  );
  // Unusable characters are sanitized rather than rejected.
  assert.equal(parseRenderOptions({ filename: 'a<b>c' }, TUNED_CONFIG).filename, 'a_b_c');
});

test('empty values and unknown fields fall back to the baseline', () => {
  const options = parseRenderOptions({ noise: '', model: '   ', typo_noice: '0.9' }, BASE_CONFIG);
  assert.equal(options.topaz.noise, TOPAZ_FILTER_DEFAULTS.noise);
  assert.equal(options.model, BASE_CONFIG.topazModel);
  assert.equal('typo_noice' in options, false);
});

test('rejects out-of-range, malformed and unknown option values', () => {
  const cases = [
    [{ noise: '1.5' }, /"noise" must be between 0 and 1/, { field: 'noise', min: 0, max: 1 }],
    [{ noise: '-0.2' }, /"noise" must be between 0 and 1/, { field: 'noise' }],
    [{ preblur: '-2' }, /"preblur" must be between -1 and 1/, { field: 'preblur' }],
    [{ details: 'many' }, /"details" must be a number/, { field: 'details' }],
    [{ qp: '0' }, /"qp" must be between 1 and 51/, { field: 'qp' }],
    [{ qp: '52' }, /"qp" must be between 1 and 51/, { field: 'qp' }],
    [{ qp: '18.5' }, /"qp" must be an integer/, { field: 'qp' }],
    [{ preset: 'p9' }, /"preset" must be one of: p1, p2, p3, p4, p5, p6, p7/, { field: 'preset' }],
    [{ audio: 'mute' }, /"audio" must be one of: auto, copy, aac, reencode, none/, { field: 'audio' }],
    [{ model: 'evil-1' }, /"model" must be one of: prob-3, prob-4/, { field: 'model' }],
    [{ instances: '0' }, /"instances" must be between 1 and 4/, { field: 'instances' }],
    [{ vram: '2' }, /"vram" must be between 0 and 1/, { field: 'vram' }],
    [{ device: '4' }, /"device" must be between 0 and 3/, { field: 'device' }],
  ];

  for (const [fields, message, details] of cases) {
    assert.throws(
      () => parseRenderOptions(fields, TUNED_CONFIG),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR', JSON.stringify(fields));
        assert.match(error.message, message);
        for (const [key, value] of Object.entries(details)) {
          assert.deepEqual(error.details[key], value);
        }
        return true;
      },
    );
  }
});

test('tuning can be disabled server-side (strict baseline)', () => {
  assert.doesNotThrow(() => parseRenderOptions({ width: '1920', height: '1080' }, NO_TUNING_CONFIG));

  assert.throws(
    () => parseRenderOptions({ width: '1920', height: '1080', noise: '0.5' }, NO_TUNING_CONFIG),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /tuning is disabled/i);
      assert.deepEqual(error.details.fields, ['noise']);
      return true;
    },
  );
});

test('vram accepts boolean words as well as 0/1', () => {
  assert.equal(parseRenderOptions({ vram: 'true' }, BASE_CONFIG).vram, 1);
  assert.equal(parseRenderOptions({ vram: 'yes' }, BASE_CONFIG).vram, 1);
  assert.equal(parseRenderOptions({ vram: 'off' }, BASE_CONFIG).vram, 0);
  assert.equal(parseRenderOptions({ vram: '1' }, BASE_CONFIG).vram, 1);
});

test('normalization of stored values is lenient (falls back per field)', () => {
  const options = normalizeRenderOptions(
    { model: 'prob-4', device: 99, noise: 'nonsense', encoder: { qp: 12, preset: 'p3' }, audio: 'none' },
    TUNED_CONFIG,
  );

  assert.equal(options.model, 'prob-4');
  assert.equal(options.encoder.qp, 12);
  assert.equal(options.encoder.preset, 'p3');
  assert.equal(options.audio, 'none');
  assert.equal(options.device, TOPAZ_FILTER_DEFAULTS.device, 'unusable device falls back to 0');
  assert.equal(options.topaz.noise, TOPAZ_FILTER_DEFAULTS.noise, 'unusable value falls back');
});

test('readStoredRenderOptions handles null, JSON and broken values', () => {
  const config = TUNED_CONFIG;
  assert.deepEqual(readStoredRenderOptions(null, config), defaultRenderOptions(config));
  assert.deepEqual(readStoredRenderOptions({ render_options: null }, config), defaultRenderOptions(config));

  const stored = JSON.stringify(parseRenderOptions({ qp: '20', audio: 'copy' }, config));
  const read = readStoredRenderOptions({ render_options: stored }, config);
  assert.equal(read.encoder.qp, 20);
  assert.equal(read.audio, 'copy');

  const warnings = [];
  const broken = readStoredRenderOptions(
    { render_options: '{not json' },
    config,
    { warn: (message) => warnings.push(message) },
  );
  assert.deepEqual(broken, defaultRenderOptions(config));
  assert.match(warnings.join(' '), /could not be read/);
});

test('toFilterParameters produces exactly the tvai_up parameters (no w/h)', () => {
  const options = parseRenderOptions({ noise: '0.5', device: '1', vram: '0', instances: '3' }, TUNED_CONFIG);
  const parameters = toFilterParameters(options);

  assert.deepEqual(Object.keys(parameters).sort(), [
    'blend',
    'blur',
    'compression',
    'details',
    'device',
    'halo',
    'instances',
    'noise',
    'preblur',
    'vram',
  ]);
  assert.equal(parameters.noise, 0.5);
  assert.equal(parameters.device, 1);
  assert.equal(parameters.vram, 0);
  assert.equal(parameters.instances, 3);
  assert.equal(parameters.details, TOPAZ_FILTER_DEFAULTS.details);
  assert.equal('w' in parameters, false);
  assert.equal('h' in parameters, false);
  assert.equal('model' in parameters, false);
  assert.equal('scale' in parameters, false);
});

test('summarizeRenderOptions only lists deviations from the baseline', () => {
  assert.equal(summarizeRenderOptions(defaultRenderOptions(BASE_CONFIG), BASE_CONFIG), 'baseline');

  const options = parseRenderOptions({ qp: '18', model: 'prob-4', audio: 'none' }, TUNED_CONFIG);
  const summary = summarizeRenderOptions(options, TUNED_CONFIG);
  assert.match(summary, /model=prob-4/);
  assert.match(summary, /qp=18/);
  assert.match(summary, /audio=none/);
  assert.doesNotMatch(summary, /noise=/);
});

test('describeRenderOptions exposes defaults, ranges and allowed values', () => {
  const description = describeRenderOptions(TUNED_CONFIG);

  assert.equal(description.tuningEnabled, true);
  assert.deepEqual(description.defaults, defaultRenderOptions(TUNED_CONFIG));
  assert.deepEqual(Object.keys(description.fields).sort(), [...RENDER_OPTION_FIELDS].sort());

  assert.deepEqual(description.fields.model.allowed, ['prob-3', 'prob-4', 'ahq-12']);
  assert.equal(description.fields.model.defaultValue, 'prob-3');
  assert.deepEqual(description.fields.preset.allowed, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  assert.equal(description.fields.qp.min, 1);
  assert.equal(description.fields.qp.max, 51);
  assert.equal(description.fields.qp.integer, true);
  assert.equal(description.fields.device.max, 3);
  assert.equal(description.fields.instances.max, 4);
  assert.equal(description.fields.noise.min, 0);
  assert.equal(description.fields.noise.max, 1);
  assert.equal(description.fields.noise.type, 'number');
  assert.equal(description.fields.vram.booleanWordsAccepted, true);
  assert.deepEqual(description.fields.audio.allowed, [...AUDIO_MODES]);
  assert.equal(description.fields.audio.defaultValue, 'auto');
  assert.equal(description.fields.fps.min, 1);
  assert.equal(description.fields.fps.max, 240);
  assert.equal(description.fields.fps.defaultValue, null);
  assert.equal(description.fields.filename.type, 'string');
  assert.equal(description.fields.filename.defaultValue, null);
  assert.equal(description.fields.label.defaultValue, null);
  assert.match(description.fields.label.hint, /resolution label \(4K, 1440p, 1080p, 720p, WxH\)/);
  assert.equal(description.defaults.fps, null);
  assert.equal(description.defaults.filename, null);

  const strict = describeRenderOptions(NO_TUNING_CONFIG);
  assert.equal(strict.tuningEnabled, false);
});
