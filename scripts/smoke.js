'use strict';

/**
 * End-to-end smoke test against a running instance and the *real* Topaz binaries.
 *
 *   npm start                       (in another terminal)
 *   npm run smoke                   (defaults to http://127.0.0.1:<PORT>)
 *   npm run smoke -- http://localhost:3000 640 360
 *   npm run smoke -- --noise=0.45 --qp=20 --preset=p6 --model=prob-4 --audio=aac
 *
 * It generates a small clip with the configured ffmpeg, uploads it through the API,
 * polls the progress endpoint, downloads the result and reports the final state —
 * so the whole chain (upload -> queue -> Topaz ffmpeg -> rename -> download) is
 * verified on the machine that actually renders.
 *
 * `--<option>=<value>` arguments are forwarded to the API as render options, which
 * makes it easy to check a tuned command on the render machine.
 */

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { config } = require('../src/config/env');
const { RENDER_OPTION_FIELDS } = require('../src/domain/render-options');

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));

/** `--noise=0.45` -> `{ noise: '0.45' }` (only documented option fields are sent). */
const renderOptionArgs = Object.fromEntries(
  argv
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [name, ...rest] = arg.slice(2).split('=');
      return [name.toLowerCase(), rest.join('=')];
    }),
);
const renderOptions = Object.fromEntries(
  Object.entries(renderOptionArgs).filter(([name]) => RENDER_OPTION_FIELDS.includes(name)),
);

const baseUrl = (positional[0] || `http://127.0.0.1:${config.port}`).replace(/\/$/, '');
const WIDTH = Number(positional[1] || 640);
const HEIGHT = Number(positional[2] || 360);
const DURATION_SECONDS = 2;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINAL = ['completed', 'failed', 'cancelled'];

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-400)}`)),
    );
  });
}

async function createFixture(target) {
  await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=320x180:rate=15:duration=${DURATION_SECONDS}`,
    '-c:v', 'mpeg4',
    '-q:v', '5',
    target,
  ]);
  return (await fsp.stat(target)).size;
}

async function upload(filePath) {
  const data = await fsp.readFile(filePath);
  const form = new FormData();
  form.append('video', new Blob([data]), path.basename(filePath));
  form.append('width', String(WIDTH));
  form.append('height', String(HEIGHT));
  for (const [name, value] of Object.entries(renderOptions)) form.append(name, String(value));

  const response = await fetch(`${baseUrl}/api/v1/jobs`, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`upload failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vua-smoke-'));
  const fixture = path.join(workDir, 'smoke input.mp4');

  try {
    console.log(`service  : ${baseUrl}`);
    console.log(`ffmpeg   : ${config.ffmpegPath}`);

    const health = await (await fetch(`${baseUrl}/health`)).json();
    console.log(`health   : ${JSON.stringify(health)}`);

    const status = await (await fetch(`${baseUrl}/api/v1/system/status`)).json();
    console.log(
      `renderer : state=${status.renderer.state} ffmpeg=${status.renderer.ffmpeg} ` +
        `ffprobe=${status.renderer.ffprobe} tvai_up=${status.renderer.tvaiUp} ` +
        `h264_nvenc=${status.renderer.h264Nvenc} selftest=${status.renderer.nvencSelftest} ` +
        `model=${status.renderer.model}/${status.renderer.modelSelftest}`,
    );

    const size = await createFixture(fixture);
    console.log(`fixture  : ${path.basename(fixture)} (${size} bytes)`);
    console.log(
      `options  : ${Object.keys(renderOptions).length > 0 ? JSON.stringify(renderOptions) : 'baseline (none)'}`,
    );

    const created = await upload(fixture);
    console.log(`created  : ${JSON.stringify({ ...created, render: undefined })}`);
    console.log(`render   : ${JSON.stringify(created.render)}`);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let previous = null;
    let last = null;
    while (Date.now() < deadline) {
      const progress = await (
        await fetch(`${baseUrl}/api/v1/jobs/${created.id}/progress`)
      ).json();

      if (
        !previous ||
        progress.status !== previous.status ||
        progress.progress !== previous.progress
      ) {
        console.log(
          `status   : ${progress.status} ${progress.progress}% frame=${progress.frame} ` +
            `fps=${progress.fps} speed=${progress.speed}`,
        );
      }
      previous = progress;
      last = progress;
      if (TERMINAL.includes(progress.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(`final    : ${JSON.stringify(last, null, 2)}`);

    if (last && last.status === 'completed') {
      const download = await fetch(`${baseUrl}/api/v1/jobs/${created.id}/download`);
      const bytes = Buffer.from(await download.arrayBuffer());
      console.log(
        `download : ${download.status} ${bytes.byteLength} bytes ` +
          `(${download.headers.get('content-disposition')})`,
      );
      console.log('\nSmoke test PASSED — the full pipeline rendered and served a real video.');
      return;
    }

    console.log('\nSmoke test did NOT produce a render (see the job error above).');
    process.exitCode = 1;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`smoke test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
