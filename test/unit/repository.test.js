'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { createDatabase } = require('../../src/database/database');
const { runMigrations, currentVersion } = require('../../src/database/migrations');
const { createJobRepository } = require('../../src/database/repositories/job.repository');
const { JOB_STATUS } = require('../../src/domain/job-status');
const { isAppError } = require('../../src/utils/errors');

async function createFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vua-db-'));
  const database = createDatabase({ file: path.join(dir, 'jobs.sqlite') });
  const migrations = runMigrations(database);
  const repository = createJobRepository({ database });
  return {
    database,
    dir,
    migrations,
    repository,
    async close() {
      database.close();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

function jobPayload(overrides = {}) {
  return {
    id: randomUUID(),
    status: JOB_STATUS.QUEUED,
    original_filename: 'input.mp4',
    input_path: 'D:\\VideoTemp\\x\\input.mp4',
    width: 3840,
    height: 1620,
    duration_seconds: 1072.5,
    has_audio: 1,
    audio_codec: 'aac',
    ...overrides,
  };
}

test('migrations create the jobs table, indexes and are idempotent', async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(fixture.migrations, [1, 2]);
    assert.equal(currentVersion(fixture.database), 2);

    // Running them again must not throw nor re-apply anything.
    assert.deepEqual(runMigrations(fixture.database), []);

    const tables = fixture.database
      .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name);
    assert.ok(tables.includes('jobs'));
    assert.ok(tables.includes('schema_migrations'));

    const indexes = fixture.database
      .all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'")
      .map((row) => row.name);
    for (const expected of ['idx_jobs_status', 'idx_jobs_created_at', 'idx_jobs_status_created_at']) {
      assert.ok(indexes.includes(expected), `missing index ${expected}`);
    }

    const columns = fixture.database.all('PRAGMA table_info(jobs)').map((row) => row.name);
    for (const expected of [
      'id', 'status', 'original_filename', 'input_path', 'output_path', 'temp_output_path',
      'width', 'height', 'duration_seconds', 'progress_percent', 'frame', 'fps', 'speed',
      'elapsed_seconds', 'total_size', 'pid', 'error_code', 'error_message', 'render_options',
      'created_at', 'started_at', 'completed_at', 'updated_at',
    ]) {
      assert.ok(columns.includes(expected), `missing column ${expected}`);
    }
  } finally {
    await fixture.close();
  }
});

test('create/find/update round trip keeps the whole job model', async () => {
  const fixture = await createFixture();
  const { repository } = fixture;
  try {
    const payload = jobPayload();
    const created = repository.create(payload);

    assert.equal(created.id, payload.id);
    assert.equal(created.status, JOB_STATUS.QUEUED);
    assert.equal(created.width, 3840);
    assert.equal(created.height, 1620);
    assert.equal(created.duration_seconds, 1072.5);
    assert.equal(created.has_audio, true);
    assert.equal(created.audio_codec, 'aac');
    assert.equal(created.progress_percent, 0);
    assert.equal(created.output_path, null);
    assert.match(created.created_at, /^\d{4}-\d{2}-\d{2}T/);

    const updated = repository.update(created.id, {
      status: JOB_STATUS.PROCESSING,
      pid: 4242,
      frame: 12842,
      fps: 31.4,
      speed: '0.82x',
      elapsed_seconds: 513,
      progress_percent: 47.82,
      total_size: 1048576,
      ignored_column: 'nope',
      frame_undefined: undefined,
    });
    assert.equal(updated.status, JOB_STATUS.PROCESSING);
    assert.equal(updated.pid, 4242);
    assert.equal(updated.frame, 12842);
    assert.equal(updated.fps, 31.4);
    assert.equal(updated.speed, '0.82x');
    assert.equal(updated.progress_percent, 47.82);
    assert.equal(updated.total_size, 1048576);
    assert.notEqual(updated.updated_at, undefined);
  } finally {
    await fixture.close();
  }
});

test('unknown statuses are rejected by the repository and by SQLite', async () => {
  const fixture = await createFixture();
  const { repository, database } = fixture;
  try {
    assert.throws(() => repository.create(jobPayload({ status: 'rendering' })), /unknown status/i);
    assert.throws(() => repository.transition('nope', [JOB_STATUS.QUEUED], 'done'), /unknown job status/i);

    const payload = jobPayload();
    repository.create(payload);
    assert.throws(
      () => database.run('UPDATE jobs SET status = ? WHERE id = ?', ['done', payload.id]),
      /CHECK constraint failed/,
    );
  } finally {
    await fixture.close();
  }
});

