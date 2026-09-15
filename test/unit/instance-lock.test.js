'use strict';

/**
 * Single instance guard (one process owns the GPU renderer).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { acquireInstanceLock, releaseInstanceLock } = require('../../src/startup');
const { terminateProcessTree } = require('../../src/utils/process');
const { createPaths } = require('../../src/config/paths');
const { createConfig } = require('../../src/config/env');

async function createFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vua-lock-'));
  const config = createConfig({ dataDir: root, tempDir: path.join(root, 'temp'), outputDir: path.join(root, 'out') });
  return { root, paths: createPaths(config) };
}

test('acquires the lock, refuses a live holder and takes over a stale one', async () => {
  const fixture = await createFixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });

  try {
    // A foreign, live process holds the lock.
    const lockFile = path.join(fixture.paths.dataDir, 'video-upscaler.lock');
    await fsp.writeFile(
      lockFile,
      JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
    );

    await assert.rejects(
      () => acquireInstanceLock({ paths: fixture.paths }),
      (error) => {
        assert.equal(error.code, 'SERVICE_UNAVAILABLE');
        assert.match(error.message, new RegExp(`pid ${child.pid}`));
        assert.match(error.message, /one renderer may own the GPU/i);
        return true;
      },
    );

    // Once that process is gone the lock is stale and must be taken over.
    await terminateProcessTree(child, { graceMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const lock = await acquireInstanceLock({ paths: fixture.paths });
    assert.equal(lock.lockFile, lockFile);
    const stored = JSON.parse(await fsp.readFile(lockFile, 'utf8'));
    assert.equal(stored.pid, process.pid);

    // Releasing removes it, so a restart never trips over a stale file.
    await releaseInstanceLock(lock);
    await assert.rejects(() => fsp.stat(lockFile), /ENOENT/);

    // A second acquire by the same process is allowed (simulated restart).
    const second = await acquireInstanceLock({ paths: fixture.paths });
    await releaseInstanceLock(second);
  } finally {
    await terminateProcessTree(child, { graceMs: 500 });
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('a corrupt lock file is replaced instead of blocking startup', async () => {
  const fixture = await createFixture();
  try {
    const lockFile = path.join(fixture.paths.dataDir, 'video-upscaler.lock');
    await fsp.mkdir(fixture.paths.dataDir, { recursive: true });
    await fsp.writeFile(lockFile, `${randomUUID()} not json at all`);

    const lock = await acquireInstanceLock({ paths: fixture.paths });
    const stored = JSON.parse(await fsp.readFile(lock.lockFile, 'utf8'));
    assert.equal(stored.pid, process.pid);
    await releaseInstanceLock(lock);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});
