'use strict';

/**
 * Create-from-URL integration tests: the server downloads the video itself,
 * validates it and creates a job exactly like an upload does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { startTestServer } = require('../helpers/app');
const { assertResponseShape } = require('../helpers/openapi');

const VIDEO = Buffer.alloc(8192, 0x41);

/** Starts a throwaway HTTP server bound to loopback and returns its base URL. */
function startVideoServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function serveVideo(body = VIDEO, { status = 200, contentType = 'video/mp4', headers = {} } = {}) {
  return (req, res) => {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(body.length),
      ...headers,
    });
    res.end(body);
  };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('POST /api/v1/jobs/url downloads the video and creates a job', async (t) => {
  const video = await startVideoServer(serveVideo());
  t.after(() => closeServer(video.server));

  const server = await startTestServer({ urlAllowPrivateHosts: true });
  t.after(() => server.stop());

  const response = await server.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${video.url}/videos/sosul%20eater%20rev.mp4`,
      width: 3840,
      height: 1620,
    }),
  });

  assert.equal(response.status, 202);
  assertResponseShape(response.body, 'CreateJobResponse');
  assert.equal(response.body.status, 'queued');
  assert.equal(response.body.width, 3840);
  assert.equal(response.body.height, 1620);

  const jobId = response.body.id;
  const job = await server.waitForStatus(jobId, 'completed');
  assert.equal(job.original_filename, 'sosul eater rev.mp4');
  assert.equal(
    job.output_path,
    path.join(server.dirs.output, 'sosul eater rev_prob3_3840x1620.mp4'),
  );
  assert.equal(job.duration_seconds, 10);
});

test('create-from-URL follows redirects and accepts render options', async (t) => {
  const destination = await startVideoServer(serveVideo());
  t.after(() => closeServer(destination.server));
  const redirect = await startVideoServer((req, res) => {
    res.writeHead(302, { location: `${destination.url}/final.mp4` });
    res.end();
  });
  t.after(() => closeServer(redirect.server));

  const server = await startTestServer({ urlAllowPrivateHosts: true });
  t.after(() => server.stop());

  const response = await server.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${redirect.url}/start.mp4`,
      width: 3840,
      height: 1620,
      filename: 'my clip',
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.render.filename, 'my clip');
  assert.equal(response.body.render.label, '4K');

  const job = await server.waitForStatus(response.body.id, 'completed');
  assert.equal(job.original_filename, 'final.mp4');
  assert.equal(job.output_path, path.join(server.dirs.output, 'my clip 4K.mp4'));
});

test('private/loopback hosts are rejected unless explicitly allowed', async (t) => {
  const video = await startVideoServer(serveVideo());
  t.after(() => closeServer(video.server));

  const server = await startTestServer();
  t.after(() => server.stop());

  const response = await server.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${video.url}/clip.mp4`, width: 1280, height: 720 }),
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'URL_NOT_ALLOWED');
  assert.equal(server.repository.countAll({ status: 'queued' }), 0);
});

test('an unreachable or erroring URL becomes URL_DOWNLOAD_ERROR', async (t) => {
  const broken = await startVideoServer(serveVideo(Buffer.from('nope'), { status: 404 }));
  t.after(() => closeServer(broken.server));

  const server = await startTestServer({ urlAllowPrivateHosts: true });
  t.after(() => server.stop());

  const response = await server.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${broken.url}/missing.mp4`, width: 1280, height: 720 }),
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'URL_DOWNLOAD_ERROR');
});

test('oversized URL downloads are rejected (declared and streamed)', async (t) => {
  // 1. A declared Content-Length larger than the limit is rejected up front.
  const declared = await startVideoServer(serveVideo(Buffer.alloc(512 * 1024, 0x42)));
  t.after(() => closeServer(declared.server));

  const server = await startTestServer({
    urlAllowPrivateHosts: true,
    urlMaxSizeBytes: 64 * 1024,
  });
  t.after(() => server.stop());

  const known = await server.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${declared.url}/big.mp4`, width: 1280, height: 720 }),
  });
  assert.equal(known.status, 413);
  assert.equal(known.body.error.code, 'URL_DOWNLOAD_TOO_LARGE');
  assert.equal(known.body.error.details.maxSizeBytes, 64 * 1024);

  // 2. A chunked response without Content-Length is stopped by the stream guard.
  const chunked = await startVideoServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.write(Buffer.alloc(48 * 1024, 0x43));
    res.write(Buffer.alloc(48 * 1024, 0x44));
    res.end(Buffer.alloc(48 * 1024, 0x45));
  });
  t.after(() => closeServer(chunked.server));

  const streamed = await server.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${chunked.url}/big.mp4`, width: 1280, height: 720 }),
  });
  assert.equal(streamed.status, 413);
  assert.equal(streamed.body.error.code, 'URL_DOWNLOAD_TOO_LARGE');
});

test('URL job creation validates the body and respects ALLOW_URL_JOBS', async (t) => {
  const video = await startVideoServer(serveVideo());
  t.after(() => closeServer(video.server));

  const server = await startTestServer({ urlAllowPrivateHosts: true });
  t.after(() => server.stop());

  const missingDimensions = await server.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${video.url}/clip.mp4` }),
  });
  assert.equal(missingDimensions.status, 400);
  assert.equal(missingDimensions.body.error.code, 'VALIDATION_ERROR');

  const badUrl = await server.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'file:///etc/passwd', width: 1280, height: 720 }),
  });
  assert.equal(badUrl.status, 403);
  assert.equal(badUrl.body.error.code, 'URL_NOT_ALLOWED');

  const disabled = await startTestServer({ allowUrlJobs: false });
  t.after(() => disabled.stop());
  const rejected = await disabled.api('/api/v1/jobs/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${video.url}/clip.mp4`, width: 1280, height: 720 }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, 'URL_NOT_ALLOWED');

  const status = await server.api('/api/v1/system/status');
  assert.equal(status.body.thresholds.allowUrlJobs, true);
  assert.equal(status.body.thresholds.urlMaxSizeBytes, server.config.maxUploadSizeBytes);
});
