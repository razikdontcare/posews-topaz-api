'use strict';

/**
 * Render worker behaviour: the whole job lifecycle against the fake Topaz
 * binaries (success, failure, progress, cancellation, renderer outage).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { startTestServer, setRendererEnv } = require('../helpers/app');
const { uploadVideo } = require('../helpers/multipart');
const { isProcessAlive, liveProcessCount } = require('../../src/utils/process');
const { JOB_STATUS } = require('../../src/domain/job-status');
const { randomUUID } = require('node:crypto');

const SMALL = [Buffer.alloc(4096, 0x41)];
const FIELDS = { width: 1280, height: 720 };

/** Capturing logger so the documented log lines can be asserted. */
function createCapturingLogger() {
  const lines = [];
  const make = (scope) => ({
    error: (...args) => lines.push({ level: 'error', line: `${scope}${args.join(' ')}` }),
    warn: (...args) => lines.push({ level: 'warn', line: `${scope}${args.join(' ')}` }),
    info: (...args) => lines.push({ level: 'info', line: `${scope}${args.join(' ')}` }),
    debug: (...args) => lines.push({ level: 'debug', line: `${scope}${args.join(' ')}` }),
    withJob: (jobId) => make(`${scope}Job ${jobId} `),
    child: (name) => make(`${scope}${name}:`),
    close: async () => {},
  });
  return { logger: make(''), lines };
}

function hasLine(lines, pattern) {
  return lines.some((entry) => pattern.test(entry.line));
}

test('a successful render produces the final file and cleans up', async (t) => {
  const { logger, lines } = createCapturingLogger();
  const server = await startTestServer({ logger });
  t.after(() => server.stop());

  setRendererEnv({
    FAKE_FFMPEG_OUTPUT_BYTES: '12345',
    FAKE_FFMPEG_DURATION: '20',
    FAKE_FFPROBE_DURATION: '20',
  });
  const created = await uploadVideo(server.baseUrl, {
    fields: FIELDS,
    filename: 'sosul eater rev.mp4',
    chunks: SMALL,
  });
  const jobId = created.body.id;

  const finished = await server.waitForStatus(jobId, 'completed');
  assert.equal(finished.progress_percent, 100);
  assert.equal(finished.pid, null, 'the pid is cleared after the render');
  assert.equal(finished.temp_output_path, null);
  assert.equal(finished.error_code, null);
  assert.equal(finished.total_size, 12345);
  assert.equal(finished.duration_seconds, 20);

  // Final output: sanitized name, correct resolution suffix, real bytes.
  assert.equal(finished.output_path, path.join(server.dirs.output, 'sosul eater rev_prob3_1280x720.mp4'));
  const stats = await fsp.stat(finished.output_path);
  assert.equal(stats.size, 12345);

  // The temp output was renamed, not copied, and the uploaded input is gone.
  assert.equal(
    (await fsp.readdir(server.dirs.output)).some((name) => name.includes('.rendering.')),
    false,
  );
  await assert.rejects(() => fsp.stat(server.paths.jobTempDir(jobId)), /ENOENT/);

  // Structured logging with the job id (§27).
  assert.ok(hasLine(lines, new RegExp(`Job ${jobId} created`)), 'created log line');
  assert.ok(hasLine(lines, new RegExp(`Job ${jobId} queued`)), 'queued log line');
  assert.ok(hasLine(lines, new RegExp(`Job ${jobId} started`)), 'started log line');
  assert.ok(hasLine(lines, new RegExp(`Job ${jobId} ffmpeg PID=\\d+`)), 'pid log line');
  assert.ok(hasLine(lines, new RegExp(`Job ${jobId} completed -> `)), 'completed log line');
});

test('progress is reported while the render runs', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({
    FAKE_FFMPEG_DURATION: '100',
    FAKE_FFPROBE_DURATION: '100',
    FAKE_FFMPEG_STEPS: '10',
    FAKE_FFMPEG_DELAY_MS: '150',
  });
  const created = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  const jobId = created.body.id;

  const observed = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const progress = await server.api(`/api/v1/jobs/${jobId}/progress`);
    observed.push(progress.body);
    if (progress.body.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const percents = observed.map((entry) => entry.progress).filter((value) => value > 0);
  assert.ok(percents.length >= 2, `expected intermediate progress, saw ${JSON.stringify(observed)}`);
  assert.ok(
    percents.some((value) => value > 0 && value < 100),
    'a percentage between 0 and 100 must be observable',
  );
  const withFrame = observed.find((entry) => entry.frame > 0);
  assert.ok(withFrame, 'frame counter is reported');
  assert.ok(withFrame.fps > 0, 'fps is reported');
  assert.equal(withFrame.speed, '1.00x');

  const final = observed.at(-1);
  assert.equal(final.status, 'completed');
  assert.equal(final.progress, 100);
  assert.equal(final.duration, 100);

  // Progress is persisted to SQLite as well (throttled, but written).
  const row = server.repository.findById(jobId);
  assert.equal(row.progress_percent, 100);
  assert.ok(row.elapsed_seconds > 0);
  assert.ok(row.frame > 0);
});