test('status transitions are atomic: a queued job can only be claimed once', async () => {
  const fixture = await createFixture();
  const { repository } = fixture;
  try {
    const payload = jobPayload();
    repository.create(payload);

    assert.equal(repository.tryMarkProcessing(payload.id), true);
    assert.equal(repository.tryMarkProcessing(payload.id), false, 'second claim must fail');

    let job = repository.findById(payload.id);
    assert.equal(job.status, JOB_STATUS.PROCESSING);
    assert.ok(job.started_at, 'started_at is recorded on claim');

    // Cancel racing with start: only the active statuses can move to cancel_requested.
    assert.equal(
      repository.transition(payload.id, [JOB_STATUS.QUEUED], JOB_STATUS.CANCEL_REQUESTED),
      false,
    );
    assert.equal(
      repository.transition(payload.id, [JOB_STATUS.PROCESSING], JOB_STATUS.CANCEL_REQUESTED),
      true,
    );
    assert.equal(
      repository.transition(payload.id, [JOB_STATUS.CANCEL_REQUESTED], JOB_STATUS.CANCELLED, {
        completed_at: new Date().toISOString(),
      }),
      true,
    );

    job = repository.findById(payload.id);
    assert.equal(job.status, JOB_STATUS.CANCELLED);
    assert.ok(job.completed_at);

    // A finished job can never be restarted.
    assert.equal(repository.tryMarkProcessing(payload.id), false);
  } finally {
    await fixture.close();
  }
});

test('queued selection and position follow creation order', async () => {
  const fixture = await createFixture();
  const { repository } = fixture;
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      repository.create(jobPayload({ id, original_filename: `${id}.mp4` }));
      await new Promise((resolve) => setTimeout(resolve, 3)); // distinct ISO timestamps
    }
    // The first job gets claimed, the remaining two stay queued.
    repository.tryMarkProcessing(ids[0]);

    assert.deepEqual(repository.findQueuedIds(), [ids[1], ids[2]]);

    const second = repository.findById(ids[1]);
    const third = repository.findById(ids[2]);
    // Pipeline order counts the job that is already rendering as well.
    assert.equal(repository.countPipelineAhead(second.id, second.created_at), 1);
    assert.equal(repository.countPipelineAhead(third.id, third.created_at), 2);
    assert.deepEqual(repository.findPipelineIds(), [ids[0], ids[1], ids[2]]);

    assert.equal(repository.findActive().length, 1);
    assert.equal(repository.countAll({ status: JOB_STATUS.QUEUED }), 2);
    assert.equal(repository.countAll(), 3);

    const page = repository.findAll({ limit: 2, offset: 0 });
    assert.equal(page.length, 2);
    assert.equal(page[0].id, ids[2], 'newest first');
    assert.deepEqual(repository.countByStatus().processing, 1);
    assert.deepEqual(repository.countByStatus().queued, 2);
  } finally {
    await fixture.close();
  }
});

test('parameterized SQL keeps hostile filenames as data', async () => {
  const fixture = await createFixture();
  const { repository, database } = fixture;
  try {
    const hostile = "'; DROP TABLE jobs; --";
    const payload = jobPayload({ original_filename: hostile, input_path: `D:\\VideoTemp\\x\\${hostile}` });
    repository.create(payload);

    const found = repository.findById(payload.id);
    assert.equal(found.original_filename, hostile);
    assert.equal(found.input_path, `D:\\VideoTemp\\x\\${hostile}`);
    assert.equal(repository.countAll(), 1);
    assert.ok(database.get("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'"));
  } finally {
    await fixture.close();
  }
});

test('deletion helpers remove the right rows only', async () => {
  const fixture = await createFixture();
  const { repository } = fixture;
  try {
    const old = jobPayload({ id: randomUUID() });
    const fresh = jobPayload({ id: randomUUID() });
    const running = jobPayload({ id: randomUUID() });
    repository.create(old);
    repository.create(fresh);
    repository.create(running);

    const longAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    repository.transition(old.id, [JOB_STATUS.QUEUED], JOB_STATUS.COMPLETED, {
      completed_at: longAgo,
      output_path: 'D:\\Hasil Render\\old_prob3_1280x720.mp4',
    });
    repository.transition(fresh.id, [JOB_STATUS.QUEUED], JOB_STATUS.COMPLETED, {
      // One hour ago: deterministic, so `deleteOlderThan` never depends on the
      // millisecond in which this test happens to run.
      completed_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    });
    repository.tryMarkProcessing(running.id);

    const expired = repository.findExpired({
      completedBefore: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
      failedBefore: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    });
    assert.deepEqual(expired.map((job) => job.id), [old.id]);

    assert.equal(repository.deleteById(old.id), true);
    assert.equal(repository.deleteById('missing'), false);
    assert.equal(repository.countAll(), 2);

    // deleteOlderThan removes the remaining terminal job (fresh) only.
    const removed = repository.deleteOlderThan(new Date().toISOString());
    assert.equal(removed, 1);
    assert.equal(repository.findById(old.id), undefined);
    assert.ok(repository.findById(running.id), 'the processing job survived');
    assert.equal(repository.findById(fresh.id), undefined);
  } finally {
    await fixture.close();
  }
});

test('a closed database reports a clear error instead of crashing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vua-db-closed-'));
  const database = createDatabase({ file: path.join(dir, 'jobs.sqlite') });
  runMigrations(database);
  database.close();

  try {
    database.run('SELECT 1');
    assert.fail('expected an error');
  } catch (error) {
    assert.ok(isAppError(error));
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.match(error.message, /closed/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('database.check() proves the file is readable and writable', async () => {
  const fixture = await createFixture();
  try {
    const info = fixture.database.check();
    assert.equal(info.journalMode, 'wal');
    assert.equal(info.file, path.join(fixture.dir, 'jobs.sqlite'));
  } finally {
    await fixture.close();
  }
});
