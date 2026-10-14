'use strict';

/**
 * Per-job output directory (AGENTS.md §25): a client can send an `outputDir` form
 * field to choose where the render lands. There is no allowlist — the renderer
 * runs on a trusted machine, so any destination is accepted and missing
 * directories are created on demand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { startTestServer } = require('../helpers/app');
const { uploadVideo } = require('../helpers/multipart');

const SMALL = [Buffer.alloc(4096, 0x41)];
const FIELDS = { width: 1280, height: 720 };

test('a relative outputDir renders into a subdirectory of the default output dir', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const expectedDir = path.join(server.dirs.output, 'clients', 'acme');
  const created = await uploadVideo(server.baseUrl, {
    fields: { ...FIELDS, outputDir: 'clients/acme' },
    filename: 'acme clip.mp4',
    chunks: SMALL,
  });

  assert.equal(created.status, 202);
  assert.equal(created.body.outputDir, expectedDir);

  const jobId = created.body.id;
  const finished = await server.waitForStatus(jobId, 'completed');

  assert.equal(finished.output_dir, expectedDir);
  assert.equal(
    finished.output_path,
    path.join(expectedDir, 'acme clip_prob3_1280x720.mp4'),
  );
  const stats = await fsp.stat(finished.output_path);
  assert.ok(stats.size > 0, 'the render is written into the requested directory');

  // The job detail echoes the directory the client selected.
  const detail = await server.api(`/api/v1/jobs/${jobId}`);
  assert.equal(detail.body.outputDir, expectedDir);
});

test('an absolute outputDir outside the default output dir is accepted', async (t) => {
  const extraRoot = path.join(os.tmpdir(), `vua-output-${randomUUID()}`);
  const server = await startTestServer();
  t.after(async () => {
    await server.stop();
    await fsp.rm(extraRoot, { recursive: true, force: true });
  });

  const created = await uploadVideo(server.baseUrl, {
    fields: { ...FIELDS, outputDir: extraRoot },
    chunks: SMALL,
  });

  assert.equal(created.status, 202);
  assert.equal(created.body.outputDir, extraRoot);

  const finished = await server.waitForStatus(created.body.id, 'completed');
  assert.equal(finished.output_dir, extraRoot);
  assert.equal(path.dirname(finished.output_path), extraRoot);
  assert.ok((await fsp.stat(finished.output_path)).size > 0);
});

test('a relative outputDir may step outside the default output dir', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  // `..` resolves to a sibling of the output dir (removed with the test root).
  const relative = `../escape-${randomUUID()}`;
  const created = await uploadVideo(server.baseUrl, {
    fields: { ...FIELDS, outputDir: relative },
    chunks: SMALL,
  });

  const expectedDir = path.resolve(server.dirs.output, relative);
  assert.equal(created.status, 202);
  assert.equal(created.body.outputDir, expectedDir);

  const finished = await server.waitForStatus(created.body.id, 'completed');
  assert.equal(path.dirname(finished.output_path), expectedDir);
});

test('ALLOW_OUTPUT_DIR_OVERRIDE=false ignores the field with a clear error', async (t) => {
  const server = await startTestServer({ allowOutputDirOverride: false });
  t.after(() => server.stop());

  const response = await uploadVideo(server.baseUrl, {
    fields: { ...FIELDS, outputDir: 'clients/acme' },
    chunks: SMALL,
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  assert.equal(response.body.error.details.field, 'outputDir');
});
