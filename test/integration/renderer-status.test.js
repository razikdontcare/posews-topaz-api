'use strict';

/**
 * Renderer readiness semantics: a failed deep self test means the machine cannot
 * render, so the service stops accepting jobs (503) and pauses the queue instead
 * of letting uploads fail one by one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('../helpers/app');
const { uploadVideo } = require('../helpers/multipart');

const SMALL = [Buffer.alloc(4096, 0x41)];
const FIELDS = { width: 1280, height: 720 };

test('a failed NVENC self test makes the renderer unusable and rejects uploads', async (t) => {
  const server = await startTestServer({
    rendererSelftest: true,
    rendererEnv: { FAKE_FFMPEG_MODE: 'fail-nvenc' },
  });
  t.after(() => server.stop());

  const validation = server.init.validation;
  assert.equal(validation.ok, true, 'the process still boots so it can be diagnosed');
  assert.equal(validation.status.ffmpeg, true);
  assert.equal(validation.status.tvaiUp, true);
  assert.equal(validation.status.h264Nvenc, true);
  assert.equal(validation.status.nvencWorking, false);
  assert.equal(validation.status.usable, false);
  assert.equal(validation.status.available, false);
  assert.equal(validation.status.state, 'degraded');
  assert.match(validation.status.reason, /h264_nvenc self test failed/);
  assert.match(validation.status.reason, /Cannot load nvcuda\.dll/);

  // The queue does not start doomed jobs.
  const reconcile = await server.queue.reconcile();
  assert.equal(reconcile.paused, true);

  // Uploads are rejected before the body is read.
  const rejected = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.error.code, 'RENDERER_UNAVAILABLE');
  assert.match(rejected.body.error.message, /renderer is not available/i);
  assert.equal(server.repository.countAll(), 0);

  // And the status endpoint explains why.
  const status = await server.api('/api/v1/system/status');
  assert.equal(status.body.status, 'degraded');
  assert.equal(status.body.renderer.available, false);
  assert.equal(status.body.renderer.usable, false);
  assert.equal(status.body.renderer.status, 'unavailable');
  assert.equal(status.body.renderer.nvencSelftest, false);
  assert.equal(status.body.renderer.modelSelftest, null, 'the model check is skipped');
});

test('a failed Topaz model check is reported as a renderer problem too', async (t) => {
  const server = await startTestServer({
    rendererSelftest: true,
    rendererModelSelftest: true,
    rendererEnv: { FAKE_FFMPEG_MODE: 'fail-model' },
  });
  t.after(() => server.stop());

  const { status } = server.init.validation;
  assert.equal(status.nvencWorking, true, 'the encoder itself works');
  assert.equal(status.modelWorking, false);
  assert.equal(status.usable, false);
  assert.equal(status.available, false);
  assert.match(status.reason, /Topaz model "prob-3" could not be loaded/);
  assert.match(status.reason, /Model not found: prob-3/);
  assert.match(status.reason, /Open Topaz Video AI once/);

  const statusResponse = await server.api('/api/v1/system/status');
  assert.equal(statusResponse.body.renderer.modelSelftest, false);
});

test('ALLOW_DEGRADED_START=true accepts jobs even when the renderer is not usable', async (t) => {
  const server = await startTestServer({
    rendererSelftest: true,
    allowDegradedStart: true,
    rendererEnv: { FAKE_FFMPEG_MODE: 'fail-nvenc' },
  });
  t.after(() => server.stop());

  const { status } = server.init.validation;
  assert.equal(status.usable, false, 'still reported as not usable');
  assert.equal(status.available, true, 'but the operator opted in');

  const statusResponse = await server.api('/api/v1/system/status');
  assert.equal(statusResponse.body.renderer.available, true);
  assert.equal(statusResponse.body.renderer.usable, false);
  assert.equal(statusResponse.body.renderer.status, 'available');
  assert.equal(statusResponse.body.renderer.state, 'degraded');

  const accepted = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  assert.equal(accepted.status, 202);
});

test('the renderer recovers by itself once the self test passes again', async (t) => {
  const server = await startTestServer({
    rendererSelftest: true,
    rendererRecheckCooldownMs: 50,
    rendererEnv: { FAKE_FFMPEG_MODE: 'fail-nvenc' },
  });
  t.after(() => server.stop());

  assert.equal(server.rendererService.isAvailable(), false);
  const rejected = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  assert.equal(rejected.status, 503);

  // The driver/model is fixed (or the GPU comes back) and the cooldown passes.
  const { setRendererEnv } = require('../helpers/app');
  setRendererEnv({ FAKE_FFMPEG_MODE: 'success' });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const reconcile = await server.queue.reconcile();
  assert.equal(reconcile.paused, false, 'the queue resumes');
  assert.equal(server.rendererService.isAvailable(), true);

  const accepted = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  assert.equal(accepted.status, 202);
  await server.waitForStatus(accepted.body.id, 'completed');
});
