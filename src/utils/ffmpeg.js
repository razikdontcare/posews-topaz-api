'use strict';

/**
 * FFmpeg / FFprobe argument builders and output helpers.
 *
 * The Topaz Video AI baseline command is immutable configuration living here.
 * Only `width`/`height` (and the input/output paths created by the server) come
 * from the request, and they are injected with a real argument builder — never
 * with string replacement. No user input is ever interpolated into a shell.
 */

const { errors } = require('./errors');

/**
 * Immutable default filter parameters (Topaz `tvai_up` / model prob-3).
 * Per-job overrides are limited to `TVAI_TUNABLE_KEYS` and validated against
 * `TVAI_TUNABLE_RANGES` — the model/scale/baseline values stay configuration.
 */
const TOPAZ_FILTER_DEFAULTS = Object.freeze({
  model: 'prob-3',
  scale: 0,
  preblur: -0.100659,
  noise: 0.25,
  details: 0.75,
  halo: 0.05,
  blur: 0.25,
  compression: 0.2,
  blend: 0.6,
  device: 0,
  vram: 1,
  instances: 1,
});

/** Order used inside the `tvai_up` filter string (never reorder: it is the baseline). */
const TVAI_TUNABLE_KEYS = Object.freeze([
  'preblur',
  'noise',
  'details',
  'halo',
  'blur',
  'compression',
  'blend',
  'device',
  'vram',
  'instances',
]);

/** Accepted range for every tunable; also reused to describe the API options. */
const TVAI_TUNABLE_RANGES = Object.freeze({
  preblur: Object.freeze({ min: -1, max: 1, integer: false }),
  noise: Object.freeze({ min: 0, max: 1, integer: false }),
  details: Object.freeze({ min: 0, max: 1, integer: false }),
  halo: Object.freeze({ min: 0, max: 1, integer: false }),
  blur: Object.freeze({ min: 0, max: 1, integer: false }),
  compression: Object.freeze({ min: 0, max: 1, integer: false }),
  blend: Object.freeze({ min: 0, max: 1, integer: false }),
  device: Object.freeze({ min: 0, max: 15, integer: true }),
  vram: Object.freeze({ min: 0, max: 1, integer: true }),
  instances: Object.freeze({ min: 1, max: 4, integer: true }),
});

