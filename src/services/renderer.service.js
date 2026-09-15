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
 *   degraded    - binaries + tvai_up are fine, but the NVENC self test failed
 *                 (e.g. no NVIDIA driver); jobs are accepted and will surface the
 *                 real error if they cannot render
 *   unavailable - fatal checks failed at startup or the renderer failed at
 *                 runtime (missing executable, killed process tree, ...)
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

const STATES = Object.freeze({
  READY: 'ready',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

function createRendererService({ config, logger, runCommand, fileExists = defaultFileExists }) {
  let status = {
    state: STATES.UNKNOWN,
    available: false,
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

  function markUnavailable(reason) {
    logger?.warn?.(`renderer marked unavailable: ${reason}`);
    status = {
      ...status,
      state: STATES.UNAVAILABLE,
      available: false,
      reason,
      checkedAt: new Date().toISOString(),
    };
    return snapshot();
  }

  function markReady() {
    status = {
      ...status,
      state: STATES.READY,
      available: true,
      reason: null,
      checkedAt: new Date().toISOString(),
    };
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
    if (config.rendererSelftest && probe.h264Nvenc) {
      const selftest = await runCommand(config.ffmpegPath, CAPABILITY_COMMANDS.selftest, {
        timeoutMs: config.rendererSelftestTimeoutMs,
      });
      probe.nvencWorking = !selftest.spawnError && !selftest.timedOut && selftest.code === 0;
      if (!probe.nvencWorking) {
        warnings.push(
          `h264_nvenc self test failed: ${summarizeStderr(selftest.stderrTail, 400) || 'unknown reason'}`,
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
        const reason = summarizeStderr(modelSelftest.stderrTail, 400) || 'unknown reason';
        warnings.push(
          `Topaz model "${config.topazModel}" could not be loaded: ${reason}. ` +
            'Open Topaz Video AI once so it can download the model, or set TOPAZ_MODEL to an ' +
            'installed model.',
        );
      }
    }

    const state = warnings.length > 0 ? STATES.DEGRADED : STATES.READY;
    status = {
      ...status,
      state,
      available: true,
      ...probe,
      reason: warnings[0] || null,
      checkedAt: new Date().toISOString(),
      warnings,
    };

    return {
      ok: true,
      state,
      fatalErrors,
      warnings,
      status: snapshot(),
    };
  }

  /**
   * Gate used by the queue/worker: re-validates at most once per cooldown while
   * unavailable, so a fixed driver/Topaz install is picked up automatically.
   */
  async function ensureAvailable() {
    if (status.available) return true;
    const since = Date.now() - lastCheckAt;
    if (status.state === STATES.UNAVAILABLE && since < config.rendererRecheckCooldownMs) {
      return false;
    }
    const result = await validate();
    if (result.ok) {
      logger?.info?.('renderer is available again');
    }
    return result.ok;
  }

  return {
    STATES,
    ensureAvailable,
    getStatus: snapshot,
    isAvailable,
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
