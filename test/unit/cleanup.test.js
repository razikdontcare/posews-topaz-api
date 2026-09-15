'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { startTestServer } = require('../helpers/app');
const { JOB_STATUS } = require('../../src/domain/job-status');

const HOUR = 3600 * 1000;

async function age(target, hours) {
  const when = new Date(Date.now() - hours * HOUR);
  await fsp.utimes(target, when, when);
}

function jobPayload(overrides = {}) {
  return {
    id: randomUUID(),
    status: JOB_STATUS.QUEUED,
    original_filename: 'input.mp4',
    input_path: 'D:\\VideoTemp\\x\\input.mp4',
    width: 1280,
    height: 720,
    ...overrides,
  };
}

test('cleanup removes a finished job temp directory', async () => {
  const server = await startTestServer({ skipInitialize: true });
  try {
    const jobId = randomUUID();
    const dir = server.paths.jobTempDir(jobId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'input.mp4'), 'bytes');

    assert.equal(await server.container.cleanupService.removeJobTemp(jobId), true);
    await assert.rejects(() => fsp.stat(dir), /ENOENT/);
    // idempotent
    assert.equal(await server.container.cleanupService.removeJobTemp(jobId), true);
  } finally {
    await server.stop({ graceful: false });
  }
});

test('stale temp sweep never touches queued, active or fresh directories', async () => {
  const server = await startTestServer({ skipInitialize: true });
  const { repository } = server;
  const cleanup = server.container.cleanupService;
  try {
    const staleOrphan = 'aaaaaaaa-0000-4000-8000-000000000001';
    const staleQueued = 'aaaaaaaa-0000-4000-8000-000000000002';
    const staleActive = 'aaaaaaaa-0000-4000-8000-000000000003';
    const freshOrphan = 'aaaaaaaa-0000-4000-8000-000000000004';

    for (const id of [staleOrphan, staleQueued, staleActive, freshOrphan]) {
      const dir = server.paths.jobTempDir(id);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'input.mp4'), 'x');
      if (id !== freshOrphan) await age(dir, 48);
    }

    repository.create(jobPayload({ id: staleQueued, status: JOB_STATUS.QUEUED }));
    repository.create(jobPayload({ id: staleActive, status: JOB_STATUS.PROCESSING }));
    server.renderService.register(staleActive, null);

    const result = await cleanup.cleanupStaleTempDirs();
    assert.equal(result.removed, 1);

    await assert.rejects(() => fsp.stat(server.paths.jobTempDir(staleOrphan)), /ENOENT/);
    await fsp.stat(server.paths.jobTempDir(freshOrphan));
    await fsp.stat(server.paths.jobTempDir(staleQueued));
    await fsp.stat(server.paths.jobTempDir(staleActive));
  } finally {
    server.renderService.unregister('aaaaaaaa-0000-4000-8000-000000000003');
    await server.stop({ graceful: false });
  }
});

test('orphan .rendering.mp4 files are swept, rendered output is never touched', async () => {
  const server = await startTestServer({ skipInitialize: true });
  const { repository } = server;
  const cleanup = server.container.cleanupService;
  try {
    const orphanId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const busyId = 'bbbbbbbb-0000-4000-8000-000000000002';
    const recentId = 'bbbbbbbb-0000-4000-8000-000000000003';

    const orphan = server.paths.tempOutputPath(orphanId);
    const busy = server.paths.tempOutputPath(busyId);
    const recent = server.paths.tempOutputPath(recentId);
    for (const file of [orphan, busy, recent]) await fsp.writeFile(file, 'partial');
    await age(orphan, 48);
    await age(busy, 48);

    repository.create(jobPayload({ id: busyId, status: JOB_STATUS.PROCESSING }));

    const finalOutput = path.join(server.dirs.output, 'finished_prob3_1280x720.mp4');
    await fsp.writeFile(finalOutput, 'rendered');
    await age(finalOutput, 96);

    const result = await cleanup.cleanupOrphanTempOutputs();
    assert.equal(result.removed, 1);
    await assert.rejects(() => fsp.stat(orphan), /ENOENT/);
    await fsp.stat(busy);
    await fsp.stat(recent);
    await fsp.stat(finalOutput);
  } finally {
    await server.stop({ graceful: false });
  }
});

