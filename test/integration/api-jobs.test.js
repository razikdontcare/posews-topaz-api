'use strict';

/**
 * HTTP contract tests: upload -> job response, listing, progress polling,
 * cancel/delete rules and error shapes (AGENTS.md §6, §22, §23, §26, §41).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { startTestServer, setRendererEnv } = require('../helpers/app');
const { uploadVideo } = require('../helpers/multipart');

const SMALL = [Buffer.alloc(4096, 0x41)];

test('health and system status endpoints', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const health = await server.api('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.service, 'video-upscaler-api');

  const status = await server.api('/api/v1/system/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.renderer.available, true);
  assert.equal(status.body.renderer.ffmpeg, true);
  assert.equal(status.body.renderer.ffprobe, true);
  assert.equal(status.body.renderer.tvaiUp, true);
  assert.equal(status.body.renderer.status, 'available');
  assert.equal(status.body.queue.concurrency, 1);
  assert.equal(status.body.queue.queued, 0);
  assert.equal(status.body.queue.processing, false);
  assert.equal(status.body.queue.activeJobId, null);
  assert.equal(typeof status.body.jobs.counts.queued, 'number');
});

test('POST /api/v1/jobs streams an upload and answers 202 immediately', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  // Keep the render slow so the response is clearly returned before it finishes.
  setRendererEnv({ FAKE_FFMPEG_MODE: 'slow-write', FAKE_FFMPEG_DELAY_MS: '1500' });

  const started = Date.now();
  const response = await uploadVideo(server.baseUrl, {
    fields: { width: 3840, height: 1620 },
    filename: 'sosul eater rev.mp4',
    chunks: SMALL,
  });
  const elapsed = Date.now() - started;

  assert.equal(response.status, 202);
  assert.match(response.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(response.body.width, 3840);
  assert.equal(response.body.height, 1620);
  assert.equal(response.body.position, 1);
  assert.ok(['queued', 'processing'].includes(response.body.status));
  assert.ok(elapsed < 1200, `response must not wait for ffmpeg (took ${elapsed}ms)`);

  const job = await server.waitForJob(response.body.id, (row) => row.pid > 0, 'ffmpeg pid');
  assert.equal(job.original_filename, 'sosul eater rev.mp4');
  assert.equal(job.status, 'processing');
  assert.equal(job.progress_percent, 0);

  await server.waitForStatus(response.body.id, 'completed');
});

test('GET /api/v1/jobs/:id/progress is cheap and reflects the render state', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const created = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: SMALL,
  });
  assert.equal(created.status, 202);
  const jobId = created.body.id;

  const queuedOrProcessing = await server.api(`/api/v1/jobs/${jobId}/progress`);
  assert.equal(queuedOrProcessing.status, 200);
  assert.equal(queuedOrProcessing.body.id, jobId);
  assert.equal(queuedOrProcessing.body.duration, 10);
  assert.equal(typeof queuedOrProcessing.body.progress, 'number');

  const finished = await server.waitForStatus(jobId, 'completed');
  const progress = await server.api(`/api/v1/jobs/${jobId}/progress`);
  assert.equal(progress.status, 200);
  assert.deepEqual(Object.keys(progress.body).sort(), [
    'completed', 'duration', 'elapsed', 'fps', 'frame', 'id', 'output', 'progress', 'speed', 'status',
  ]);
  assert.equal(progress.body.status, 'completed');
  assert.equal(progress.body.progress, 100);
  assert.equal(progress.body.completed, true);
  assert.equal(progress.body.output.filename, 'input_prob3_1280x720.mp4');
  assert.equal(finished.output_path, path.join(server.dirs.output, 'input_prob3_1280x720.mp4'));

  // Polling must not spawn anything: the fake binaries are the only ffmpeg-ish
  // processes and they are gone once the job finished.
  const before = server.repository.findById(jobId).updated_at;
  await server.api(`/api/v1/jobs/${jobId}/progress`);
  assert.equal(server.repository.findById(jobId).updated_at, before, 'reads do not write');
});

test('GET /api/v1/jobs lists with pagination and queue positions', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_MODE: 'slow-write', FAKE_FFMPEG_DELAY_MS: '400' });
  const created = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await uploadVideo(server.baseUrl, {
      fields: { width: 1280, height: 720 },
      filename: `clip-${index}.mp4`,
      chunks: SMALL,
    });
    assert.equal(response.status, 202);
    created.push(response.body);
  }

  assert.deepEqual(created.map((job) => job.position), [1, 2, 3]);

  const list = await server.api('/api/v1/jobs?page=1&limit=2');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 2);
  assert.deepEqual(list.body.pagination, { page: 1, limit: 2, total: 3, totalPages: 2 });
  assert.equal(list.body.data[0].input.filename, 'clip-2.mp4');

  const secondPage = await server.api('/api/v1/jobs?page=2&limit=2');
  assert.equal(secondPage.body.data.length, 1);

  const queued = await server.api('/api/v1/jobs?status=queued');
  assert.equal(queued.body.data.every((job) => job.status === 'queued'), true);
  assert.equal(typeof queued.body.data[0].queuePosition, 'number');

  const filtered = await server.api('/api/v1/jobs?status=nonsense');
  assert.equal(filtered.status, 400);
  assert.equal(filtered.body.error.code, 'VALIDATION_ERROR');

  const badPage = await server.api('/api/v1/jobs?page=0');
  assert.equal(badPage.status, 400);

  await Promise.all(created.map((job) => server.waitForStatus(job.id, 'completed')));
});

test('GET /api/v1/jobs/:id returns the documented detail shape', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const created = await uploadVideo(server.baseUrl, {
    fields: { width: 1920, height: 1080 },
    filename: 'holiday.mov',
    chunks: SMALL,
  });
  const jobId = created.body.id;
  await server.waitForStatus(jobId, 'completed');

  const detail = await server.api(`/api/v1/jobs/${jobId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(Object.keys(detail.body).sort(), [
    'error', 'id', 'input', 'output', 'progress', 'resolution', 'status', 'timestamps',
  ]);
  assert.equal(detail.body.id, jobId);
  assert.equal(detail.body.status, 'completed');
  assert.deepEqual(detail.body.input, { filename: 'holiday.mov' });
  assert.deepEqual(detail.body.resolution, { width: 1920, height: 1080 });
  assert.equal(detail.body.progress.percent, 100);
  assert.equal(detail.body.progress.durationSeconds, 10);
  assert.equal(detail.body.output.filename, 'holiday_prob3_1920x1080.mp4');
  assert.equal(detail.body.error, null);
  assert.match(detail.body.timestamps.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.ok(detail.body.timestamps.completedAt);
  assert.equal(detail.body.timestamps.startedAt !== null, true);
  // Filesystem paths are never exposed.
  assert.equal(JSON.stringify(detail.body).includes(server.dirs.temp), false);
  assert.equal(JSON.stringify(detail.body).includes(server.dirs.output), false);
});

test('failed renders expose a structured error', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_MODE: 'fail' });
  const created = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: SMALL,
  });
  const jobId = created.body.id;

  const failed = await server.waitForStatus(jobId, 'failed');
  assert.equal(failed.error_code, 'RENDERER_UNAVAILABLE');
  assert.match(failed.error_message, /Cannot load nvcuda\.dll/);

  const detail = await server.api(`/api/v1/jobs/${jobId}`);
  assert.equal(detail.body.error.code, 'RENDERER_UNAVAILABLE');
  assert.equal(detail.body.output, null);

  const progress = await server.api(`/api/v1/jobs/${jobId}/progress`);
  assert.equal(progress.body.status, 'failed');
  assert.equal(progress.body.error.code, 'RENDERER_UNAVAILABLE');

  // A failed job cannot be downloaded.
  const download = await server.api(`/api/v1/jobs/${jobId}/download`);
  assert.equal(download.status, 409);
  assert.equal(download.body.error.code, 'JOB_NOT_COMPLETED');
});

test('GET /api/v1/jobs/:id/download streams the rendered file', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_OUTPUT_BYTES: '8192' });
  const created = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    filename: 'stream me.mp4',
    chunks: SMALL,
  });
  const jobId = created.body.id;
  await server.waitForStatus(jobId, 'completed');

  const response = await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}/download`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /video\/mp4/);
  assert.equal(response.headers.get('content-length'), '8192');
  assert.match(response.headers.get('content-disposition'), /attachment;/);
  assert.match(response.headers.get('content-disposition'), /stream me_prob3_1280x720\.mp4/);

  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, 8192);
  assert.equal(body.every((byte) => byte === 42), true, 'streams the rendered bytes');

  // Range requests keep working (sendFile streams, nothing is buffered).
  const ranged = await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}/download`, {
    headers: { range: 'bytes=0-99' },
  });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  // The file is still there afterwards.
  const listed = await server.api(`/api/v1/jobs/${jobId}`);
  assert.equal(listed.body.status, 'completed');
});

test('cancel rules: queued and active jobs, and completed ones', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_MODE: 'slow-write', FAKE_FFMPEG_DELAY_MS: '1200' });
  const first = await uploadVideo(server.baseUrl, { fields: { width: 1280, height: 720 }, chunks: SMALL });
  const second = await uploadVideo(server.baseUrl, { fields: { width: 1280, height: 720 }, chunks: SMALL });
  await server.waitForStatus(first.body.id, 'processing');

  const cancelQueued = await server.api(`/api/v1/jobs/${second.body.id}/cancel`, { method: 'POST' });
  assert.equal(cancelQueued.status, 200);
  assert.equal(cancelQueued.body.status, 'cancelled');
  assert.equal(server.queue.isPending(second.body.id), false);

  const cancelActive = await server.api(`/api/v1/jobs/${first.body.id}/cancel`, { method: 'POST' });
  assert.equal(cancelActive.status, 200);
  assert.equal(cancelActive.body.status, 'cancelled');
  assert.equal(server.renderService.isActive(first.body.id), false);

  // Cancelling twice is refused with the documented error.
  const again = await server.api(`/api/v1/jobs/${second.body.id}/cancel`, { method: 'POST' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'JOB_NOT_CANCELLABLE');
});

test('delete rules protect queued/active jobs and remove the row for finished ones', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_MODE: 'slow-write', FAKE_FFMPEG_DELAY_MS: '1000' });
  const running = await uploadVideo(server.baseUrl, { fields: { width: 1280, height: 720 }, chunks: SMALL });
  await server.waitForStatus(running.body.id, 'processing');

  const denied = await server.api(`/api/v1/jobs/${running.body.id}`, { method: 'DELETE' });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, 'JOB_ACTIVE');
  assert.ok(server.repository.findById(running.body.id), 'the row is still there');

  const finished = await uploadVideo(server.baseUrl, { fields: { width: 640, height: 360 }, chunks: SMALL });
  await server.api(`/api/v1/jobs/${finished.body.id}/cancel`, { method: 'POST' });

  const deleted = await server.api(`/api/v1/jobs/${finished.body.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { id: finished.body.id, deleted: true, outputDeleted: false });
  assert.equal(server.repository.findById(finished.body.id), undefined);

  const missing = await server.api('/api/v1/jobs/does-not-exist', { method: 'DELETE' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'JOB_NOT_FOUND');
});

test('unknown routes and methods return the documented error envelope', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const notFound = await server.api('/api/v1/nope');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'NOT_FOUND');
  assert.ok(notFound.body.error.message.length > 0);

  const missingJob = await server.api('/api/v1/jobs/12345678-1234-4123-8123-123456789012');
  assert.equal(missingJob.status, 404);
  assert.equal(missingJob.body.error.code, 'JOB_NOT_FOUND');
  assert.equal(missingJob.body.error.message.includes('12345678-1234-4123-8123-123456789012'), true);

  const badJson = await server.api('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"width":',
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'VALIDATION_ERROR');

  // Not multipart at all.
  const wrongType = await server.api('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ width: 1280, height: 720 }),
  });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const response = await fetch(`${server.baseUrl}/health`);
  assert.ok(response.headers.get('x-request-id'), 'requests are correlated');
  assert.equal(response.headers.get('x-powered-by'), null);
});
