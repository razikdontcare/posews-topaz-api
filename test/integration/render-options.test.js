'use strict';

/**
 * Render options end-to-end: multipart fields -> stored options -> the exact
 * ffmpeg argument vector (recorded by the fake renderer), plus validation,
 * the strict-baseline mode and legacy jobs without options.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { startTestServer, setRendererEnv } = require('../helpers/app');
const { uploadVideo } = require('../helpers/multipart');
const { defaultRenderOptions } = require('../../src/domain/render-options');
const { JOB_STATUS } = require('../../src/domain/job-status');

const SMALL = [Buffer.alloc(4096, 0x41)];
const FIELDS = { width: 1280, height: 720 };

async function renderInvocations(argsFile) {
  const text = await fsp.readFile(argsFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === 'render');
}

function lastArgs(entries) {
  assert.ok(entries.length > 0, 'the fake renderer was never invoked');
  return entries.at(-1).args;
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

test('a job without options renders exactly the documented baseline command', async (t) => {
  const server = await startTestServer();
  const argsFile = path.join(server.root, 'ffmpeg-args.jsonl');
  setRendererEnv({ FAKE_FFMPEG_ARGS_FILE: argsFile });
  t.after(() => server.stop());

  const created = await uploadVideo(server.baseUrl, {
    fields: FIELDS,
    filename: 'baseline.mp4',
    chunks: SMALL,
  });
  assert.equal(created.status, 202);
  assert.deepEqual(created.body.render, defaultRenderOptions(server.config));

  await server.waitForStatus(created.body.id, 'completed');
  const args = lastArgs(await renderInvocations(argsFile));

  assert.equal(
    argValue(args, '-filter_complex'),
    'tvai_up=model=prob-3:scale=0:w=1280:h=720:preblur=-0.100659:noise=0.25:details=0.75:' +
      'halo=0.05:blur=0.25:compression=0.2:blend=0.6:device=0:vram=1:instances=1,' +
      'scale=w=1280:h=720:flags=lanczos:threads=0,scale=out_color_matrix=bt709',
  );
  assert.equal(argValue(args, '-qp'), '25');
  assert.equal(argValue(args, '-preset'), 'p7');
  assert.equal(args.includes('-an'), false);

  // ffmpeg writes to the reserved temp output; the rename to the final name only
  // happens after a successful exit (§17).
  const outputArg = args.at(-1);
  assert.equal(path.dirname(outputArg), server.dirs.output);
  assert.match(path.basename(outputArg), /^\.[0-9a-f-]{36}\.rendering\.mp4$/);
});

test('tuned options reach the filter, the encoder, the audio mapping and the filename', async (t) => {
  const server = await startTestServer({ maxGpuIndex: 1 });
  const argsFile = path.join(server.root, 'ffmpeg-args.jsonl');
  setRendererEnv({ FAKE_FFMPEG_ARGS_FILE: argsFile });
  t.after(() => server.stop());

  const created = await uploadVideo(server.baseUrl, {
    fields: {
      width: 1920,
      height: 1080,
      model: 'prob-4',
      device: '1',
      vram: '0',
      instances: '2',
      preblur: '0.15',
      noise: '0.6',
      details: '0.9',
      halo: '0.2',
      blur: '0.4',
      compression: '0.35',
      blend: '0.8',
      qp: '18',
      preset: 'p5',
      audio: 'none',
    },
    filename: 'tuned.mov',
    chunks: SMALL,
  });

  assert.equal(created.status, 202);
  assert.deepEqual(created.body.render, {
    model: 'prob-4',
    device: 1,
    vram: 0,
    instances: 2,
    topaz: {
      preblur: 0.15,
      noise: 0.6,
      details: 0.9,
      halo: 0.2,
      blur: 0.4,
      compression: 0.35,
      blend: 0.8,
    },
    encoder: { qp: 18, preset: 'p5' },
    audio: 'none',
    fps: null,
    filename: null,
    label: null,
  });

  const finished = await server.waitForStatus(created.body.id, 'completed');
  const args = lastArgs(await renderInvocations(argsFile));

  const filter = argValue(args, '-filter_complex');
  assert.match(
    filter,
    /^tvai_up=model=prob-4:scale=0:w=1920:h=1080:preblur=0.15:noise=0.6:details=0.9:halo=0.2:blur=0.4:compression=0.35:blend=0.8:device=1:vram=0:instances=2,/,
  );
  assert.match(filter, /,scale=w=1920:h=1080:flags=lanczos:threads=0,scale=out_color_matrix=bt709$/);
  assert.equal(argValue(args, '-qp'), '18');
  assert.equal(argValue(args, '-preset'), 'p5');
  assert.equal(args.includes('-an'), true, 'audio=none must drop the audio track');
  assert.equal(args.includes('-c:a'), false);
  assert.equal(args.includes('-map'), false);

  // The model slug ends up in the final filename.
  assert.match(finished.output_path, /tuned_prob4_1920x1080\.mp4$/);

  // Stored as JSON on the job row and echoed by the read endpoints.
  assert.deepEqual(
    JSON.parse(server.repository.findById(created.body.id).render_options),
    created.body.render,
  );
  const detail = await server.api(`/api/v1/jobs/${created.body.id}`);
  assert.deepEqual(detail.body.render, created.body.render);
  const list = await server.api('/api/v1/jobs?limit=5');
  assert.deepEqual(
    list.body.data.find((job) => job.id === created.body.id).render,
    created.body.render,
  );
});

test('rejects invalid, malformed and unknown render options', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const cases = [
    [{ noise: '5' }, /"noise" must be between 0 and 1/, 'noise'],
    [{ preblur: '2' }, /"preblur" must be between -1 and 1/, 'preblur'],
    [{ details: 'high' }, /"details" must be a number/, 'details'],
    [{ qp: '99' }, /"qp" must be between 1 and 51/, 'qp'],
    [{ qp: '18.5' }, /"qp" must be an integer/, 'qp'],
    [{ preset: 'p9' }, /"preset" must be one of/, 'preset'],
    [{ audio: 'mute' }, /"audio" must be one of/, 'audio'],
    [{ model: 'evil-1' }, /"model" must be one of/, 'model'],
    [{ instances: '9' }, /"instances" must be between 1 and 4/, 'instances'],
    [{ device: '1' }, /"device" must be between 0 and 0/, 'device'],
  ];

  for (const [extra, message, field] of cases) {
    const response = await uploadVideo(server.baseUrl, {
      fields: { ...FIELDS, ...extra },
      filename: 'invalid.mp4',
      chunks: SMALL,
    });
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.match(response.body.error.message, message);
    assert.equal(response.body.error.details.field, field);
  }

  assert.equal(server.repository.countAll(), 0, 'no job is created for invalid options');
  const tempEntries = await fsp.readdir(server.dirs.temp).catch(() => []);
  assert.deepEqual(tempEntries, [], 'the rejected uploads are removed');
});

test('ALLOW_RENDER_TUNING=false only accepts the strict baseline request', async (t) => {
  const server = await startTestServer({ allowRenderTuning: false });
  t.after(() => server.stop());

  const rejected = await uploadVideo(server.baseUrl, {
    fields: { ...FIELDS, qp: '20' },
    filename: 'strict.mp4',
    chunks: SMALL,
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
  assert.match(rejected.body.error.message, /tuning is disabled/i);
  assert.deepEqual(rejected.body.error.details.fields, ['qp']);

  const accepted = await uploadVideo(server.baseUrl, {
    fields: FIELDS,
    filename: 'strict.mp4',
    chunks: SMALL,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body.render, defaultRenderOptions(server.config));
  await server.waitForStatus(accepted.body.id, 'completed');
});

test('legacy jobs without stored options still render with the baseline', async (t) => {
  const server = await startTestServer();
  const argsFile = path.join(server.root, 'ffmpeg-args.jsonl');
  setRendererEnv({ FAKE_FFMPEG_ARGS_FILE: argsFile });
  t.after(() => server.stop());

  const id = randomUUID();
  await fsp.mkdir(server.paths.jobTempDir(id), { recursive: true });
  const inputPath = server.paths.jobInputPath(id, '.mp4');
  await fsp.writeFile(inputPath, 'uploaded-bytes');

  server.repository.create({
    id,
    status: JOB_STATUS.QUEUED,
    original_filename: 'legacy.mp4',
    input_path: inputPath,
    width: 640,
    height: 360,
    duration_seconds: 10,
    has_audio: 0,
  });
  assert.equal(server.repository.findById(id).render_options, null);

  server.queue.enqueue(id);
  await server.waitForStatus(id, 'completed');

  const detail = await server.api(`/api/v1/jobs/${id}`);
  assert.equal(detail.body.render, null, 'a job without stored options reports null');

  const args = lastArgs(await renderInvocations(argsFile));
  assert.match(argValue(args, '-filter_complex'), /^tvai_up=model=prob-3:scale=0:w=640:h=360:/);
  assert.equal(argValue(args, '-qp'), '25');
  assert.equal(argValue(args, '-preset'), 'p7');
});

test('a client-provided filename and fps drive the output name and the filter chain', async (t) => {
  const server = await startTestServer();
  const argsFile = path.join(server.root, 'ffmpeg-args.jsonl');
  setRendererEnv({ FAKE_FFMPEG_ARGS_FILE: argsFile });
  t.after(() => server.stop());

  const created = await uploadVideo(server.baseUrl, {
    fields: { width: 3840, height: 1620, filename: 'sosul eater rev', fps: '60' },
    filename: 'YT downloader output.mp4',
    chunks: SMALL,
  });

  assert.equal(created.status, 202);
  assert.equal(created.body.render.filename, 'sosul eater rev');
  assert.equal(created.body.render.label, '4K', 'derived from 3840x1620');
  assert.equal(created.body.render.fps, 60);

  const finished = await server.waitForStatus(created.body.id, 'completed');
  assert.equal(path.basename(finished.output_path), 'sosul eater rev 4K.mp4');
  await fsp.stat(finished.output_path);

  const args = lastArgs(await renderInvocations(argsFile));
  assert.match(argValue(args, '-filter_complex'), /,fps=60$/);

  // The download endpoint serves the custom name.
  const response = await fetch(`${server.baseUrl}/api/v1/jobs/${created.body.id}/download`);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''sosul%20eater%20rev%204K\.mp4/);
});

test('an existing file with the requested name is never overwritten', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const existing = path.join(server.dirs.output, 'sosul eater rev 4K.mp4');
  await fsp.writeFile(existing, 'previous render');

  const created = await uploadVideo(server.baseUrl, {
    fields: { width: 3840, height: 1620, filename: 'sosul eater rev' },
    chunks: SMALL,
  });
  const finished = await server.waitForStatus(created.body.id, 'completed');

  assert.notEqual(finished.output_path, existing);
  assert.match(path.basename(finished.output_path), /^sosul eater rev 4K_[0-9a-f-]+-\d+\.mp4$/);
  assert.equal(await fsp.readFile(existing, 'utf8'), 'previous render');
});

test('the label can be overridden and requires a filename', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const created = await uploadVideo(server.baseUrl, {
    fields: { width: 1920, height: 1080, filename: 'concert', label: 'Final Cut' },
    chunks: SMALL,
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.render.label, 'Final Cut');

  const finished = await server.waitForStatus(created.body.id, 'completed');
  assert.equal(path.basename(finished.output_path), 'concert Final Cut.mp4');

  const labelOnly = await uploadVideo(server.baseUrl, {
    fields: { ...FIELDS, label: '4K' },
    chunks: SMALL,
  });
  assert.equal(labelOnly.status, 400);
  assert.match(labelOnly.body.error.message, /"label" can only be used together with "filename"/);
  assert.equal(labelOnly.body.error.details.requires, 'filename');

  const badFps = await uploadVideo(server.baseUrl, { fields: { ...FIELDS, fps: '500' }, chunks: SMALL });
  assert.equal(badFps.status, 400);
  assert.match(badFps.body.error.message, /"fps" must be between 1 and 240/);

  const badName = await uploadVideo(server.baseUrl, {
    fields: { ...FIELDS, filename: '...' },
    chunks: SMALL,
  });
  assert.equal(badName.status, 400);
  assert.match(badName.body.error.message, /"filename" must contain at least one usable character/);

  assert.equal(server.repository.countAll(), 1, 'only the valid job was created');
});

test('system status publishes the option description for the frontend form', async (t) => {
  const server = await startTestServer({ maxGpuIndex: 2 });
  t.after(() => server.stop());

  const status = await server.api('/api/v1/system/status');
  const description = status.body.renderOptions;

  assert.equal(description.tuningEnabled, true);
  assert.deepEqual(description.defaults, defaultRenderOptions(server.config));
  assert.deepEqual(description.fields.model.allowed, server.config.allowedModels);
  assert.equal(description.fields.model.defaultValue, server.config.topazModel);
  assert.equal(description.fields.qp.min, 1);
  assert.equal(description.fields.qp.max, 51);
  assert.equal(description.fields.device.max, 2);
  assert.equal(description.fields.noise.type, 'number');
  assert.deepEqual(description.fields.preset.allowed, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  assert.deepEqual(description.fields.audio.allowed, ['auto', 'copy', 'aac', 'reencode', 'none']);
  assert.equal(description.fields.fps.min, 1);
  assert.equal(description.fields.fps.max, 240);
  assert.equal(description.fields.fps.defaultValue, null);
  assert.equal(description.fields.filename.type, 'string');
  assert.equal(description.fields.label.defaultValue, null);
  assert.match(description.fields.label.hint, /4K, 1440p, 1080p, 720p, WxH/);
});