test('an ffmpeg failure marks the job failed and removes the temp output', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_MODE: 'fail-model' });
  const created = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  const jobId = created.body.id;

  const failed = await server.waitForStatus(jobId, 'failed');
  // A missing Topaz model is a renderer problem, not a per-job one.
  assert.equal(failed.error_code, 'RENDERER_UNAVAILABLE');
  assert.match(failed.error_message, /Topaz model is not available/);
  assert.match(failed.error_message, /Open Topaz Video AI once/);
  assert.equal(failed.output_path, null);
  assert.equal(failed.pid, null);

  const outputEntries = await fsp.readdir(server.dirs.output);
  assert.deepEqual(outputEntries, [], 'no partial output is left behind');

  // Failed jobs keep their input for the retention window (configurable).
  const tempStats = await fsp.stat(server.paths.jobTempDir(jobId));
  assert.equal(tempStats.isDirectory(), true);
});

test('a zero exit code without an output file is treated as a failure', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_MODE: 'no-output' });
  const created = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });

  const failed = await server.waitForStatus(created.body.id, 'failed');
  assert.match(failed.error_message, /output file is missing/);
  assert.equal(failed.output_path, null);
});

test('never more than one render at a time, in creation order', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_STEPS: '2', FAKE_FFMPEG_DELAY_MS: '250' });

  const created = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await uploadVideo(server.baseUrl, {
      fields: FIELDS,
      filename: `clip-${index}.mp4`,
      chunks: SMALL,
    });
    created.push(response.body.id);
  }

  const completionOrder = [];
  let maxConcurrent = 0;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const processing = server.repository
      .findAll({ limit: 100 })
      .filter((job) => job.status === 'processing');
    maxConcurrent = Math.max(maxConcurrent, processing.length);

    const systemStatus = await server.api('/api/v1/system/status');
    assert.ok(systemStatus.body.queue.activeCount <= 1, 'queue reports at most one active job');
    if (systemStatus.body.queue.activeCount === 1) {
      assert.equal(systemStatus.body.renderer.status, 'busy');
      assert.ok(created.includes(systemStatus.body.queue.activeJobId));
    }

    const done = created.filter((id) => server.repository.findById(id).status === 'completed');
    if (done.length === created.length) {
      completionOrder.push(...done);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(maxConcurrent, 1, 'two ffmpeg processes must never overlap');
  assert.equal(completionOrder.length, 3, 'all three jobs finished');
  const startedAt = created.map((id) => server.repository.findById(id).started_at);
  assert.deepEqual([...startedAt].sort(), startedAt, 'jobs started in creation order');
  assert.equal(
    (await fsp.readdir(server.dirs.output)).length,
    3,
    'exactly one output file per job (no duplicate renders)',
  );
});

test('cancelling a running job kills ffmpeg, cleans up and unblocks the queue', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_MODE: 'hang' });
  const running = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  const queued = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  await server.waitForStatus(running.body.id, 'processing');
  await server.waitForJob(running.body.id, (job) => Number.isInteger(job.pid), 'ffmpeg pid');

  const pid = server.repository.findById(running.body.id).pid;
  assert.equal(isProcessAlive(pid), true, 'the fake renderer is running');

  setRendererEnv({ FAKE_FFMPEG_MODE: 'success' });
  const cancelled = await server.api(`/api/v1/jobs/${running.body.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(isProcessAlive(pid), false, 'the ffmpeg process tree is gone');
  assert.equal(server.renderService.isActive(running.body.id), false);
  await assert.rejects(() => fsp.stat(server.paths.jobTempDir(running.body.id)), /ENOENT/);
  assert.deepEqual(await fsp.readdir(server.dirs.output), [], 'no partial output remains');

  // The queue continues with the next job.
  const next = await server.waitForStatus(queued.body.id, 'completed');
  assert.equal(next.error_code, null);
});

test('cancelling a queued job prevents it from ever rendering', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFMPEG_MODE: 'hang' });
  const running = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  await server.waitForStatus(running.body.id, 'processing');

  const waiting = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  assert.equal(waiting.body.position, 2);
  assert.equal(server.repository.findById(waiting.body.id).status, 'queued');

  const cancelled = await server.api(`/api/v1/jobs/${waiting.body.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.body.status, 'cancelled');

  // Let the running job finish; the cancelled one must stay cancelled and never
  // produce output or a pid.
  setRendererEnv({ FAKE_FFMPEG_MODE: 'success' });
  await server.api(`/api/v1/jobs/${running.body.id}/cancel`, { method: 'POST' });

  const row = server.repository.findById(waiting.body.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.pid, null);
  assert.equal(row.started_at, null, 'it never started');
  const outputs = await fsp.readdir(server.dirs.output);
  assert.deepEqual(outputs, []);
});

