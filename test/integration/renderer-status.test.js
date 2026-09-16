'use strict';

/**
 * Renderer readiness semantics: a failed deep self test means the machine cannot
 * render, so the service stops accepting jobs (503) and pauses the queue instead
 * of letting uploads fail one by one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { setRendererEnv, startTestServer } = require('../helpers/app');
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
  assert.equal(status.body.renderer.renderSelftest, null, 'the deep probe is skipped');
});

test('a failing render probe is reported as a renderer problem too', async (t) => {
  const server = await startTestServer({
    rendererSelftest: true,
    rendererModelSelftest: true,
    rendererEnv: { FAKE_FFMPEG_MODE: 'fail-model' },
  });
  t.after(() => server.stop());

  const { status } = server.init.validation;
  assert.equal(status.nvencWorking, true, 'the encoder itself works');
  assert.equal(status.renderWorking, false);
  assert.equal(status.usable, false);
  assert.equal(status.available, false);
  assert.match(status.reason, /Topaz render self test failed/);
  assert.match(status.reason, /Model not found: prob-3/);
  assert.match(status.reason, /same ffmpeg command a job uses/);

  const statusResponse = await server.api('/api/v1/system/status');
  assert.equal(statusResponse.body.renderer.renderSelftest, false);

  // The probe cleans its scratch files up even when the render fails.
  await assert.rejects(
    fsp.stat(path.join(server.config.tempDir, 'renderer-selftest')),
    /ENOENT/,
  );

  // ...and the failure has to come from the render, not from generating the clip.
  assert.doesNotMatch(status.reason, /probe clip could not be generated/);
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
  setRendererEnv({ FAKE_FFMPEG_MODE: 'success' });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const reconcile = await server.queue.reconcile();
  assert.equal(reconcile.paused, false, 'the queue resumes');
  assert.equal(server.rendererService.isAvailable(), true);

  const accepted = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  assert.equal(accepted.status, 202);
  await server.waitForStatus(accepted.body.id, 'completed');
});

/*
 * The probe must run the same encoder configuration as a render. The original
 * probe (`-c:v h264_nvenc` on a single 128x128 frame) blocked a production machine
 * whose renders worked, because NVENC refused the probe's geometry while accepting
 * the real command.
 */
test('the NVENC self test spawns the same encoder block as a render', async (t) => {
  const server = await startTestServer({ rendererSelftest: true, rendererModelSelftest: true });
  const argsFile = path.join(server.root, 'ffmpeg-args.jsonl');
  setRendererEnv({ FAKE_FFMPEG_ARGS_FILE: argsFile });
  t.after(() => server.stop());

  const result = await server.rendererService.validate();
  assert.equal(result.usable, true, 'both probes pass with the fake renderer');

  const invocations = (await fsp.readFile(argsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const probe = invocations.filter((entry) => entry.kind === 'selftest').at(-1);
  assert.ok(probe, 'the startup validation must run a self test probe');
  assert.deepEqual(
    probe.args.slice(probe.args.indexOf('-c:v'), probe.args.indexOf('-b:v') + 2),
    [
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
    ],
  );
  assert.equal(probe.args[probe.args.indexOf('-i') + 1], 'nullsrc=s=640x360:r=25');
  assert.equal(probe.args.at(-1), '-');

  // The end-to-end probe must be an actual render: a generated input file, the full
  // tvai_up + scale chain, the real encoder block, a real output file.
  const renders = invocations.filter((entry) => entry.kind === 'render');
  const fixture = renders.find((entry) => entry.args.some((arg) => arg.startsWith('testsrc=')));
  const renderProbe = renders.find((entry) => entry.args.some((arg) => arg.includes('tvai_up')));
  assert.ok(fixture, 'the probe generates its own input clip');
  assert.ok(renderProbe, 'the probe must render through tvai_up, not just load the model');
  assert.match(renderProbe.args[renderProbe.args.indexOf('-i') + 1], /renderer-selftest.*input\.mp4$/);
  assert.match(renderProbe.args.at(-1), /renderer-selftest.*output\.mp4$/);
  assert.match(
    renderProbe.args[renderProbe.args.indexOf('-filter_complex') + 1],
    /^tvai_up=model=prob-3:scale=0:w=1280:h=720:.*,scale=w=1280:h=720:flags=lanczos:threads=0,scale=out_color_matrix=bt709$/,
  );
});

test('a self test that never finishes is reported as a timeout, not an unknown error', async (t) => {
  const server = await startTestServer({
    rendererSelftest: true,
    rendererSelftestTimeoutMs: 300,
    rendererEnv: { FAKE_FFMPEG_MODE: 'hang' },
  });
  t.after(() => server.stop());

  const { status } = server.init.validation;
  assert.equal(status.nvencWorking, false);
  assert.match(status.reason, /h264_nvenc self test failed/);
  assert.match(status.reason, /did not finish within 300 ms/);
  assert.doesNotMatch(status.reason, /unknown reason/);
});

test('the render probe is skipped when the encoder probe already failed', async (t) => {
  const server = await startTestServer({
    rendererSelftest: true,
    rendererModelSelftest: true,
    rendererEnv: { FAKE_FFMPEG_MODE: 'fail-nvenc' },
  });
  t.after(() => server.stop());

  const { status } = server.init.validation;
  assert.equal(status.nvencWorking, false);
  assert.equal(status.renderWorking, null, 'no GPU time wasted on the deep probe');
  assert.doesNotMatch(status.reason, /render self test/);
});
