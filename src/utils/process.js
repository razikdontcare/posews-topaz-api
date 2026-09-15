'use strict';

/**
 * Process management helpers.
 *
 * Rules enforced here:
 *  - never use a shell, never build a command string (only `spawn(file, args)`),
 *  - always `windowsHide: true`,
 *  - every child is tracked so it can be terminated on shutdown/cancel,
 *  - on Windows the process *tree* is terminated with `taskkill /T /F`.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const liveChildren = new Set();
const DEFAULT_TASKKILL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
  : 'taskkill.exe';

/**
 * Test/CI seam: when the configured executable is a Node script, run it through
 * the current Node binary. This lets the full render pipeline be exercised
 * without a GPU, while production always spawns the real Topaz executable.
 */
function resolveCommand(executablePath, args) {
  const extension = path.extname(executablePath || '').toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return { command: process.execPath, args: [executablePath, ...args], wrapped: true };
  }
  return { command: executablePath, args: [...args], wrapped: false };
}

/** Keeps only the last `maxBytes` of a stream (used for ffmpeg stderr). */
function createTailBuffer(maxBytes = 16384) {
  let buffer = Buffer.alloc(0);
  let totalBytes = 0;

  return {
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += data.byteLength;
      buffer = buffer.byteLength === 0 ? data : Buffer.concat([buffer, data]);
      if (buffer.byteLength > maxBytes) {
        buffer = buffer.subarray(buffer.byteLength - maxBytes);
      }
    },
    toString() {
      return buffer.toString('utf8');
    },
    get truncated() {
      return totalBytes > maxBytes;
    },
    get totalBytes() {
      return totalBytes;
    },
    get length() {
      return buffer.byteLength;
    },
  };
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

/** Resolves `true` when the child exited before the timeout. */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || hasExited(child)) return resolve(true);

    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      child.removeListener('error', onExit);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };

    child.once('exit', onExit);
    child.once('close', onExit);
    child.once('error', onExit);

    if (timeoutMs !== undefined && timeoutMs !== null) {
      timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

/** Spawns a child process and tracks it for cancellation/shutdown. */
function spawnProcess(executablePath, args, options = {}) {
  const { command, args: finalArgs } = resolveCommand(executablePath, args);
  const child = spawn(command, finalArgs, {
    windowsHide: true,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: options.env ?? process.env,
  });

  liveChildren.add(child);
  const untrack = () => liveChildren.delete(child);
  child.once('exit', untrack);
  child.once('error', untrack);
  return child;
}

function isWindows() {
  return process.platform === 'win32';
}

/** Best-effort liveness check for a pid recorded in the database. */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user/session.
    return error.code === 'EPERM';
  }
}

/**
 * Terminates a running child, escalating to `taskkill /PID <pid> /T /F` when the
 * graceful signal is not enough (Windows ignores it for console processes).
 * Resolves `true` when the process is gone.
 */
async function terminateProcessTree(child, options = {}) {
  const graceMs = options.graceMs ?? 5000;
  const finalWaitMs = options.finalWaitMs ?? 5000;
  const logger = options.logger;

  if (hasExited(child)) return true;
  const { pid } = child;

  try {
    child.kill('SIGTERM');
  } catch (error) {
    logger?.debug?.(`SIGTERM failed for pid ${pid}: ${error.message}`);
  }
  if (await waitForExit(child, graceMs)) return true;

  if (isWindows() && Number.isInteger(pid) && pid > 0) {
    logger?.debug?.(`forcing taskkill /T /F on pid ${pid}`);
    await runCommand(DEFAULT_TASKKILL, ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15000 });
  }
  if (await waitForExit(child, finalWaitMs)) return true;

  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  return waitForExit(child, 2000);
}

/**
 * Best-effort executable name for a pid (Windows only, via `tasklist`).
 * Used to make sure a pid recorded before a crash still belongs to the renderer:
 * Windows reuses pids, and `taskkill /T /F` on a recycled pid would kill an
 * unrelated process tree.
 *
 * @returns {Promise<string|null>} lowercased image name (e.g. `ffmpeg.exe`)
 */
