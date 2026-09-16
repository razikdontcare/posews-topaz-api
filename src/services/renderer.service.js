'use strict';

/**
 * Renderer (Topaz Video AI ffmpeg/ffprobe) availability.
 *
 * Startup validation happens before the HTTP server starts listening so a broken
 * Topaz installation or a missing `tvai_up` filter is reported immediately
 * instead of when the first video is uploaded (AGENTS.md §24).
 *
 * Status levels:
 *   ready       - every check passed
 *   degraded    - binaries + tvai_up are fine, but a self test failed (no usable
 *                 NVIDIA driver, Topaz model not downloaded); renders cannot work,
 *                 so new uploads are rejected until the check passes again
 *   unavailable - fatal checks failed at startup or the renderer failed at
 *                 runtime (missing executable, killed process tree, ...)
 *
 * The self tests mirror the command a render runs (same encoder block, same
 * `tvai_up` parameters) so a failure here really does predict a failed render.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  CAPABILITY_COMMANDS,
  buildModelSelftestArgs,
  hasEncoder,
  hasFilter,
  summarizeStderr,
} = require('../utils/ffmpeg');
const { formatCommand } = require('../utils/process');

const STATES = Object.freeze({
  READY: 'ready',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

/**
 * Turns a failed capability probe into a reason an operator can act on.
 *
 * A bare stderr summary is ambiguous: an empty one used to be reported as
 * "unknown reason", which hides the difference between a hung GPU and an ffmpeg
 * that exited silently — two problems with very different fixes.
 */
function describeProbeFailure(result, { label, timeoutMs }) {
  if (result.spawnError) {
    return `${label} could not be started: ${result.spawnError.message}`;
  }
  if (result.timedOut) {
    return `${label} did not finish within ${timeoutMs} ms and was killed (the GPU may be hung)`;
  }
  return (
    summarizeStderr(result.stderrTail, 400) ||
    `${label} exited with code ${result.code} without any diagnostic output`
  );
}

