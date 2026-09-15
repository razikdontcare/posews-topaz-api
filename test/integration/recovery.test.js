'use strict';

/**
 * Restart recovery (AGENTS.md §15, §39) and the "queued jobs survive a PM2
 * restart" guarantee.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { startTestServer, setRendererEnv } = require('../helpers/app');
const { uploadVideo } = require('../helpers/multipart');
const { createDatabase } = require('../../src/database/database');
const { createJobRepository } = require('../../src/database/repositories/job.repository');
const { isProcessAlive, terminateProcessTree } = require('../../src/utils/process');
const { JOB_STATUS } = require('../../src/domain/job-status');

const SMALL = [Buffer.alloc(2048, 0x41)];
const FIELDS = { width: 640, height: 360 };

/** Creates a job row plus its uploaded input file on disk. */
async function seedJob(server, overrides = {}) {
  const id = overrides.id || randomUUID();
  const dir = server.paths.jobTempDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const inputPath = server.paths.jobInputPath(id, '.mp4');
  await fsp.writeFile(inputPath, 'uploaded-bytes');

  const row = server.repository.create({
    id,
    status: JOB_STATUS.QUEUED,
    original_filename: 'seeded.mp4',
    input_path: inputPath,
    width: 640,
    height: 360,
    duration_seconds: 10,
    has_audio: 0,
    ...overrides,
  });
  return row;
}

test('interrupted renders become failed with a deterministic message', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const processing = await seedJob(server, { status: JOB_STATUS.PROCESSING, pid: 999999 });
  const probing = await seedJob(server, { status: JOB_STATUS.PROBING });
  const cancelRequested = await seedJob(server, { status: JOB_STATUS.CANCEL_REQUESTED });

  // A leftover temp output from the crashed render must be removed.
  const leftover = server.paths.tempOutputPath(processing.id);
  await fsp.writeFile(leftover, 'partial render');
  server.repository.update(processing.id, { temp_output_path: leftover });

  const summary = await server.jobService.recoverInterruptedJobs();
  assert.equal(summary.failed, 2);
  assert.equal(summary.cancelled, 1);

  const failedRow = server.repository.findById(processing.id);
  assert.equal(failedRow.status, JOB_STATUS.FAILED);
  assert.equal(failedRow.error_code, 'RENDERER_INTERRUPTED');
  assert.equal(failedRow.error_message, 'Renderer interrupted by server restart');
  assert.ok(failedRow.completed_at);
  assert.equal(failedRow.pid, null);
  assert.equal(failedRow.temp_output_path, null);
  await assert.rejects(() => fsp.stat(leftover), /ENOENT/);

  assert.equal(server.repository.findById(probing.id).status, JOB_STATUS.FAILED);

  const cancelledRow = server.repository.findById(cancelRequested.id);
  assert.equal(cancelledRow.status, JOB_STATUS.CANCELLED);
  assert.equal(cancelledRow.error_code, null);
});

test('a renderer process that survived the crash is terminated', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  t.after(async () => {
    await terminateProcessTree(orphan, { graceMs: 500 });
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isProcessAlive(orphan.pid), true);

  const job = await seedJob(server, {
    status: JOB_STATUS.PROCESSING,
    pid: orphan.pid,
    duration_seconds: 10,
  });

  const summary = await server.jobService.recoverInterruptedJobs();
  assert.deepEqual(summary.killedPids, [orphan.pid]);
  assert.equal(isProcessAlive(orphan.pid), false, 'the orphaned process tree is gone');
  assert.equal(server.repository.findById(job.id).status, JOB_STATUS.FAILED);
});

