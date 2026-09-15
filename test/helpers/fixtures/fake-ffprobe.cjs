'use strict';
/*
 * Fake "Topaz ffprobe" used by the test suite (see `resolveCommand()` in
 * utils/process.js).
 *
 *   FAKE_FFPROBE_MODE             ok | invalid | hang
 *   FAKE_FFPROBE_DURATION         duration reported for format/streams
 *   FAKE_FFPROBE_AUDIO            0/1, default: no audio when the path contains "silent"
 *   FAKE_FFPROBE_VIDEO            0 = report an audio-only file
 *   FAKE_FFPROBE_AUDIO_CODEC      codec name for the audio stream (default aac)
 *   FAKE_FFPROBE_NO_FORMAT_DURATION  report format.duration as N/A
 */

const args = process.argv.slice(2);
const mode = process.env.FAKE_FFPROBE_MODE || 'ok';

if (args.includes('-version')) {
  process.stdout.write('ffprobe version 7.1-fake-topaz Copyright (c) 2007-2026 the FFmpeg developers\n');
  process.exit(0);
}

if (mode === 'invalid') {
  process.stderr.write('moov atom not found\n');
  process.stderr.write('input.mp4: Invalid data found when processing input\n');
  process.exit(1);
}
if (mode === 'hang') {
  setInterval(() => {}, 60000);
}

const input = args[args.length - 1] || 'input.mp4';
const duration = Number(process.env.FAKE_FFPROBE_DURATION || 10);
const hasAudio =
  process.env.FAKE_FFPROBE_AUDIO === undefined
    ? !/silent/i.test(input)
    : process.env.FAKE_FFPROBE_AUDIO === '1';
const formatDuration =
  process.env.FAKE_FFPROBE_NO_FORMAT_DURATION === '1' || process.env.FAKE_FFPROBE_NO_FORMAT_DURATION === 'true'
    ? 'N/A'
    : String(duration);

const streams = [];
if (process.env.FAKE_FFPROBE_VIDEO !== '0') {
  streams.push({
    index: 0,
    codec_type: 'video',
    codec_name: 'h264',
    width: 640,
    height: 480,
    duration: String(process.env.FAKE_FFPROBE_NO_STREAM_DURATION === '1' ? 'N/A' : duration),
    avg_frame_rate: '30/1',
  });
}
if (hasAudio) {
  streams.push({
    index: streams.length,
    codec_type: 'audio',
    codec_name: process.env.FAKE_FFPROBE_AUDIO_CODEC || 'aac',
    duration: String(duration),
    channels: 2,
  });
}

process.stdout.write(
  JSON.stringify(
    {
      streams,
      format: {
        filename: input,
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: formatDuration,
      },
    },
    null,
    2,
  ),
);
process.stdout.write('\n');
process.exit(0);