/** NVENC legacy-free presets: p1 = fastest, p7 = slowest/best (baseline: p7). */
const NVENC_PRESETS = Object.freeze(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
const DEFAULT_NVENC_PRESET = 'p7';
/** `-rc constqp` quality knob: lower = better quality and bigger files. */
const DEFAULT_QP = 25;
const QP_RANGE = Object.freeze({ min: 1, max: 51 });
/**
 * Output frame rate accepted by the `fps` filter (frame duplication/dropping).
 * Fractional NTSC rates are allowed (23.976, 29.97, 59.94).
 */
const FPS_RANGE = Object.freeze({ min: 1, max: 240, decimals: 3 });

const SWSCALE_FLAGS = 'spline+accurate_rnd+full_chroma_int';
const COLOR_ARGUMENTS = Object.freeze([
  ['-color_trc', '1'],
  ['-colorspace', '1'],
  ['-color_primaries', '1'],
]);

const VIDEO_ENCODER_ARGUMENTS_TEMPLATE = Object.freeze({
  codec: 'h264_nvenc',
  profile: 'high',
  pixelFormat: 'yuv420p',
  tune: 'hq',
  rateControl: 'constqp',
  lookahead: 20,
  spatialAq: 1,
  temporalAq: 1,
  aqStrength: 15,
});

const MOVFLAGS = 'frag_keyframe+empty_moov+delay_moov+use_metadata_tags+write_colr';

/** Audio codecs that can be stream-copied into an mp4 without re-encoding. */
const MP4_COPY_SAFE_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac', 'mp2']);

const TOPAZ_FILTER_NAME = 'tvai_up';
const NVENC_ENCODER_NAME = 'h264_nvenc';

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

function assertDimension(value, name, bounds) {
  if (!Number.isInteger(value)) {
    throw errors.validation(`${name} must be an integer.`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw errors.validation(`${name} must be between ${bounds.min} and ${bounds.max}.`);
  }
  if (bounds.enforceEven && value % 2 !== 0) {
    throw errors.validation(`${name} must be an even number for H.264 (yuv420p) encoding.`);
  }
  return value;
}

/**
 * ```
 * tvai_up=model=prob-3:scale=0:w=3840:h=1620:preblur=...:instances=1
 * ```
 * `w`/`h` always come from the request; the tunables fall back to the frozen
 * baseline so the string is identical to the documented default command.
 */
function buildTvaiFilter({
  width,
  height,
  model = TOPAZ_FILTER_DEFAULTS.model,
  parameters = {},
}) {
  if (!MODEL_PATTERN.test(String(model))) {
    throw errors.validation('Unsupported Topaz model name.');
  }

  const values = {};
  for (const key of TVAI_TUNABLE_KEYS) {
    const override = parameters[key];
    values[key] = override === undefined || override === null ? TOPAZ_FILTER_DEFAULTS[key] : override;
  }

  const parts = [
    `model=${model}`,
    `scale=${TOPAZ_FILTER_DEFAULTS.scale}`,
    `w=${width}`,
    `h=${height}`,
    ...TVAI_TUNABLE_KEYS.map((key) => `${key}=${values[key]}`),
  ];
  return `${TOPAZ_FILTER_NAME}=${parts.join(':')}`;
}

/**
 * The H.264/NVENC block of the baseline command, with the two quality knobs
 * (`-qp` and `-preset`) adjustable.
 */
function buildVideoEncoderArguments({ qp = DEFAULT_QP, preset = DEFAULT_NVENC_PRESET } = {}) {
  if (!NVENC_PRESETS.includes(preset)) {
    throw errors.validation(`encoder preset must be one of ${NVENC_PRESETS.join(', ')}.`, {
      field: 'preset',
      allowed: [...NVENC_PRESETS],
    });
  }
  if (!Number.isInteger(qp) || qp < QP_RANGE.min || qp > QP_RANGE.max) {
    throw errors.validation(`qp must be an integer between ${QP_RANGE.min} and ${QP_RANGE.max}.`, {
      field: 'qp',
      min: QP_RANGE.min,
      max: QP_RANGE.max,
    });
  }

  const template = VIDEO_ENCODER_ARGUMENTS_TEMPLATE;
  return [
    '-c:v', template.codec,
    '-profile:v', template.profile,
    '-pix_fmt', template.pixelFormat,
    '-preset', preset,
    '-tune', template.tune,
    '-rc', template.rateControl,
    '-qp', String(qp),
    '-rc-lookahead', String(template.lookahead),
    '-spatial_aq', String(template.spatialAq),
    '-temporal_aq', String(template.temporalAq),
    '-aq-strength', String(template.aqStrength),
    '-b:v', '0',
  ];
}

/** The frozen baseline encoder block (no per-job overrides). */
const VIDEO_ENCODER_ARGUMENTS = Object.freeze(buildVideoEncoderArguments());

/** Post-up scale to the requested resolution plus the bt709 colour conversion. */
function buildScaleFilters({ width, height }) {
  return [
    `scale=w=${width}:h=${height}:flags=lanczos:threads=0`,
    'scale=out_color_matrix=bt709',
  ];
}

/** Post-up scale to the requested resolution plus the bt709 colour conversion. */
function buildScaleFilters({ width, height }) {
  return [
    `scale=w=${width}:h=${height}:flags=lanczos:threads=0`,
    'scale=out_color_matrix=bt709',
  ];
}

/**
 * Optional output frame rate. This is a frame-rate *conversion* (ffmpeg's `fps`
 * filter duplicates/drops frames) — it does not synthesise new motion.
 * Returns `null` when the source frame rate should be kept.
 */
function buildFpsFilter(fps) {
  if (fps === null || fps === undefined) return null;
  if (!Number.isFinite(fps) || fps < FPS_RANGE.min || fps > FPS_RANGE.max) {
    throw errors.validation(`fps must be a number between ${FPS_RANGE.min} and ${FPS_RANGE.max}.`, {
      field: 'fps',
      min: FPS_RANGE.min,
      max: FPS_RANGE.max,
    });
  }
  return `fps=${Number(fps.toFixed(FPS_RANGE.decimals))}`;
}

function buildFilterComplex({ width, height, model, parameters, fps }) {
  const filters = [
    buildTvaiFilter({ width, height, model, parameters }),
    ...buildScaleFilters({ width, height }),
  ];
  const fpsFilter = buildFpsFilter(fps);
  if (fpsFilter) filters.push(fpsFilter);
  return filters.join(',');
}

/**
 * Audio arguments.
 *
 * The Topaz baseline (`-map 0:a -c:a copy -bsf:a:0 aac_adtstoasc`) is kept
 * verbatim whenever the input really has an AAC audio stream: `-map 0:a` makes
 * ffmpeg fail on silent videos, and the ADTS bitstream filter makes it fail on
 * non-AAC audio, so both are applied conditionally.
 * `mode` is `auto` (default), `copy`, `aac`/`reencode` or `none` (drop audio).
 */
function buildAudioArguments({ hasAudio, audioCodec, mode = 'auto' }) {
  if (mode === 'none') {
    // Drop the audio track entirely (no `-map 0:a`, so nothing is muxed in).
    return ['-an'];
  }
  if (hasAudio === false) return [];
  const codec = audioCodec ? String(audioCodec).toLowerCase() : null;

  if (mode === 'reencode' || mode === 'aac' || (mode === 'auto' && codec && !MP4_COPY_SAFE_AUDIO.has(codec))) {
    // e.g. vorbis / pcm in an mkv cannot be muxed into mp4 as-is.
    return ['-map', '0:a', '-c:a', 'aac', '-b:a', '192k'];
  }

  // `0:a` keeps the baseline behaviour; `0:a?` is used when stream info is unknown.
  const map = hasAudio === true ? ['-map', '0:a'] : ['-map', '0:a?'];
  const args = [...map, '-c:a', 'copy'];
  // The ADTS filter is only valid for AAC input; applying it to (for example)
  // AC-3 makes ffmpeg fail while opening the stream, so an unknown codec is left
  // alone (ffmpeg applies the needed ADTS->ASC conversion automatically when
  // muxing into mp4).
  if (codec === 'aac') {
    args.push('-bsf:a:0', 'aac_adtstoasc');
  }
  return args;
}

/**
 * Builds the full ffmpeg argument vector.
 *
 * @param {{
 *   inputPath: string,
 *   outputPath: string,
 *   width: number,
 *   height: number,
 *   model?: string,
 *   topaz?: object,
 *   encoder?: { qp?: number, preset?: string },
 *   fps?: number|null,
 *   hasAudio?: boolean|null,
 *   audioCodec?: string|null,
 *   audioMode?: 'auto'|'copy'|'aac'|'reencode'|'none',
 *   bounds?: { min: number, max: number, enforceEven: boolean },
 * }} options
 */
function buildFfmpegArgs(options) {
  const {
    inputPath,
    outputPath,
    width,
    height,
    model = TOPAZ_FILTER_DEFAULTS.model,
    topaz = {},
    encoder = {},
    fps = null,
    hasAudio = true,
    audioCodec = null,
    audioMode = 'auto',
    bounds = { min: 16, max: 7680, enforceEven: true },
  } = options;

  if (!inputPath || typeof inputPath !== 'string') {
    throw errors.internal('buildFfmpegArgs requires an input path.');
  }
  if (!outputPath || typeof outputPath !== 'string') {
    throw errors.internal('buildFfmpegArgs requires an output path.');
  }

  assertDimension(width, 'width', bounds);
  assertDimension(height, 'height', bounds);

  const args = [
    '-hide_banner',
    '-nostdin',
    '-progress',
    'pipe:1',
    '-nostats',
    '-y',
    '-i',
    inputPath,
    '-sws_flags',
    SWSCALE_FLAGS,
  ];

  for (const [flag, value] of COLOR_ARGUMENTS) args.push(flag, value);

  const resolvedModel = topaz?.model || model;
  args.push(
    '-filter_complex',
    buildFilterComplex({ width, height, model: resolvedModel, parameters: topaz, fps }),
  );

  args.push(
    ...buildVideoEncoderArguments({
      qp: encoder.qp !== undefined ? encoder.qp : DEFAULT_QP,
      preset: encoder.preset !== undefined ? encoder.preset : DEFAULT_NVENC_PRESET,
    }),
  );

  args.push(...buildAudioArguments({ hasAudio, audioCodec, mode: audioMode }));

  args.push('-map_metadata', '0', '-movflags', MOVFLAGS, outputPath);
  return args;
}

/** Builds the `tvai_up` arguments used for the startup model self test. */
function buildModelSelftestArgs({ model, width = 128, height = 128, device = TOPAZ_FILTER_DEFAULTS.device } = {}) {
  return [
    '-hide_banner',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'nullsrc=s=64x64',
    '-frames:v',
    '1',
    '-filter_complex',
    `tvai_up=model=${model}:scale=0:w=${width}:h=${height}:device=${device}:vram=1:instances=1`,
    '-f',
    'null',
    '-',
  ];
}

/** `ffprobe -v error -show_entries format=duration:stream=... -of json INPUT`. */
function buildProbeArgs(inputPath) {
  return [
    '-v',
    'error',
    '-show_entries',
    'format=duration,format_name:stream=index,codec_type,codec_name,width,height,duration,nb_frames,avg_frame_rate,channels',
    '-of',
    'json',
    inputPath,
  ];
}

const CAPABILITY_COMMANDS = Object.freeze({
  version: ['-hide_banner', '-version'],
  filters: ['-hide_banner', '-filters'],
  encoders: ['-hide_banner', '-encoders'],
  // Proves an NVENC session can actually be created (catches driver problems
  // before the user uploads a multi-gigabyte file).
  selftest: [
    '-hide_banner',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'nullsrc=s=128x128',
    '-frames:v',
    '1',
    '-c:v',
    NVENC_ENCODER_NAME,
    '-f',
    'null',
    '-',
  ],
});

function listContains(entries, name) {
  if (!entries) return false;
  const pattern = new RegExp(`(^|[\\s,])${name}([\\s,]|$)`, 'm');
  return pattern.test(entries);
}

const hasFilter = (filterList) => listContains(filterList, TOPAZ_FILTER_NAME);
const hasEncoder = (encoderList) => listContains(encoderList, NVENC_ENCODER_NAME);

/**
 * Removes ffmpeg's `[component @ 0000020D410CED80] ` prefixes for readability.
 */
function stripComponentPrefix(line) {
  return String(line).replace(/^\[[^\]]*@\s*(0x)?[0-9a-fA-F]*\]\s*/, '').trim();
}

/** Internal ffmpeg chatter that never helps a user understand a failure. */
const STDERR_NOISE = [
  /^Task finished with error code/i,
  /^Terminating thread with return code/i,
  /^Conversion failed!?$/i,
  /^Error reinitializing filters!?$/i,
  /^Could not open encoder before EOF/i,
  /^Nothing was written into output file/i,
  /^frame=\s/,
  /^size=\s/,
  /^video:\d/,
  /^Stream mapping/,
  /^Input #\d/,
  /^Output #\d/,
  /^Press \[q\]/,
  /^\s+Stream #\d/,
  /^\s*$/,
];

function isStderrNoise(line) {
  return STDERR_NOISE.some((pattern) => pattern.test(line));
}

/**
 * Turns ffmpeg's stderr tail into a short, user/log friendly message.
 * Never returns unbounded text.
 */
function summarizeStderr(stderr, maxLength = 1000) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map(stripComponentPrefix)
    .filter((line) => line.length > 0);

  if (lines.length === 0) return 'FFmpeg did not report any diagnostic output.';

  const signal = lines.filter((line) => !isStderrNoise(line));
  const candidates = signal.length > 0 ? signal : lines;
  const interesting = candidates.filter((line) =>
    /error|cannot|can't|invalid|not found|not supported|no such|failed|missing|unable|denied|out of memory|unknown/i.test(
      line,
    ),
  );
  const chosen = (interesting.length > 0 ? interesting : candidates).slice(-3);
  const unique = [...new Set(chosen)];
  let summary = unique.join(' | ');
  if (summary.length > maxLength) summary = `${summary.slice(0, maxLength - 1)}…`;
  return summary;
}

