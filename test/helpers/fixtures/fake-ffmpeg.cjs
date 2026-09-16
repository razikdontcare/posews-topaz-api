'use strict';
/*
 * Fake "Topaz ffmpeg" used by the test suite so the full render pipeline can be
 * exercised without an NVIDIA GPU (see `resolveCommand()` in utils/process.js).
 *
 * Behaviour is controlled with environment variables:
 *   FAKE_FFMPEG_MODE          success | fail | fail-nvenc | fail-model | no-output | hang | missing-caps | slow-write
 *   FAKE_FFMPEG_DURATION      media duration used for the progress blocks (s)
 *   FAKE_FFMPEG_STEPS         number of progress blocks emitted
 *   FAKE_FFMPEG_DELAY_MS      delay between progress blocks
 *   FAKE_FFMPEG_OUTPUT_BYTES  size of the rendered file
 *   FAKE_FFMPEG_FORCE         force a specific exit code
 */

const fs = require('node:fs');

const args = process.argv.slice(2);
const mode = process.env.FAKE_FFMPEG_MODE || 'success';
const log = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

/** Records every invocation so tests can assert the exact argument vector. */
function recordInvocation(kind) {
  const file = process.env.FAKE_FFMPEG_ARGS_FILE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ kind, args })}\n`);
  } catch {
    /* the recording is best effort */
  }
}

recordInvocation(
  args.includes('-version')
    ? 'version'
    : args.includes('-filters')
      ? 'filters'
      : args.includes('-encoders')
        ? 'encoders'
        : args.at(-1) === '-'
          ? 'selftest'
          : 'render',
);

// ---- capability queries (startup validation) -------------------------------
if (args.includes('-version')) {
  log('ffmpeg version 7.1-fake-topaz Copyright (c) 2000-2026 the FFmpeg developers');
  log('configuration: --enable-cuda-nvcc --enable-nvenc');
  if (mode === 'missing-caps') process.exit(1);
  process.exit(0);
}
if (args.includes('-filters')) {
  if (mode === 'missing-caps') {
    err('T. tvai_fi           V->V       Apply Topaz Video AI frame interpolation models.');
    process.exit(0);
  }
  log('T. tvai_up           V->V       Apply Topaz Video AI upscale models, parameters will only be applied to appropriate models');
  log('T. tvai_fi           V->V       Apply Topaz Video AI frame interpolation models.');
  process.exit(0);
}
if (args.includes('-encoders')) {
  if (mode === 'missing-caps') {
    err(' V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10');
    process.exit(0);
  }
  log(' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)');
  log(' V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10');
  process.exit(0);
}

// ---- render / self test ----------------------------------------------------
const output = args[args.length - 1];
// Self tests write to the `null` muxer (their last argument is `-`); a real render
// writes to the reserved temp output path.
const isSelfTest = output === '-';

if (mode === 'hang') {
  // Stays alive until it is killed (cancellation tests).
  const tick = setInterval(() => {
    log('frame=1');
    log('fps=1.0');
    log(`out_time_us=${Date.now() % 1000000}`);
    log('out_time=00:00:01.00');
    log('speed=0.1x');
    log('progress=continue');
  }, 100);
  tick.unref?.();
  setInterval(() => {}, 60000); // keep the event loop alive
  return;
}

if (mode === 'slow-write') {
  setTimeout(() => {
    if (!isSelfTest) {
      try {
        fs.writeFileSync(output, Buffer.alloc(Number(process.env.FAKE_FFMPEG_OUTPUT_BYTES || 2048), 7));
      } catch (error) {
        err(`could not write output: ${error.message}`);
        process.exit(2);
      }
    }
    process.exit(0);
  }, Number(process.env.FAKE_FFMPEG_DELAY_MS || 200));
  return;
}

if (isSelfTest) {
  // The model self test runs `tvai_up`; the NVENC self test encodes a frame.
  const isModelSelftest = args.some((arg) => arg.includes('tvai_up'));

  if (mode === 'fail-nvenc' && !isModelSelftest) {
    err('[h264_nvenc @ 000001F0F01BBFC0] Cannot load nvcuda.dll');
    err('[vost#0:0/h264_nvenc @ 000001F0F016D640] Error while opening encoder');
    err('Conversion failed!');
    process.exit(1);
  }
  if (mode === 'fail-model' && isModelSelftest) {
    err('[Parsed_tvai_up_0 @ 0000020D410CED80] Model not found: prob-3');
    err('[fc#0 @ 0000020D410CED80] Error reinitializing filters!');
    err('Conversion failed!');
    process.exit(1);
  }
  // Any other combination passes (e.g. the model check when NVENC already failed).
  process.exit(0);
}

const duration = Number(process.env.FAKE_FFMPEG_DURATION || 10);
const steps = Math.max(1, Number(process.env.FAKE_FFMPEG_STEPS || 5));
const stepDelay = Number(process.env.FAKE_FFMPEG_DELAY_MS || 0);

err(`Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '${args[args.indexOf('-i') + 1] || 'unknown'}':`);
err(`  Duration: 00:00:${String(Math.trunc(duration)).padStart(2, '0')}.00, start: 0.000000, bitrate: 676 kb/s`);
err('Stream mapping:');
err('  Stream #0:0 -> #0:0 (h264 (native) -> h264 (h264_nvenc))');

let step = 0;
const emit = () => {
  step += 1;
  const elapsed = (duration * step) / steps;
  log(`frame=${step * 30}`);
  log('fps=30.0');
  log(`stream_0_0_q=25.0`);
  log(`bitrate=1234.5kbits/s`);
  log(`total_size=${Math.round((elapsed / duration) * 1024 * 1024)}`);
  log(`out_time_us=${Math.round(elapsed * 1e6)}`);
  log(`out_time_ms=${Math.round(elapsed * 1e6)}`);
  const seconds = Math.trunc(elapsed);
  const fraction = String(Math.round((elapsed - seconds) * 100)).padStart(2, '0');
  const hh = String(Math.trunc(seconds / 3600)).padStart(2, '0');
  const mm = String(Math.trunc((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  log(`out_time=${hh}:${mm}:${ss}.${fraction}`);
  log('dup_frames=0');
  log('drop_frames=0');
  log('speed=1.00x');
  log(`progress=${step >= steps ? 'end' : 'continue'}`);
  log('');

  if (step >= steps) {
    if (mode === 'fail') {
      err('[h264_nvenc @ 000001F0F01BBFC0] Cannot load nvcuda.dll');
      err('[vost#0:0/h264_nvenc @ 000001F0F016D640] Error while opening encoder - maybe incorrect parameters');
      err('Conversion failed!');
      process.exit(Number(process.env.FAKE_FFMPEG_FORCE || 1));
    }
    if (mode === 'fail-model') {
      err('[Parsed_tvai_up_0 @ 0000020D410CED80] Model not found: prob-3');
      err('Conversion failed!');
      process.exit(1);
    }
    if (mode === 'no-output') {
      err('Everything looked fine but nothing was written.');
      process.exit(0);
    }
    try {
      fs.writeFileSync(
        output,
        Buffer.alloc(Number(process.env.FAKE_FFMPEG_OUTPUT_BYTES || 4096), 42),
      );
    } catch (error) {
      err(`could not write output: ${error.message}`);
      process.exit(2);
    }
    process.exit(Number(process.env.FAKE_FFMPEG_FORCE || 0));
    return;
  }
  setTimeout(emit, stepDelay);
};

emit();