async function getProcessImageName(pid) {
  if (!isWindows() || !Number.isInteger(pid) || pid <= 0) return null;
  const tasklist = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tasklist.exe')
    : 'tasklist.exe';
  const result = await runCommand(tasklist, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    timeoutMs: 10000,
  });
  if (result.code !== 0 || result.spawnError) return null;
  const match = /^\s*"([^"]+)"/m.exec(result.stdout);
  return match ? match[1].trim().toLowerCase() : null;
}

/**
 * Terminates an orphan process tree by pid (used for crashed-job recovery).
 *
 * @param {number} pid
 * @param {{ logger?: object, waitMs?: number, expectedImage?: string }} [options]
 *   `expectedImage` (e.g. `ffmpeg`) refuses to kill a pid that now belongs to a
 *   different program.
 */
async function terminatePidTree(pid, options = {}) {
  const logger = options.logger;
  if (!isProcessAlive(pid)) return true;

  if (options.expectedImage) {
    const image = await getProcessImageName(pid);
    const expected = String(options.expectedImage).toLowerCase();
    if (image === null) {
      logger?.warn?.(`could not determine what pid ${pid} is; leaving it alone`);
      return false;
    }
    if (!image.includes(expected)) {
      logger?.warn?.(`pid ${pid} is ${image}, not ${expected}; refusing to kill it`);
      return false;
    }
  }

  if (isWindows()) {
    await runCommand(DEFAULT_TASKKILL, ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15000 });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  const deadline = Date.now() + (options.waitMs ?? 5000);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  logger?.warn?.(`process ${pid} still alive after termination attempt`);
  return !isProcessAlive(pid);
}

/**
 * Runs a one-shot command and buffers its output (bounded).
 * Resolves with `{ code, signal, stdout, stderrTail, timedOut, spawnError }`.
 */
function runCommand(executablePath, args, options = {}) {
  return new Promise((resolve) => {
    const stdout = createTailBuffer(options.maxOutputBytes ?? 4 * 1024 * 1024);
    const stderr = createTailBuffer(options.stderrTailBytes ?? 8192);
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawnProcess(executablePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: options.env,
      });
    } catch (error) {
      return finish({
        code: null,
        signal: null,
        stdout: '',
        stderrTail: error.message,
        timedOut: false,
        spawnError: error,
      });
    }

    if (options.timeoutMs) {
      timer = setTimeout(async () => {
        timedOut = true;
        await terminateProcessTree(child, { graceMs: 2000, finalWaitMs: 3000 });
        finish({
          code: null,
          signal: 'SIGKILL',
          stdout: stdout.toString(),
          stderrTail: stderr.toString(),
          timedOut: true,
          spawnError: null,
        });
      }, options.timeoutMs);
    }

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.once('error', (error) =>
      finish({
        code: null,
        signal: null,
        stdout: stdout.toString(),
        stderrTail: error.message,
        timedOut,
        spawnError: error,
      }),
    );
    child.once('close', (code, signal) =>
      finish({
        code,
        signal,
        stdout: stdout.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTail: stderr.toString(),
        stderrTruncated: stderr.truncated,
        timedOut,
        spawnError: null,
      }),
    );
  });
}

/** Terminates every child this process spawned; used during shutdown. */
async function killAllProcesses(options = {}) {
  const children = [...liveChildren];
  await Promise.all(
    children.map((child) =>
      terminateProcessTree(child, {
        graceMs: options.graceMs ?? 2000,
        finalWaitMs: options.finalWaitMs ?? 5000,
        logger: options.logger,
      }).catch(() => false),
    ),
  );
  return children.length;
}

function liveProcessCount() {
  return liveChildren.size;
}

function liveProcessPids() {
  return [...liveChildren].map((child) => child.pid).filter(Number.isInteger);
}

module.exports = {
  createTailBuffer,
  DEFAULT_TASKKILL,
  getProcessImageName,
  hasExited,
  isProcessAlive,
  isWindows,
  killAllProcesses,
  liveProcessCount,
  liveProcessPids,
  resolveCommand,
  runCommand,
  spawnProcess,
  terminatePidTree,
  terminateProcessTree,
  waitForExit,
};