test('cancelling immediately after the upload never leaves a render running', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  // 'hang' keeps ffmpeg alive forever: if the cancellation race is lost, a process
  // stays behind and the assertions below fail.
  setRendererEnv({ FAKE_FFMPEG_MODE: 'hang' });

  const ids = [];
  for (let index = 0; index < 4; index += 1) {
    const created = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
    ids.push(created.body.id);

    const cancelled = await server.api(`/api/v1/jobs/${created.body.id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
  }

  for (const jobId of ids) {
    const row = await server.waitForStatus(jobId, ['cancelled', 'failed']);
    assert.equal(row.status, 'cancelled', 'a cancelled job must never complete');
    assert.equal(row.pid, null);
  }

  // No renderer process may survive the cancellations.
  const deadline = Date.now() + 5000;
  while (liveProcessCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(liveProcessCount(), 0, 'no ffmpeg process is left running');
  assert.equal(server.renderService.count(), 0);

  // Give a leaked render a chance to land, then check nothing was written.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(await fsp.readdir(server.dirs.output), []);
  for (const jobId of ids) {
    const row = server.repository.findById(jobId);
    assert.equal(row.output_path, null);
    assert.equal(row.status, 'cancelled');
  }
});

test('a renderer outage rejects uploads, keeps queued jobs and recovers automatically', async (t) => {
  const server = await startTestServer({ rendererRecheckCooldownMs: 50 });
  t.after(() => server.stop());

  // A job that is already queued when the outage starts.
  const id = randomUUID();
  await fsp.mkdir(server.paths.jobTempDir(id), { recursive: true });
  const inputPath = server.paths.jobInputPath(id, '.mp4');
  await fsp.writeFile(inputPath, 'uploaded-bytes');
  server.repository.create({
    id,
    status: JOB_STATUS.QUEUED,
    original_filename: 'queued.mp4',
    input_path: inputPath,
    width: 640,
    height: 360,
    duration_seconds: 10,
    has_audio: 0,
  });

  // Break the renderer capability checks, then declare it unavailable.
  setRendererEnv({ FAKE_FFMPEG_MODE: 'missing-caps' });
  server.rendererService.markUnavailable('simulated outage');

  // New uploads are rejected before any byte is read.
  const rejected = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.error.code, 'RENDERER_UNAVAILABLE');
  assert.equal(server.repository.countAll(), 1, 'the rejected upload created no job');

  await new Promise((resolve) => setTimeout(resolve, 100));
  const pending = server.repository.findById(id);
  assert.equal(pending.status, 'queued', 'the queued job is not failed');
  assert.equal(pending.pid, null);

  // A reconcile pass notices the outage and pauses the queue (queued jobs wait).
  const outageReconcile = await server.queue.reconcile();
  assert.equal(outageReconcile.paused, true);
  assert.equal(server.queue.isPaused, true);
  assert.equal(server.repository.findById(id).status, 'queued');

  // The API still answers and reports the outage.
  const status = await server.api('/api/v1/system/status');
  assert.equal(status.body.renderer.status, 'unavailable');
  assert.equal(status.body.renderer.available, false);
  assert.equal(status.body.queue.paused, true);

  // Repair the renderer: the periodic reconcile picks the job up again.
  setRendererEnv({ FAKE_FFMPEG_MODE: 'success' });
  const reconciled = await server.queue.reconcile();
  assert.equal(reconciled.paused, false);
  const completed = await server.waitForStatus(id, 'completed', 20000);
  assert.equal(completed.progress_percent, 100);

  // ...and uploads are accepted again.
  const accepted = await uploadVideo(server.baseUrl, { fields: FIELDS, chunks: SMALL });
  assert.equal(accepted.status, 202);
});