/**
 * Maps a non-zero ffmpeg exit to an error code + actionable message.
 */
function classifyFfmpegFailure(stderrTail, maxLength = 1000) {
  const summary = summarizeStderr(stderrTail, maxLength);
  const haystack = summary.toLowerCase();

  if (
    haystack.includes('cannot load nvcuda') ||
    haystack.includes('no cuda-capable device') ||
    haystack.includes('no capable devices') ||
    haystack.includes('cuda_error') ||
    (haystack.includes('nvenc') && haystack.includes('not available')) ||
    haystack.includes('openencodesessionex failed')
  ) {
    return {
      code: 'RENDERER_UNAVAILABLE',
      message: `NVIDIA encoder is not available: ${summary}`,
    };
  }

  if (haystack.includes('out of memory') || haystack.includes('cuda out of memory')) {
    return { code: 'FFMPEG_ERROR', message: `FFmpeg ran out of GPU memory: ${summary}` };
  }

  // A missing model and a filter that cannot initialise are both *renderer* problems:
  // every following job would fail the same way, so the renderer is marked unusable
  // (uploads get 503, queued jobs wait, and the periodic recheck enables it again).
  if (haystack.includes('model not found') || haystack.includes('unable to load model')) {
    return {
      code: 'RENDERER_UNAVAILABLE',
      message:
        `Topaz model is not available: ${summary}. Open Topaz Video AI once to download the model, ` +
        'then retry the job.',
    };
  }

  if (
    haystack.includes('configure output pad') ||
    haystack.includes('failed to inject frame into filter network') ||
    haystack.includes('tvai_up')
  ) {
    return {
      code: 'RENDERER_UNAVAILABLE',
      message:
        `The Topaz tvai_up filter could not start: ${summary}. This normally means the GPU device is ` +
        'not usable (NVIDIA driver/CUDA) or the model could not be loaded — check the renderer self ' +
        'test in GET /api/v1/system/status.',
    };
  }

  return { code: 'FFMPEG_ERROR', message: `FFmpeg exited with an error: ${summary}` };
}

module.exports = {
  CAPABILITY_COMMANDS,
  COLOR_ARGUMENTS,
  DEFAULT_NVENC_PRESET,
  DEFAULT_QP,
  FPS_RANGE,
  MODEL_PATTERN,
  MOVFLAGS,
  MP4_COPY_SAFE_AUDIO,
  NVENC_ENCODER_NAME,
  NVENC_PRESETS,
  QP_RANGE,
  SWSCALE_FLAGS,
  TOPAZ_FILTER_DEFAULTS,
  TOPAZ_FILTER_NAME,
  TVAI_TUNABLE_KEYS,
  TVAI_TUNABLE_RANGES,
  VIDEO_ENCODER_ARGUMENTS,
  assertDimension,
  buildAudioArguments,
  buildFfmpegArgs,
  buildFilterComplex,
  buildFpsFilter,
  buildModelSelftestArgs,
  buildProbeArgs,
  buildScaleFilters,
  buildTvaiFilter,
  buildVideoEncoderArguments,
  classifyFfmpegFailure,
  hasEncoder,
  hasFilter,
  summarizeStderr,
};
