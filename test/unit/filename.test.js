'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
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
} = require('../../src/utils/filename');

test('stripDirectory removes every path component (path traversal)', () => {
  assert.equal(stripDirectory('../../../../evil.mp4'), 'evil.mp4');
  assert.equal(stripDirectory('..\\..\\evil.mp4'), 'evil.mp4');
  assert.equal(stripDirectory('C:\\Users\\me\\video.mp4'), 'video.mp4');
  assert.equal(stripDirectory('/etc/passwd'), 'passwd');
  assert.equal(stripDirectory('D:/Hasil Render/out.mp4'), 'out.mp4');
  assert.equal(stripDirectory('.'), '');
  assert.equal(stripDirectory('..'), '');
  assert.equal(stripDirectory(''), '');
});

test('sanitizeFilename produces Windows-safe basenames', () => {
  assert.equal(sanitizeFilename('sosul eater rev.mp4'), 'sosul eater rev.mp4');
  assert.equal(sanitizeFilename('a<b>c:d"e?f|g*i.mp4'), 'a_b_c_d_e_f_g_i.mp4');
  // Path separators are removed as directory structure, not turned into "_".
  assert.equal(sanitizeFilename('a/b\\c.mp4'), 'c.mp4');
  assert.equal(sanitizeFilename('trailing dots... .mp4'), 'trailing dots... .mp4'.replace(/[.\s]+$/, ''));
  assert.equal(sanitizeFilename('CON.mp4'), '_CON.mp4');
  assert.equal(sanitizeFilename('con'), '_con');
  assert.equal(sanitizeFilename('   '), 'video');
  assert.equal(sanitizeFilename('', { fallback: 'clip' }), 'clip');
  assert.equal(sanitizeFilename('한글 이름 영상.mp4'), '한글 이름 영상.mp4');
  assert.equal(sanitizeFilename('x'.repeat(300)).length, 120);
  assert.equal(sanitizeFilename('..\\..\\..\\evil.mp4'), 'evil.mp4');
});

test('sanitizeExtension only accepts short alphanumeric extensions', () => {
  assert.equal(sanitizeExtension('.MP4'), '.mp4');
  assert.equal(sanitizeExtension('mp4'), '.mp4');
  assert.equal(sanitizeExtension('.m2ts'), '.m2ts');
  assert.equal(sanitizeExtension('.'), '');
  assert.equal(sanitizeExtension('.toolong'), '');
  assert.equal(sanitizeExtension('.exe.txt'), '', 'only a real extension is accepted');
  assert.equal(sanitizeExtension('../etc'), '');
});

test('buildOutputFilename follows the documented naming scheme', () => {
  assert.equal(
    buildOutputFilename({ originalFilename: 'sosul eater rev.mp4', width: 3840, height: 1620 }),
    'sosul eater rev_prob3_3840x1620.mp4',
  );
  assert.equal(
    buildOutputFilename({ originalFilename: '../../evil.mkv', width: 1920, height: 1080 }),
    'evil_prob3_1920x1080.mp4',
  );
  assert.equal(
    buildOutputFilename({ originalFilename: 'bad:name?*.mov', width: 1280, height: 720 }),
    'bad_name___prob3_1280x720.mp4',
  );
  assert.equal(
    buildOutputFilename({ originalFilename: 'clip.mp4', width: 1280, height: 720, model: 'prob-4' }),
    'clip_prob4_1280x720.mp4',
  );
  assert.equal(modelSlug('prob-3'), 'prob3');
  assert.equal(removeExtension('a.b.mp4'), 'a.b');
  assert.equal(insertSuffix('a_prob3_1x1.mp4', 'abc-1'), 'a_prob3_1x1_abc-1.mp4');
  assert.equal(isRenderingTempFile('.abc.rendering.mp4'), true);
  assert.equal(isRenderingTempFile('final.mp4'), false);
  assert.equal(formatBytes(1536), '1.50 KiB');
});

test('reserveUniqueOutputPath never reuses an existing filename', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vua-naming-'));
  try {
    const first = await reserveUniqueOutputPath(dir, 'movie_prob3_3840x1620.mp4', { suffix: '7f3a9c21' });
    assert.equal(first.filename, 'movie_prob3_3840x1620.mp4');

    const second = await reserveUniqueOutputPath(dir, 'movie_prob3_3840x1620.mp4', { suffix: '7f3a9c21' });
    assert.notEqual(second.filename, first.filename);
    assert.match(second.filename, /^movie_prob3_3840x1620_7f3a9c21-\d+\.mp4$/);

    // Both placeholders exist (the caller renames over them).
    const entries = await fsp.readdir(dir);
    assert.equal(entries.length, 2);

    // An existing real file (not just a placeholder) is respected too.
    await fsp.writeFile(path.join(dir, 'other_prob3_640x360.mp4'), 'rendered');
    const third = await reserveUniqueOutputPath(dir, 'other_prob3_640x360.mp4', { suffix: 'abcd1234' });
    assert.match(third.filename, /^other_prob3_640x360_abcd1234-\d+\.mp4$/);
    assert.equal(await fsp.readFile(path.join(dir, 'other_prob3_640x360.mp4'), 'utf8'), 'rendered');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('renameWithRetry moves the render over the reserved placeholder', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vua-rename-'));
  try {
    const temp = path.join(dir, `.${randomUUID()}.rendering.mp4`);
    await fsp.writeFile(temp, 'rendered-bytes');
    const reservation = await reserveUniqueOutputPath(dir, 'final_prob3_1280x720.mp4', { suffix: 'x' });
    await renameWithRetry(temp, reservation.path);

    assert.equal(await fsp.readFile(reservation.path, 'utf8'), 'rendered-bytes');
    const entries = await fsp.readdir(dir);
    assert.equal(entries.length, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
