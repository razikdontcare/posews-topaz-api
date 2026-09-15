'use strict';
/* Temporary verification: clean boot, single-instance guard, status endpoint. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { terminateProcessTree } = require('./src/utils/process');

const ROOT = path.resolve(__dirname);
const PORT = 3212;

function makeEnv(dataDir) {
  return {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    TEMP_DIR: path.join(dataDir, 'temp'),
    OUTPUT_DIR: path.join(dataDir, 'output'),
    DATA_DIR: dataDir,
    LOGS_DIR: path.join(dataDir, 'logs'),
  };
}

function start(dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    windowsHide: true,
    env: makeEnv(dataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  return { child, logs, exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

(async () => {
  const dataDir = path.join(os.tmpdir(), `vua-verify-${randomUUID()}`);
  await fsp.mkdir(dataDir, { recursive: true });

  const first = start(dataDir);
  const health = await waitForHealth();
  console.log('1) first instance health:', JSON.stringify(health));
  if (!health) {
    console.log('LOGS:\n' + first.logs.join(''));
    process.exit(1);
  }

  const lockFile = path.join(dataDir, 'video-upscaler.lock');
  console.log('2) lock file exists:', fs.existsSync(lockFile), JSON.stringify(JSON.parse(await fsp.readFile(lockFile, 'utf8'))));
  console.log('3) system status:', (await (await fetch(`http://127.0.0.1:${PORT}/api/v1/system/status`)).json()).renderer.state);

  const second = start(dataDir);
  const secondCode = await second.exited;
  console.log('4) second instance exit code:', secondCode);
  const secondLog = second.logs.join('');
  console.log('   refusal message:', /only one renderer may own the gpu/i.test(secondLog) ? 'OK' : secondLog.slice(-600));

  // SIGTERM is not catchable on Windows: kill hard and verify the next start takes
  // the stale lock over (simulated crash + restart).
  await terminateProcessTree(first.child, { graceMs: 500 });
  const third = start(dataDir);
  const thirdHealth = await waitForHealth();
  console.log('5) restart after crash health:', JSON.stringify(thirdHealth));
  await terminateProcessTree(third.child, { graceMs: 500 });
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
})();
