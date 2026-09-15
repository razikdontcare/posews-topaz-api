'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOPAZ_FILTER_DEFAULTS,
  buildAudioArguments,
  buildFfmpegArgs,
  buildFilterComplex,
  buildModelSelftestArgs,
  buildProbeArgs,
  buildScaleFilters,
  buildTvaiFilter,
  classifyFfmpegFailure,
  summarizeStderr,
} = require('../../src/utils/ffmpeg');

const BOUNDS = { min: 16, max: 7680, enforceEven: true };
const INPUT = 'D:\\VideoTemp\\769337925\\input.mp4';
const OUTPUT = 'D:\\Hasil Render\\.769337925.rendering.mp4';

function args(overrides = {}) {
  return buildFfmpegArgs({
    inputPath: INPUT,
    outputPath: OUTPUT,
    width: 3840,
    height: 1620,
    bounds: BOUNDS,
    ...overrides,
  });
}

test('builds the Topaz baseline command as an argument vector (no shell string)', () => {
  const result = args({ hasAudio: true, audioCodec: 'aac' });

  assert.ok(Array.isArray(result));
  assert.ok(result.every((item) => typeof item === 'string'));
  assert.equal(result.at(-1), OUTPUT);

  assert.deepEqual(result.slice(0, 8), [
    '-hide_banner',
    '-nostdin',
    '-progress',
    'pipe:1',
    '-nostats',
    '-y',
    '-i',
    INPUT,
  ]);
  assert.deepEqual(result.slice(8, 16), [
    '-sws_flags',
    'spline+accurate_rnd+full_chroma_int',
    '-color_trc',
    '1',
    '-colorspace',
    '1',
    '-color_primaries',
    '1',
  ]);

  const filterIndex = result.indexOf('-filter_complex');
  assert.equal(
    result[filterIndex + 1],
    'tvai_up=model=prob-3:scale=0:w=3840:h=1620:preblur=-0.100659:noise=0.25:details=0.75:' +
      'halo=0.05:blur=0.25:compression=0.2:blend=0.6:device=0:vram=1:instances=1,' +
      'scale=w=3840:h=1620:flags=lanczos:threads=0,scale=out_color_matrix=bt709',
  );

  // Encoder block, verbatim from the baseline.
  assert.deepEqual(result.slice(filterIndex + 2, filterIndex + 26), [
    '-c:v', 'h264_nvenc',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-preset', 'p7',
    '-tune', 'hq',
    '-rc', 'constqp',
    '-qp', '25',
    '-rc-lookahead', '20',
    '-spatial_aq', '1',
    '-temporal_aq', '1',
    '-aq-strength', '15',
    '-b:v', '0',
  ]);

  assert.deepEqual(result.slice(-11), [
    '-map', '0:a',
    '-c:a', 'copy',
    '-bsf:a:0', 'aac_adtstoasc',
    '-map_metadata', '0',
    '-movflags',
    'frag_keyframe+empty_moov+delay_moov+use_metadata_tags+write_colr',
    OUTPUT,
  ]);
});

test('injects width/height into both scale operations and the tvai_up filter', () => {
  const filter = buildFilterComplex({ width: 1920, height: 1080, model: 'prob-3' });
  assert.match(filter, /tvai_up=model=prob-3:scale=0:w=1920:h=1080:/);
  assert.match(filter, /,scale=w=1920:h=1080:flags=lanczos:threads=0,/);
  assert.match(filter, /scale=out_color_matrix=bt709$/);

  const second = buildFilterComplex({ width: 3840, height: 1620, model: 'prob-3' });
  assert.match(second, /w=3840:h=1620/);
  assert.doesNotMatch(second, /1920|1080/);

  assert.deepEqual(buildScaleFilters({ width: 640, height: 360 }), [
    'scale=w=640:h=360:flags=lanczos:threads=0',
    'scale=out_color_matrix=bt709',
  ]);
});

test('Topaz filter defaults are immutable', () => {
  assert.ok(Object.isFrozen(TOPAZ_FILTER_DEFAULTS));
  assert.throws(() => {
    TOPAZ_FILTER_DEFAULTS.noise = 0.9;
  }, TypeError);
  assert.equal(buildTvaiFilter({ width: 128, height: 128 }).startsWith('tvai_up=model=prob-3:scale=0:w=128:h=128:preblur=-0.100659'), true);
});

