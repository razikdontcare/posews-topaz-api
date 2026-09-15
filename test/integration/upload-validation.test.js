'use strict';

/**
 * Upload behaviour: streaming, size limits, validation, path traversal and client
 * disconnects (AGENTS.md §7, §8, §25).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { startTestServer, setRendererEnv } = require('../helpers/app');
const { repeatChunks, uploadVideo } = require('../helpers/multipart');

const SMALL = [Buffer.alloc(4096, 0x41)];

async function tempDirEntries(server) {
  try {
    return await fsp.readdir(server.dirs.temp);
  } catch {
    return [];
  }
}

async function waitForEmptyTemp(server, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await tempDirEntries(server)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('a large upload is streamed to disk without filling memory', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  // 64 MiB in 1 MiB chunks, all sharing one buffer so the *test* stays small too.
  const chunkSize = 1024 * 1024;
  const chunkCount = 64;
  const chunks = repeatChunks(chunkSize, chunkCount, 0x5a);

  const before = process.memoryUsage().heapUsed;
  const response = await uploadVideo(server.baseUrl, {
    fields: { width: 3840, height: 1620 },
    filename: 'huge.mp4',
    chunks,
  });
  const growth = process.memoryUsage().heapUsed - before;

  assert.equal(response.status, 202);
  const jobId = response.body.id;

  // The temp file exists on disk with the full size...
  const inputPath = path.join(server.dirs.temp, jobId, 'input.mp4');
  const stats = await fsp.stat(inputPath);
  assert.equal(stats.size, chunkSize * chunkCount);

  // ...while the process heap grew by a small fraction of the upload.
  assert.ok(
    growth < 12 * 1024 * 1024,
    `heap grew by ${(growth / 1024 / 1024).toFixed(1)} MiB for a 64 MiB upload`,
  );

  await server.waitForStatus(jobId, 'completed');
});

test('uploads larger than MAX_UPLOAD_SIZE_BYTES are rejected (both paths)', async (t) => {
  const server = await startTestServer({ maxUploadSizeBytes: 1024 * 1024 });
  t.after(() => server.stop());

  // 1. Known Content-Length: rejected before the body is read.
  const known = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: repeatChunks(512 * 1024, 4),
    mode: 'blob',
  });
  assert.equal(known.status, 413);
  assert.equal(known.body.error.code, 'UPLOAD_TOO_LARGE');
  assert.equal(known.body.error.details.maxUploadSizeBytes, 1024 * 1024);

  // 2. Chunked body (no Content-Length): the streaming guard stops it.
  let streamed = null;
  try {
    streamed = await uploadVideo(server.baseUrl, {
      fields: { width: 1280, height: 720 },
      chunks: repeatChunks(256 * 1024, 8),
    });
  } catch (error) {
    // The server may close the connection instead of answering; that is allowed.
    streamed = { status: 'aborted', error };
  }
  if (streamed.status !== 'aborted') {
    assert.equal(streamed.status, 413);
    assert.equal(streamed.body.error.code, 'UPLOAD_TOO_LARGE');
  }

  assert.equal(server.repository.countAll(), 0, 'no jobs are created for rejected uploads');
  assert.equal(await waitForEmptyTemp(server), true, 'partial uploads are cleaned up');
});

test('dimension fields are required, integral and sane', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const cases = [
    { fields: { height: 720 }, message: /"width" is required/ },
    { fields: { width: 1280 }, message: /"height" is required/ },
    { fields: { width: '', height: 720 }, message: /"width" is required/ },
    { fields: { width: 'abc', height: 720 }, message: /"width" must be a positive integer/ },
    { fields: { width: '12.5', height: 720 }, message: /"width" must be a positive integer/ },
    { fields: { width: '1280.0', height: 720 }, message: /"width" must be a positive integer/ },
    { fields: { width: '0', height: 720 }, message: /"width" must be at least/ },
    { fields: { width: '8', height: 720 }, message: /"width" must be at least/ },
    { fields: { width: '99999', height: 720 }, message: /"width" must be at most/ },
    { fields: { width: '1281', height: 720 }, message: /even number/ },
    { fields: { width: '1280', height: '721' }, message: /even number/ },
    {
      fields: { width: '1280:x=1', height: '720' },
      message: /"width" must be a positive integer/,
    },
  ];

  for (const testCase of cases) {
    const response = await uploadVideo(server.baseUrl, {
      fields: testCase.fields,
      chunks: SMALL,
      filename: 'clip.mp4',
    });
    assert.equal(response.status, 400, JSON.stringify(testCase.fields));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.match(response.body.error.message, testCase.message);
  }

  assert.equal(server.repository.countAll(), 0);
  assert.equal(await waitForEmptyTemp(server), true);
});

test('metadata may arrive before or after the file part', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const before = await uploadVideo(server.baseUrl, {
    fields: { width: 640, height: 360 },
    chunks: SMALL,
  });
  const after = await uploadVideo(server.baseUrl, {
    fields: { width: 640, height: 360 },
    chunks: SMALL,
    fieldsLast: true,
  });

  assert.equal(before.status, 202);
  assert.equal(after.status, 202);
  assert.equal(after.body.width, 640);
  assert.equal(after.body.height, 360);

  await server.waitForStatus(before.body.id, 'completed');
  await server.waitForStatus(after.body.id, 'completed');
});

test('unsupported formats and malformed multipart payloads are rejected', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const badExtension = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: SMALL,
    filename: 'clip.txt',
  });
  assert.equal(badExtension.status, 400);
  assert.equal(badExtension.body.error.code, 'VALIDATION_ERROR');
  assert.match(badExtension.body.error.message, /Unsupported video format/);
  assert.ok(Array.isArray(badExtension.body.error.details.allowedExtensions));

  const noExtension = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: SMALL,
    filename: 'clip',
  });
  assert.equal(noExtension.status, 400);

  const wrongField = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: SMALL,
    fieldName: 'file',
  });
  assert.equal(wrongField.status, 400);
  assert.match(wrongField.body.error.message, /use the "video" field/);

  const empty = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: [],
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error.message, /empty/);

  const notMultipart = await server.api('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data' },
    body: 'garbage',
  });
  assert.ok([400, 415].includes(notMultipart.status));

  assert.equal(server.repository.countAll(), 0);
  assert.equal(await waitForEmptyTemp(server), true);
});

test('a file that is not a readable video never becomes a job', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  setRendererEnv({ FAKE_FFPROBE_MODE: 'invalid' });
  const response = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: SMALL,
    filename: 'fake.mp4',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_VIDEO');
  assert.match(response.body.error.message, /could not be read as a video/i);
  assert.equal(server.repository.countAll(), 0);
  assert.equal(await waitForEmptyTemp(server), true, 'the rejected upload is removed');
});

test('a file without a video stream is rejected too', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  // The fake ffprobe reports an audio-only file when FAKE_FFPROBE_VIDEO=0.
  setRendererEnv({ FAKE_FFPROBE_VIDEO: '0', FAKE_FFPROBE_AUDIO: '1' });
  const response = await uploadVideo(server.baseUrl, {
    fields: { width: 1280, height: 720 },
    chunks: SMALL,
    filename: 'audio-only.mp4',
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_VIDEO');
  assert.match(response.body.error.message, /does not contain a video stream/);
  assert.equal(server.repository.countAll(), 0);
});

test('path traversal in the filename cannot escape the temp directory', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const traversalNames = [
    '..\\..\\..\\evil.mp4',
    '../../../../evil.mp4',
    'C:\\Windows\\System32\\evil.mp4',
    'D:/Hasil Render/../../evil.mp4',
  ];

  for (const filename of traversalNames) {
    const response = await uploadVideo(server.baseUrl, {
      fields: { width: 640, height: 360 },
      chunks: SMALL,
      filename,
    });
    assert.equal(response.status, 202, filename);

    const job = server.repository.findById(response.body.id);
    assert.equal(job.original_filename, 'evil.mp4');
    assert.equal(job.original_filename.includes('..'), false);
    assert.equal(job.original_filename.includes('/'), false);
    assert.equal(job.original_filename.includes('\\'), false);
    assert.equal(path.dirname(job.input_path), path.join(server.dirs.temp, job.id));
    assert.equal(job.input_path.endsWith('input.mp4'), true);

    // And the input file is exactly where we expect it.
    const stats = await fsp.stat(job.input_path);
    assert.equal(stats.isFile(), true);

    await server.waitForStatus(job.id, 'completed');
    // The rendered filename is sanitized as well (later iterations of the loop
    // produce the same name and therefore get a collision suffix).
    const detail = await server.api(`/api/v1/jobs/${job.id}`);
    assert.match(detail.body.output.filename, /^evil_prob3_640x360(_[0-9a-f-]+-\d+)?\.mp4$/);
  }
});

test('a client disconnect mid-upload leaves no job and no temp data', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const controller = new AbortController();
  const uploading = uploadVideo(server.baseUrl, {
    fields: { width: 1920, height: 1080 },
    chunks: repeatChunks(256 * 1024, 40), // 10 MiB, long enough to abort mid-flight
    signal: controller.signal,
  }).catch((error) => ({ status: 'aborted', error }));

  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.abort();
  const result = await uploading;

  if (result.status !== 'aborted') {
    assert.equal(result.status, 500 || result.status);
  }

  assert.equal(server.repository.countAll(), 0, 'an aborted upload creates no job');
  assert.equal(await waitForEmptyTemp(server), true, 'the partial file is removed');
});
