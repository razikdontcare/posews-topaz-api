'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FfmpegProgressParser,
  computeProgressPercent,
  parseTimecode,
} = require('../../src/utils/ffmpeg-progress');

function collect(chunks) {
  const updates = [];
  const parser = new FfmpegProgressParser();
  for (const chunk of chunks) updates.push(...parser.push(chunk));
  return { parser, updates };
}

test('parses a complete progress block (AGENTS.md §36 example)', () => {
  const { updates, parser } = collect([
    'frame=123\nfps=30\nout_time_ms=5000000\nspeed=0.8x\nprogress=continue\n',
  ]);

  assert.equal(updates.length, 1);
  const update = updates[0];
  assert.equal(update.frame, 123);
  assert.equal(update.fps, 30);
  assert.equal(update.elapsedSeconds, 5); // out_time_ms is microseconds in ffmpeg
  assert.equal(update.speed, '0.8x');
  assert.equal(update.speedNumeric, 0.8);
  assert.equal(update.progress, 'continue');
  assert.deepEqual(parser.snapshot(), update);
});

test('parses a realistic ffmpeg block in any field order', () => {
  const { updates } = collect([
    'speed=1.02x\n',
    'bitrate=1234.5kbits/s\n',
    'stream_0_0_q=25.0\n',
    'total_size=1048576\n',
    'out_time_us=513000000\n',
    'out_time_ms=513000\n',
    'dup_frames=0\n',
    'drop_frames=2\n',
    'fps=31.4\n',
    'frame=12842\n',
    'out_time=00:08:33.00\n',
    'progress=continue\n',
  ]);

  const update = updates.at(-1);
  assert.equal(update.frame, 12842);
  assert.equal(update.fps, 31.4);
  assert.equal(update.elapsedSeconds, 513);
  assert.equal(update.outTime, 513);
  assert.equal(update.totalSize, 1048576);
  assert.equal(update.bitrate, '1234.5kbits/s');
  assert.equal(update.dupFrames, 0);
  assert.equal(update.dropFrames, 2);
  assert.equal(update.speed, '1.02x');
});

test('out_time wins over the microsecond fields, and unreachable values are kept', () => {
  const parser = new FfmpegProgressParser();
  parser.push('out_time=00:00:10.50\nout_time_us=999000000\nprogress=continue\n');
  assert.equal(parser.snapshot().elapsedSeconds, 10.5);

  // N/A at the start of a stream must not destroy the previous value.
  parser.push('out_time=00:00:20.00\nprogress=continue\n');
  assert.equal(parser.snapshot().elapsedSeconds, 20);
  const updates = parser.push('out_time=N/A\nfps=N/A\nframe=60\nprogress=continue\n');
  assert.equal(updates.at(-1).elapsedSeconds, 20);
  assert.equal(updates.at(-1).fps, null);
  assert.equal(updates.at(-1).frame, 60);
});

test('tolerates malformed lines, unknown keys, CRLF, blank lines and split chunks', () => {
  const parser = new FfmpegProgressParser();
  const first = parser.push('frame=30\r\nfps=30.0\r\nthis is not a key value line\r\n\r\n');
  assert.deepEqual(first, []); // nothing is emitted until a `progress=` line arrives

  const second = parser.push('total_size=abc\r\nout_time=garbage\r\nprogress=continue\r\n');
  assert.equal(second.length, 1);
  assert.equal(second[0].frame, 30);
  assert.equal(second[0].elapsedSeconds, null);
  assert.equal(second[0].totalSize, null);

  // A block split across TCP chunks.
  const third = [];
  third.push(...parser.push('fra'));
  third.push(...parser.push('me=90\nprogress=continue\n'));
  assert.equal(third.at(-1).frame, 90);

  // An unknown key is counted, but never breaks the parser.
  const unknown = parser.push('totally_unknown_key=5\nframe=91\nprogress=continue\n');
  assert.equal(unknown.at(-1).frame, 91);
  assert.ok(parser.malformedLines >= 1);
});

test('handles progress=end and huge unterminated lines without growing memory', () => {
  const parser = new FfmpegProgressParser({ maxLineLength: 256 });
  const updates = parser.push('frame=1\nprogress=continue\nframe=2\nprogress=end\n');
  assert.equal(updates.length, 2);
  assert.equal(updates.at(-1).progress, 'end');

  const growing = new FfmpegProgressParser({ maxLineLength: 128 });
  for (let index = 0; index < 50; index += 1) growing.push('x'.repeat(1000));
  assert.ok(growing.buffer.length < 128);
  assert.equal(growing.push('frame=5\nprogress=continue\n').at(-1).frame, 5);
});

test('a burst of progress blocks arriving in one chunk is not lost', () => {
  // A busy event loop can deliver several seconds of progress output at once.
  const block = [
    'frame=30',
    'fps=30.0',
    'total_size=1048576',
    'out_time_us=1000000',
    'out_time=00:00:01.00',
    'speed=1.0x',
    'progress=continue',
    '',
  ].join('\n');

  const parser = new FfmpegProgressParser();
  const updates = parser.push(block.repeat(200));
  assert.equal(updates.length, 200, 'every complete block must be parsed');
  assert.equal(updates.at(-1).frame, 30);
  assert.equal(parser.malformedLines, 0);

  // ...and exactly the same when the very same bytes arrive in small chunks.
  const chunked = new FfmpegProgressParser();
  let count = 0;
  for (const chunk of block.repeat(200).match(/[\s\S]{1,64}/g)) {
    count += chunked.push(chunk).length;
  }
  assert.equal(count, 200);
});

test('a throwing progress listener never breaks the parser', () => {
  const parser = new FfmpegProgressParser({
    onUpdate() {
      throw new Error('listener exploded');
    },
    logger: { warn() {} },
  });
  const updates = parser.push('frame=1\nprogress=continue\n');
  assert.equal(updates.length, 1);
});

test('computeProgressPercent clamps to 0..100 and ignores unknown durations', () => {
  assert.equal(computeProgressPercent(513, 1072), 47.85);
  assert.equal(computeProgressPercent(2000, 1000), 100); // never trust a value above 100
  assert.equal(computeProgressPercent(-5, 1000), 0);
  assert.equal(computeProgressPercent(100, null), null);
  assert.equal(computeProgressPercent(100, 0), null);
  assert.equal(computeProgressPercent(null, 100), null);
  assert.equal(computeProgressPercent(0, 100), 0);
});

test('parseTimecode understands HH:MM:SS.ss and plain seconds', () => {
  assert.equal(parseTimecode('00:08:33.00'), 513);
  assert.equal(parseTimecode('01:00:00.500'), 3600.5);
  assert.equal(parseTimecode('12'), 12);
  assert.equal(parseTimecode('N/A'), null);
  assert.equal(parseTimecode(''), null);
});