test('empty output placeholders are swept, real renders are kept', async () => {
  const server = await startTestServer({ skipInitialize: true });
  const { repository } = server;
  const cleanup = server.container.cleanupService;
  try {
    const referenced = path.join(server.dirs.output, 'referenced_prob3_1280x720.mp4');
    const placeholder = path.join(server.dirs.output, 'orphan_prob3_1280x720.mp4');
    const renderingTemp = server.paths.tempOutputPath('cccccccc-0000-4000-8000-000000000001');
    const finished = path.join(server.dirs.output, 'finished_prob3_1280x720.mp4');

    await fsp.writeFile(referenced, '');
    await fsp.writeFile(placeholder, '');
    await fsp.writeFile(renderingTemp, '');
    await fsp.writeFile(finished, 'rendered bytes');
    for (const file of [referenced, placeholder, renderingTemp, finished]) await age(file, 1);

    const jobId = randomUUID();
    repository.create(jobPayload({ id: jobId }));
    repository.transition(jobId, [JOB_STATUS.QUEUED], JOB_STATUS.COMPLETED, {
      completed_at: new Date().toISOString(),
      output_path: referenced,
    });

    const result = await cleanup.cleanupEmptyOutputFiles();
    assert.equal(result.removed, 1);
    await fsp.stat(referenced, 'a referenced output is never removed');
    await assert.rejects(() => fsp.stat(placeholder), /ENOENT/);
    await fsp.stat(renderingTemp, 'temp outputs are handled by their own sweep');
    await fsp.stat(finished);
  } finally {
    await server.stop({ graceful: false });
  }
});

test('expired job records are purged but their rendered file survives', async () => {
  const server = await startTestServer({ skipInitialize: true });
  const { repository } = server;
  const cleanup = server.container.cleanupService;
  try {
    const expiredId = randomUUID();
    const failedId = randomUUID();
    const recentId = randomUUID();

    for (const id of [expiredId, failedId, recentId]) {
      await fsp.mkdir(server.paths.jobTempDir(id), { recursive: true });
      await fsp.writeFile(path.join(server.paths.jobTempDir(id), 'input.mp4'), 'x');
    }

    const renderPath = path.join(server.dirs.output, 'expired_prob3_1280x720.mp4');
    await fsp.writeFile(renderPath, 'rendered');

    repository.create(jobPayload({ id: expiredId }));
    repository.transition(expiredId, [JOB_STATUS.QUEUED], JOB_STATUS.COMPLETED, {
      completed_at: new Date(Date.now() - 100 * HOUR).toISOString(),
      output_path: renderPath,
    });

    repository.create(jobPayload({ id: failedId }));
    repository.transition(failedId, [JOB_STATUS.QUEUED], JOB_STATUS.FAILED, {
      completed_at: new Date(Date.now() - 30 * HOUR).toISOString(),
      error_code: 'FFMPEG_ERROR',
      error_message: 'boom',
    });

    repository.create(jobPayload({ id: recentId }));
    repository.transition(recentId, [JOB_STATUS.QUEUED], JOB_STATUS.COMPLETED, {
      completed_at: new Date().toISOString(),
      output_path: renderPath,
    });

    const result = await cleanup.cleanupExpiredJobs();
    assert.equal(result.removed, 2);

    assert.equal(repository.findById(expiredId), undefined);
    assert.equal(repository.findById(failedId), undefined);
    assert.ok(repository.findById(recentId));
    await fsp.stat(renderPath, 'the rendered output must survive');
    await assert.rejects(() => fsp.stat(server.paths.jobTempDir(expiredId)), /ENOENT/);
  } finally {
    await server.stop({ graceful: false });
  }
});
