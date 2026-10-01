'use strict';

/**
 * Unit tests for the remote-URL helpers: URL parsing rules and the SSRF
 * address classification/allow decision.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertHostAllowed,
  extensionFromContentType,
  filenameFromContentDisposition,
  filenameFromUrl,
  isObviousNonVideoContentType,
  isPrivateAddress,
  parseTargetUrl,
  videoExtensionFromUrl,
} = require('../../src/utils/url');

const ALLOWED = new Set(['mp4', 'mkv', 'mov', 'webm', 'm4v', 'avi', 'ts']);

test('parseTargetUrl accepts absolute http(s) URLs', () => {
  const url = parseTargetUrl('https://example.com/a/b/video.mp4');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'example.com');
});

test('parseTargetUrl rejects non-http schemes, credentials and junk', () => {
  for (const value of ['file:///C:/x.mp4', 'ftp://example.com/x.mp4', 'javascript:alert(1)']) {
    assert.throws(() => parseTargetUrl(value), (error) => error.code === 'URL_NOT_ALLOWED');
  }
  assert.throws(() => parseTargetUrl('http://user:pass@example.com/x.mp4'), (error) =>
    error.code === 'INVALID_URL');
  assert.throws(() => parseTargetUrl('not a url'), (error) => error.code === 'INVALID_URL');
  assert.throws(() => parseTargetUrl(''), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => parseTargetUrl(undefined), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => parseTargetUrl(42), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => parseTargetUrl(`https://example.com/${'a'.repeat(3000)}`), (error) =>
    error.code === 'INVALID_URL');
});

test('isPrivateAddress classifies private, loopback and public addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.3.4',
    '192.168.1.1',
    '169.254.10.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
  assert.equal(isPrivateAddress('not-an-ip'), true, 'unknown values are treated as unsafe');
});

test('assertHostAllowed blocks loopback/private hosts and allows explicit opt-in', async () => {
  await assert.rejects(
    assertHostAllowed('localhost'),
    (error) => error.code === 'URL_NOT_ALLOWED',
  );
  await assert.rejects(
    assertHostAllowed('127.0.0.1'),
    (error) => error.code === 'URL_NOT_ALLOWED',
  );
  // A name that resolves to a private address is rejected...
  await assert.rejects(
    assertHostAllowed('internal.example', {
      lookup: async () => [{ address: '10.1.2.3', family: 4 }],
    }),
    (error) => error.code === 'URL_NOT_ALLOWED',
  );
  // ...and a public one is allowed.
  const addresses = await assertHostAllowed('cdn.example', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.deepEqual(addresses, ['93.184.216.34']);
  // The opt-in bypasses the check entirely.
  assert.deepEqual(await assertHostAllowed('127.0.0.1', { allowPrivate: true }), []);
});

test('assertHostAllowed reports unresolvable hosts as a download error', async () => {
  await assert.rejects(
    assertHostAllowed('missing.example', {
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    }),
    (error) => error.code === 'URL_DOWNLOAD_ERROR',
  );
});

test('extension and filename helpers read the URL and headers', () => {
  assert.equal(
    videoExtensionFromUrl(new URL('https://cdn.example/a/My%20Clip.MP4'), ALLOWED),
    '.mp4',
  );
  assert.equal(videoExtensionFromUrl(new URL('https://cdn.example/a/clip.txt'), ALLOWED), null);
  assert.equal(videoExtensionFromUrl(new URL('https://cdn.example/a/noext'), ALLOWED), null);

  assert.equal(extensionFromContentType('video/x-matroska; codecs=avc1', ALLOWED), '.mkv');
  assert.equal(extensionFromContentType('text/html', ALLOWED), null);

  assert.equal(filenameFromUrl(new URL('https://cdn.example/a/My%20Clip.mp4')), 'My Clip.mp4');
  assert.equal(
    filenameFromContentDisposition('attachment; filename="sosul eater rev.mp4"'),
    'sosul eater rev.mp4',
  );
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''sosul%20eater.mp4"),
    'sosul eater.mp4',
  );
  // Path components in a header are stripped, never used as a path.
  assert.equal(filenameFromContentDisposition('attachment; filename="../../evil.mp4"'), 'evil.mp4');

  assert.equal(isObviousNonVideoContentType('text/html; charset=utf-8'), true);
  assert.equal(isObviousNonVideoContentType('application/json'), true);
  assert.equal(isObviousNonVideoContentType('video/mp4'), false);
  assert.equal(isObviousNonVideoContentType(''), false);
});