test('audio arguments follow the baseline and degrade safely', () => {
  assert.deepEqual(buildAudioArguments({ hasAudio: true, audioCodec: 'aac' }), [
    '-map', '0:a', '-c:a', 'copy', '-bsf:a:0', 'aac_adtstoasc',
  ]);
  // "-map 0:a" makes ffmpeg fail on silent videos, so no audio args at all.
  assert.deepEqual(buildAudioArguments({ hasAudio: false, audioCodec: null }), []);
  // Unknown stream info: keep the mapping optional and skip the AAC-only filter.
  assert.deepEqual(buildAudioArguments({ hasAudio: null, audioCodec: null }), [
    '-map', '0:a?', '-c:a', 'copy',
  ]);
  // aac_adtstoasc errors out on non-AAC audio (verified against the real
  // Topaz binary: AC-3 + this filter -> "Task finished with error code: -22").
  assert.deepEqual(buildAudioArguments({ hasAudio: true, audioCodec: 'ac3' }), [
    '-map', '0:a', '-c:a', 'copy',
  ]);
  // Non mp4-safe codecs are re-encoded in auto mode.
  assert.deepEqual(buildAudioArguments({ hasAudio: true, audioCodec: 'vorbis' }), [
    '-map', '0:a', '-c:a', 'aac', '-b:a', '192k',
  ]);
  assert.deepEqual(buildAudioArguments({ hasAudio: true, audioCodec: 'vorbis', mode: 'copy' }), [
    '-map', '0:a', '-c:a', 'copy',
  ]);
  assert.deepEqual(buildAudioArguments({ hasAudio: true, audioCodec: 'aac', mode: 'reencode' }), [
    '-map', '0:a', '-c:a', 'aac', '-b:a', '192k',
  ]);

  const silent = args({ hasAudio: false, audioCodec: null });
  assert.equal(silent.includes('-map'), false);
  assert.equal(silent.includes('-c:a'), false);
  assert.equal(silent.includes('-bsf:a:0'), false);
});

test('rejects absurd or non-integer dimensions and unsafe model names', () => {
  assert.throws(() => args({ width: 15 }), /width must be between 16 and 7680/);
  assert.throws(() => args({ width: 7682 }), /width must be between 16 and 7680/);
  assert.throws(() => args({ width: 1281 }), /even number/);
  assert.throws(() => args({ height: 1081 }), /even number/);
  assert.throws(() => args({ width: 1280.5 }), /integer/);
  assert.throws(() => args({ width: '1280' }), /integer/);
  // Classic string-injection attempt through a numeric field.
  assert.throws(() => args({ width: '1280:x=1' }), /integer/);
  assert.throws(() => args({ model: 'prob-3:w=1,drawtext=text=owned' }), /model/i);
  assert.throws(() => buildFfmpegArgs({ width: 1280, height: 720, bounds: BOUNDS }), /input path/);
});

test('even dimensions can be disabled through configuration', () => {
  const result = args({ width: 1281, height: 1081, bounds: { ...BOUNDS, enforceEven: false } });
  const filter = result[result.indexOf('-filter_complex') + 1];
  assert.match(filter, /w=1281:h=1081/);
});

test('probe and self test argument builders stay shell-free', () => {
  assert.deepEqual(buildProbeArgs('C:\\VideoTemp\\x\\input.mkv'), [
    '-v', 'error',
    '-show_entries',
    'format=duration,format_name:stream=index,codec_type,codec_name,width,height,duration,nb_frames,avg_frame_rate,channels',
    '-of', 'json',
    'C:\\VideoTemp\\x\\input.mkv',
  ]);

  const selftest = buildModelSelftestArgs({ model: 'prob-3' });
  assert.ok(selftest.includes('-f'));
  assert.match(selftest.join(' '), /tvai_up=model=prob-3:scale=0:w=128:h=128/);
  assert.equal(selftest.at(-1), '-');
});

test('summary and classification of ffmpeg failures', () => {
  const tail = [
    "[Parsed_tvai_up_0 @ 000001C79821B000] Model not found: prob-3",
    '[Parsed_tvai_up_0 @ 000001C79821B000] Failed to configure output pad on Parsed_tvai_up_0',
    '[fc#0 @ 000001C7948DCA80] Error reinitializing filters!',
    '[fc#0 @ 000001C7948DCA80] Task finished with error code: -22 (Invalid argument)',
    '[fc#0 @ 000001C7948DCA80] Terminating thread with return code -22 (Invalid argument)',
    'Conversion failed!',
  ].join('\n');

  const summary = summarizeStderr(tail, 400);
  assert.match(summary, /Model not found: prob-3/);
  assert.doesNotMatch(summary, /Task finished with error code/);
  assert.doesNotMatch(summary, /Conversion failed/);

  const modelFailure = classifyFfmpegFailure(tail, 400);
  assert.equal(modelFailure.code, 'FFMPEG_ERROR');
  assert.match(modelFailure.message, /Topaz model is not available/);

  const nvenc = classifyFfmpegFailure('[h264_nvenc @ 0] Cannot load nvcuda.dll\nConversion failed!');
  assert.equal(nvenc.code, 'RENDERER_UNAVAILABLE');

  const unknown = classifyFfmpegFailure('something odd happened');
  assert.equal(unknown.code, 'FFMPEG_ERROR');
  assert.match(unknown.message, /FFmpeg exited with an error/);

  assert.equal(summarizeStderr(''), 'FFmpeg did not report any diagnostic output.');
  const long = summarizeStderr('x'.repeat(5000), 100);
  assert.equal(long.length <= 100, true);
});
