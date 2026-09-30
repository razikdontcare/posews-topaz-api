'use strict';

/**
 * Global default output directory: `GET`/`PUT /api/v1/system/output-dir`.
 *
 * The per-job `outputDir` field stays optional; this endpoint moves the default
 * used by jobs that do not send one, without a restart, and the value survives
 * a PM2 restart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { startTestServer } = require('../helpers/app');
const { uploadVideo } = require('../helpers/multipart');
const { assertResponseShape } = require('../helpers/openapi');

const SMALL = [Buffer.alloc(4096, 0x41)];
const FIELDS = { width: 1280, height: 720 };

function putOutputDir(server, outputDir) {
  return server.api('/api/v1/system/output-dir', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outputDir }),
  });
}

test('the default output directory can be read and changed while running', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const initial = await server.api('/api/v1/system/output-dir');
  assert.equal(initial.status, 200);
  assertResponseShape(initial.body, 'OutputDirResponse', { mode: 'exact', label: 'output dir' });
  assert.equal(initial.body.outputDir, server.dirs.output);
  assert.equal(initial.body.configured, server.dirs.output);
  assert.equal(initial.body.allowOverride, true);
  assert.deepEqual(initial.body.allowedRoots, [server.dirs.output]);

  const updated = await putOutputDir(server, 'clients');
  assert.equal(updated.status, 200);
  assert.equal(updated.body.outputDir, path.join(server.dirs.output, 'clients'));

  // A job without its own outputDir now renders into the new default...
  const plain = await uploadVideo(server.baseUrl, { fields: FIELDS, filename: 'plain.mp4', chunks: SMALL });
  const plainJob = await server.waitForStatus(plain.body.id, 'completed');
  assert.equal(plainJob.output_dir, path.join(server.dirs.output, 'clients'));
  assert.equal(plainJob.output_path, path.join(server.dirs.output, 'clients', 'plain_prob3_1280x720.mp4'));
  assert.ok((await fsp.stat(plainJob.output_path)).size > 0);

  // ...while a per-job outputDir still wins. A *relative* value is resolved
  // under the current default, so 'special' -> <output>\clients\special.
  const explicit = await uploadVideo(server.baseUrl, {
    fields: { ...FIELDS, outputDir: 'special' },
    filename: 'special.mp4',
    chunks: SMALL,
  });
  const explicitJob = await server.waitForStatus(explicit.body.id, 'completed');
  assert.equal(explicitJob.output_dir, path.join(server.dirs.output, 'clients', 'special'));

  // Resetting returns to OUTPUT_DIR.
  const reset = await putOutputDir(server, null);
  assert.equal(reset.status, 200);
  assert.equal(reset.body.outputDir, server.dirs.output);
});

test('changing the default rejects a path outside the allowed roots', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const outside = path.join(server.root, 'outside');
  const rejected = await putOutputDir(server, outside);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');

  // The default is untouched.
  const current = await server.api('/api/v1/system/output-dir');
  assert.equal(current.body.outputDir, server.dirs.output);
});

test('a malformed body is rejected', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const missing = await server.api('/api/v1/system/output-dir', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

  const wrongType = await putOutputDir(server, 42);
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error.code, 'VALIDATION_ERROR');
});

test('ALLOW_OUTPUT_DIR_OVERRIDE=false refuses changes through the API', async (t) => {
  const server = await startTestServer({ allowOutputDirOverride: false });
  t.after(() => server.stop());

  const state = await server.api('/api/v1/system/output-dir');
  assert.equal(state.body.allowOverride, false);

  const rejected = await putOutputDir(server, 'clients');
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
});

test('the default survives a restart and applies to new jobs', async (t) => {
  const root = path.join(os.tmpdir(), `vua-global-dir-${randomUUID()}`);
  let second = null;
  const first = await startTestServer({ root, preserveRoot: true });
  t.after(async () => {
    await second?.stop({ graceful: false });
    await first.stop({ graceful: false });
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const target = path.join(first.dirs.output, 'persisted');
  const updated = await putOutputDir(first, 'persisted');
  assert.equal(updated.body.outputDir, target);

  // Simulated PM2 restart on the same directories.
  await first.stop({ graceful: false });
  second = await startTestServer({ root, preserveRoot: true });

  const restored = await second.api('/api/v1/system/output-dir');
  assert.equal(restored.body.outputDir, target, 'the setting was persisted');

  const created = await uploadVideo(second.baseUrl, {
    fields: FIELDS,
    filename: 'after-restart.mp4',
    chunks: SMALL,
  });
  const finished = await second.waitForStatus(created.body.id, 'completed');
  assert.equal(finished.output_dir, target);
  assert.equal(finished.output_path, path.join(target, 'after-restart_prob3_1280x720.mp4'));
  assert.ok((await fsp.stat(finished.output_path)).size > 0);
});