test('recovery never kills a pid that no longer belongs to the renderer', async (t) => {
  // The configured renderer process name is `node` in tests (the fake renderer),
  // so a cmd.exe process must be left alone even though the row points at it.
  const server = await startTestServer();
  const stranger = spawn('cmd.exe', ['/c', 'ping -n 120 127.0.0.1 > nul'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  t.after(async () => {
    await terminateProcessTree(stranger, { graceMs: 500 });
    await server.stop();
  });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(isProcessAlive(stranger.pid), true);

  const job = await seedJob(server, { status: JOB_STATUS.PROCESSING, pid: stranger.pid });
  const summary = await server.jobService.recoverInterruptedJobs();

  assert.deepEqual(summary.killedPids, [], 'a recycled pid is not force-killed');
  assert.equal(isProcessAlive(stranger.pid), true, 'the unrelated process survived');
  // The job itself is still recovered deterministically.
  const row = server.repository.findById(job.id);
  assert.equal(row.status, JOB_STATUS.FAILED);
  assert.equal(row.pid, null);
});

test('queued jobs are re-queued after recovery and rendered exactly once', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const jobs = [];
  for (let index = 0; index < 3; index += 1) {
    jobs.push(await seedJob(server, { original_filename: `seeded-${index}.mp4` }));
  }

  const first = await server.jobService.recoverInterruptedJobs();
  assert.equal(first.requeued, 3);

  for (const job of jobs) {
    const finished = await server.waitForStatus(job.id, JOB_STATUS.COMPLETED, 20000);
    assert.equal(finished.progress_percent, 100);
  }

  // Running recovery again (e.g. a second pass or a follow-up restart) must not
  // re-queue finished jobs nor disturb anything: no duplicate rendering.
  const second = await server.jobService.recoverInterruptedJobs();
  assert.deepEqual(second, { failed: 0, cancelled: 0, killedPids: [], requeued: 0 });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const outputs = await fsp.readdir(server.dirs.output);
  assert.equal(outputs.length, 3, 'exactly one render per job');
  assert.deepEqual(outputs.sort(), [
    'seeded-0_prob3_640x360.mp4',
    'seeded-1_prob3_640x360.mp4',
    'seeded-2_prob3_640x360.mp4',
  ]);
});

test('a queued job survives a simulated process crash and finishes after restart', async (t) => {
  const root = path.join(os.tmpdir(), `vua-restart-${randomUUID()}`);
  const first = await startTestServer({ root, preserveRoot: true });
  let second = null;
  t.after(async () => {
    await second?.stop({ graceful: false });
    await first.stop({ graceful: false });
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // Job 1 keeps the GPU busy, job 2 waits in the queue.
  setRendererEnv({ FAKE_FFMPEG_MODE: 'hang' });
  const blocker = await uploadVideo(first.baseUrl, { fields: FIELDS, chunks: SMALL });
  await first.waitForStatus(blocker.body.id, 'processing');

  setRendererEnv({ FAKE_FFMPEG_MODE: 'success' });
  const waiting = await uploadVideo(first.baseUrl, {
    fields: { width: 1920, height: 1080 },
    filename: 'survivor.mp4',
    chunks: SMALL,
  });
  assert.equal(waiting.body.position, 2);
  assert.equal(first.repository.findById(waiting.body.id).status, JOB_STATUS.QUEUED);

  // Simulate a PM2 restart / crash: the running render is killed, SQLite stays.
  await first.stop({ graceful: false });

  // The queued job is still queued in the (now closed) database: verify with a
  // fresh connection, exactly like the next process would see it.
  const probeDatabase = createDatabase({ file: first.config.dbFile });
  const probeRepository = createJobRepository({ database: probeDatabase });
  try {
    const persisted = probeRepository.findById(waiting.body.id);
    assert.equal(persisted.status, JOB_STATUS.QUEUED, 'queued work survives a crash');
    assert.equal(persisted.input_path, path.join(first.dirs.temp, waiting.body.id, 'input.mp4'));
    await fsp.stat(persisted.input_path);
  } finally {
    probeDatabase.close();
  }

  // ...and the service comes back on the same directories.
  second = await startTestServer({ root, preserveRoot: true });
  assert.ok(second.init.recovery.requeued >= 1, 'the queued job is picked up again');

  const finished = await second.waitForStatus(waiting.body.id, JOB_STATUS.COMPLETED, 20000);
  assert.equal(finished.error_code, null);
  assert.equal(finished.width, 1920);
  assert.equal(finished.output_path, path.join(second.dirs.output, 'survivor_prob3_1920x1080.mp4'));
  await fsp.stat(finished.output_path);

  // The job that was rendering when the process died is marked failed, not left
  // hanging in `processing`.
  const interrupted = second.repository.findById(blocker.body.id);
  assert.equal(interrupted.status, JOB_STATUS.FAILED);
  assert.match(interrupted.error_message, /interrupted/i);
});
