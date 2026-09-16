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
 *
 * It first reads `/api/v1/system/status` and stops with an explanation when the renderer is not
 * usable (no NVIDIA driver, model not downloaded), so a GPU-less development machine reports the
 * reason instead of leaving a failed job behind. Exit code is 0 only when a render completed.
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
    const error = new Error(`upload failed (${response.status}): ${JSON.stringify(body)}`);
    error.code = body?.error?.code;
    throw error;
  }
  return body;
}

/** Explains the most common environment problems instead of guessing. */
function printRendererHint(renderer) {
  if (renderer.ffmpeg === false || renderer.ffprobe === false) {
    const missing = renderer.ffmpeg === false ? 'ffmpeg' : 'ffprobe';
    console.log(`Hint: the Topaz ${missing} executable could not be run. Check FFMPEG_PATH /`);
    console.log('      FFPROBE_PATH and that Topaz Video AI is installed.');
    return;
  }
  if (renderer.nvencSelftest === false) {
    console.log(
      'Hint: the h264_nvenc self test failed — the API could not open an NVENC session with the same',
    );
    console.log(
      '      encoder settings a render uses. Read the "reason" line above (and the server log) for the',
    );
    console.log(
      '      ffmpeg error. If it says the driver/CUDA is missing the GPU is not usable by this process;',
    );
    console.log(
      '      if it names unsupported dimensions or parameters, the probe — not the GPU — is the problem.',
    );
    console.log(
      '      Development only: set ALLOW_DEGRADED_START=true to accept jobs anyway (they will fail at ' +
        'render time).',
    );
    return;
  }
  if (renderer.renderSelftest === false) {
    console.log(
      'Hint: the end-to-end render probe failed — the server could not render a 1 s generated clip ' +
        'with the same ffmpeg command a job uses.',
    );
    console.log(
      '      Common causes: the Topaz model is not downloaded, or the API runs as a Windows account ' +
        'that cannot read the model files.',
    );
    console.log(
      '      The "reason" line above and the server log ("render self test command: ...") carry the ' +
        'exact ffmpeg error; run that command by hand to reproduce it.',
    );
    return;
  }
  if (renderer.tvaiUp === false) {
    console.log(
      `Hint: the tvai_up filter is missing from ${config.ffmpegPath} — this is not a Topaz build.`,
    );
    return;
  }
  if (renderer.available === false) {
    console.log(`Hint: the renderer is unavailable (${renderer.reason || renderer.state}).`);
    return;
  }
  console.log(
    'Hint: the renderer reported itself as usable, so check the job error above and the server log ' +
      'for the ffmpeg diagnostic output.',
  );
}

/**
 * Fetches `/health` and proves it is *our* service: the default port is often taken
 * by an unrelated local app, which produces very confusing failures.
 */
async function fetchHealth(url) {
  let response;
  try {
    response = await fetch(`${url}/health`);
  } catch (error) {
    throw expectedError(
      `cannot reach ${url}/health (${error.cause?.code || error.message}). ` +
        'Is the API running? Start it with: npm start',
    );
  }

  const body = await response.json().catch(() => null);
  if (body?.service !== 'video-upscaler-api') {
    throw expectedError(
      `${url}/health answered ${JSON.stringify(body)}, which is not this API — another ` +
        'application is listening on that port. Pass the right base URL, e.g. ' +
        'npm run smoke -- http://127.0.0.1:<PORT>',
    );
  }
  return body;
}

/** An environment problem the operator can fix: reported without a stack trace. */
function expectedError(message) {
  const error = new Error(message);
  error.expected = true;
  return error;
}

async function main() {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vua-smoke-'));
  const fixture = path.join(workDir, 'smoke input.mp4');

  try {
    console.log(`service  : ${baseUrl}`);
    console.log(`ffmpeg   : ${config.ffmpegPath}`);

    const health = await fetchHealth(baseUrl);
    console.log(`health   : ${JSON.stringify(health)}`);

    const status = await (await fetch(`${baseUrl}/api/v1/system/status`)).json();
    console.log(
      `renderer : state=${status.renderer.state} usable=${status.renderer.usable} ` +
        `ffmpeg=${status.renderer.ffmpeg} ffprobe=${status.renderer.ffprobe} ` +
        `tvai_up=${status.renderer.tvaiUp} h264_nvenc=${status.renderer.h264Nvenc} ` +
        `nvenc_selftest=${status.renderer.nvencSelftest} ` +
        `render_selftest=${status.renderer.renderSelftest} model=${status.renderer.model}`,
    );
    if (status.renderer.reason) {
      console.log(`reason   : ${status.renderer.reason}`);
    }

    // The upload would be rejected with 503 RENDERER_UNAVAILABLE anyway, so say why
    // up front instead of leaving a mysterious failed job behind.
    if (!status.renderer.available) {
      console.log('\nSmoke test SKIPPED — the API is not accepting jobs right now.');
      printRendererHint(status.renderer);
      process.exitCode = 1;
      return;
    }

    const size = await createFixture(fixture);
    console.log(`fixture  : ${path.basename(fixture)} (${size} bytes)`);
    console.log(
      `options  : ${Object.keys(renderOptions).length > 0 ? JSON.stringify(renderOptions) : 'baseline (none)'}`,
    );

    const created = await upload(fixture).catch((error) => {
      console.log(`upload   : FAILED — ${error.message}`);
      return null;
    });
    if (!created) {
      printRendererHint(status.renderer || {});
      console.log('\nSmoke test did NOT start a render.');
      process.exitCode = 1;
      return;
    }
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
    printRendererHint(status.renderer || {});
    process.exitCode = 1;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    error.expected
      ? `smoke test failed: ${error.message}`
      : `smoke test failed: ${error.stack || error.message}`,
  );
  process.exitCode = 1;
});