function createRendererService({ config, logger, runCommand, fileExists = defaultFileExists }) {
  let status = {
    state: STATES.UNKNOWN,
    available: false,
    /** False when a self test failed: the renderer cannot produce output. */
    usable: false,
    ffmpeg: false,
    ffprobe: false,
    tvaiUp: false,
    h264Nvenc: false,
    nvencWorking: null,
    model: config.topazModel,
    modelWorking: null,
    version: null,
    reason: null,
    checkedAt: null,
    warnings: [],
  };
  let lastCheckAt = 0;

  function snapshot() {
    return { ...status, warnings: [...status.warnings] };
  }

  function isAvailable() {
    return status.available;
  }

  /** True when the last validation proved the renderer can actually render. */
  function isUsable() {
    return status.usable;
  }

  function markUnavailable(reason) {
    logger?.warn?.(`renderer marked unavailable: ${reason}`);
    status = {
      ...status,
      state: STATES.UNAVAILABLE,
      available: false,
      usable: false,
      reason,
      checkedAt: new Date().toISOString(),
    };
    lastCheckAt = Date.now();
    return snapshot();
  }

  function markReady() {
    status = {
      ...status,
      state: STATES.READY,
      available: true,
      usable: true,
      reason: null,
      checkedAt: new Date().toISOString(),
    };
    lastCheckAt = Date.now();
    return snapshot();
  }

  /**
   * Executes the full validation suite.
   * @returns {Promise<{ ok: boolean, state: string, fatalErrors: string[], warnings: string[], status: object }>}
   */
  async function validate() {
    const fatalErrors = [];
    const warnings = [];
    const probe = {
      ffmpeg: false,
      ffprobe: false,
      tvaiUp: false,
      h264Nvenc: false,
      nvencWorking: null,
      model: config.topazModel,
      modelWorking: null,
      version: null,
    };

    lastCheckAt = Date.now();

    // 1/2. binaries must exist
    const ffmpegExists = await fileExists(config.ffmpegPath);
    const ffprobeExists = await fileExists(config.ffprobePath);
    if (!ffmpegExists) {
      fatalErrors.push(`FFmpeg executable was not found at: ${config.ffmpegPath}`);
    }
    if (!ffprobeExists) {
      fatalErrors.push(`FFprobe executable was not found at: ${config.ffprobePath}`);
    }
    for (const [label, binaryPath] of [
      ['FFMPEG_PATH', config.ffmpegPath],
      ['FFPROBE_PATH', config.ffprobePath],
    ]) {
      const parent = path.dirname(binaryPath).toLowerCase();
      if (!parent.includes('topaz')) {
        warnings.push(
          `${label} does not point inside a Topaz Video AI installation (${binaryPath}); ` +
            'make sure this is intentional.',
        );
      }
    }

    if (!ffmpegExists || !ffprobeExists) {
      status = {
        ...status,
        state: STATES.UNAVAILABLE,
        available: false,
        ffmpeg: ffmpegExists,
        ffprobe: ffprobeExists,
        tvaiUp: false,
        h264Nvenc: false,
        nvencWorking: null,
        reason: fatalErrors[0],
        checkedAt: new Date().toISOString(),
        warnings,
      };
      return { ok: false, state: status.state, fatalErrors, warnings, status: snapshot() };
    }
    probe.ffmpeg = true;
    probe.ffprobe = true;

    // 3. ffmpeg must actually execute
    const versionResult = await runCommand(config.ffmpegPath, CAPABILITY_COMMANDS.version, {
      timeoutMs: config.rendererCheckTimeoutMs,
    });
    if (versionResult.spawnError) {
      fatalErrors.push(
        `FFmpeg could not be executed (${config.ffmpegPath}): ${versionResult.spawnError.message}`,
      );
    } else if (versionResult.timedOut) {
      fatalErrors.push(`FFmpeg did not respond to -version within the timeout (${config.ffmpegPath}).`);
    } else if (versionResult.code !== 0) {
      fatalErrors.push(
        `FFmpeg exited with code ${versionResult.code}: ${summarizeStderr(versionResult.stderrTail, 300)}`,
      );
    } else {
      const match = /version\s+([^\s]+)/i.exec(versionResult.stdout);
      probe.version = match ? match[1] : null;
    }
    if (fatalErrors.length > 0) {
      status = {
        ...status,
        state: STATES.UNAVAILABLE,
        available: false,
        ...probe,
        reason: fatalErrors[0],
        checkedAt: new Date().toISOString(),
        warnings,
      };
      return { ok: false, state: status.state, fatalErrors, warnings, status: snapshot() };
    }

    // 4. ffprobe must actually execute
    const ffprobeResult = await runCommand(config.ffprobePath, CAPABILITY_COMMANDS.version, {
      timeoutMs: config.rendererCheckTimeoutMs,
    });
    if (ffprobeResult.spawnError) {
      fatalErrors.push(
        `FFprobe could not be executed (${config.ffprobePath}): ${ffprobeResult.spawnError.message}`,
      );
    } else if (ffprobeResult.timedOut) {
      fatalErrors.push(`FFprobe did not respond within the timeout (${config.ffprobePath}).`);
    } else if (ffprobeResult.code !== 0) {
      fatalErrors.push(
        `FFprobe exited with code ${ffprobeResult.code}: ${summarizeStderr(ffprobeResult.stderrTail, 300)}`,
      );
    }
    if (fatalErrors.length > 0) {
      status = {
        ...status,
        state: STATES.UNAVAILABLE,
        available: false,
        ...probe,
        reason: fatalErrors[0],
        checkedAt: new Date().toISOString(),
        warnings,
      };
      return { ok: false, state: status.state, fatalErrors, warnings, status: snapshot() };
    }

    // 5. the Topaz filter must be compiled into this ffmpeg
    const filtersResult = await runCommand(config.ffmpegPath, CAPABILITY_COMMANDS.filters, {
      timeoutMs: config.rendererCheckTimeoutMs,
    });
    probe.tvaiUp = filtersResult.code === 0 && hasFilter(filtersResult.stdout);
    if (!probe.tvaiUp) {
      fatalErrors.push(
        'Renderer validation failed:\n' +
          'tvai_up filter was not found in:\n' +
          `${config.ffmpegPath}`,
      );
    }

    // 6. hardware encoder availability
    const encodersResult = await runCommand(config.ffmpegPath, CAPABILITY_COMMANDS.encoders, {
      timeoutMs: config.rendererCheckTimeoutMs,
    });
    probe.h264Nvenc = encodersResult.code === 0 && hasEncoder(encodersResult.stdout);
    if (!probe.h264Nvenc) {
      const message =
        `h264_nvenc was not found in: ${config.ffmpegPath}. ` +
        'An NVIDIA GPU with a current driver is required.';
      if (config.requireNvenc) fatalErrors.push(message);
      else warnings.push(message);
    }

    if (fatalErrors.length > 0) {
      status = {
        ...status,
        state: STATES.UNAVAILABLE,
        available: false,
        ...probe,
        reason: fatalErrors[0],
        checkedAt: new Date().toISOString(),
        warnings,
      };
      return { ok: false, state: status.state, fatalErrors, warnings, status: snapshot() };
    }

    // 7. deep check: can an NVENC session actually be created?
    //    A failure here means renders cannot work at all, so it does not just
    //    warn: the renderer stops accepting jobs (see `available` below).
    const renderBlocker = [];
    if (config.rendererSelftest && probe.h264Nvenc) {
      const selftest = await runCommand(config.ffmpegPath, CAPABILITY_COMMANDS.selftest, {
        timeoutMs: config.rendererSelftestTimeoutMs,
      });
      probe.nvencWorking = !selftest.spawnError && !selftest.timedOut && selftest.code === 0;
      if (!probe.nvencWorking) {
        // The command is logged, never returned: it proves the probe matches what a
        // render runs and lets the operator reproduce the failure by hand.
        logger?.warn?.(
          `NVENC self test command: ${formatCommand(config.ffmpegPath, CAPABILITY_COMMANDS.selftest)}`,
        );
        renderBlocker.push(
          `h264_nvenc self test failed: ${describeProbeFailure(selftest, {
            label: 'the NVENC check',
            timeoutMs: config.rendererSelftestTimeoutMs,
          })}`,
        );
      }
    }

    // 8. can the configured Topaz model actually be loaded? (Catches "Model not
    //    found: prob-3" before the first multi-gigabyte upload.) Skipped when the
    //    GPU itself is unusable, because the model check cannot say anything then.
    if (config.rendererModelSelftest && probe.nvencWorking !== false) {
      const modelSelftest = await runCommand(
        config.ffmpegPath,
        buildModelSelftestArgs({ model: config.topazModel }),
        { timeoutMs: config.rendererSelftestTimeoutMs },
      );
      probe.modelWorking =
        !modelSelftest.spawnError && !modelSelftest.timedOut && modelSelftest.code === 0;
      if (!probe.modelWorking) {
        const reason = describeProbeFailure(modelSelftest, {
          label: 'the Topaz model check',
          timeoutMs: config.rendererSelftestTimeoutMs,
        });
        logger?.warn?.(
          `Topaz model self test command: ${formatCommand(
            config.ffmpegPath,
            buildModelSelftestArgs({ model: config.topazModel }),
          )}`,
        );
        renderBlocker.push(
          `Topaz model "${config.topazModel}" could not be loaded: ${reason}. ` +
            'Open Topaz Video AI once so it can download the model, or set TOPAZ_MODEL to an ' +
            'installed model.',
        );
      }
    }

    warnings.push(...renderBlocker);

    // A failed self test does not stop the process (the operator needs the status
    // endpoint and the logs to diagnose it), but the renderer is not *usable*: new
    // uploads are rejected with 503 and queued jobs wait instead of failing.
    const usable = renderBlocker.length === 0;
    const state = renderBlocker.length > 0 ? STATES.DEGRADED : warnings.length > 0 ? STATES.DEGRADED : STATES.READY;
    status = {
      ...status,
      state,
      available: usable || config.allowDegradedStart,
      usable,
      ...probe,
      reason: renderBlocker[0] || warnings[0] || null,
      checkedAt: new Date().toISOString(),
      warnings,
    };

    return {
      ok: true,
      state,
      usable,
      fatalErrors,
      warnings,
      status: snapshot(),
    };
  }

  /**
   * Gate used by the queue, the worker and the upload endpoint: re-validates at
   * most once per cooldown while the renderer is not usable, so a fixed
   * driver/model is picked up automatically.
   */
  async function ensureAvailable() {
    if (status.available) return true;
    const since = Date.now() - lastCheckAt;
    if (since < config.rendererRecheckCooldownMs) return false;
    const result = await validate();
    if (result.ok && result.usable) {
      logger?.info?.('renderer is available again');
    }
    return status.available;
  }

  return {
    STATES,
    ensureAvailable,
    getStatus: snapshot,
    isAvailable,
    isUsable,
    markReady,
    markUnavailable,
    validate,
  };
}

async function defaultFileExists(target) {
  try {
    const stats = await fs.promises.stat(target);
    return stats.isFile();
  } catch {
    return false;
  }
}

module.exports = { createRendererService, STATES };
