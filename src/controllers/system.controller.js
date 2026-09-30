'use strict';

/**
 * Health and system status endpoints (AGENTS.md §23, §42).
 */

const { describeRenderOptions } = require('../domain/render-options');
const { errors } = require('../utils/errors');

function createSystemController({
  config,
  repository,
  queue,
  renderService,
  rendererService,
  settingsService,
  startedAt,
}) {
  function health(req, res) {
    res.json({
      status: 'ok',
      service: config.serviceName,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  }

  function status(req, res) {
    const renderer = rendererService.getStatus();
    const queueSnapshot = queue.snapshot();
    const counts = repository.countByStatus();
    const activeJobId = renderService.activeJobId();

    const rendererState = !renderer.available
      ? 'unavailable'
      : activeJobId
        ? 'busy'
        : 'available';

    res.json({
      status: renderer.available ? 'ok' : 'degraded',
      service: config.serviceName,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      renderer: {
        available: renderer.available,
        /** False when a self test failed: renders would fail. */
        usable: renderer.usable,
        status: rendererState,
        state: renderer.state,
        ffmpeg: renderer.ffmpeg,
        ffprobe: renderer.ffprobe,
        tvaiUp: renderer.tvaiUp,
        h264Nvenc: renderer.h264Nvenc,
        nvencSelftest: renderer.nvencWorking,
        model: renderer.model,
        renderSelftest: renderer.renderWorking,
        version: renderer.version,
        reason: renderer.reason,
        checkedAt: renderer.checkedAt,
        activeJobId,
      },
      queue: {
        concurrency: queueSnapshot.concurrency,
        queued: counts.queued ?? queueSnapshot.queued,
        processing: queueSnapshot.activeCount > 0,
        activeJobId,
        activeCount: queueSnapshot.activeCount,
        paused: queueSnapshot.paused,
        pausedReason: queueSnapshot.pausedReason,
      },
      jobs: { counts },
      thresholds: {
        maxUploadSizeBytes: config.maxUploadSizeBytes,
        minDimension: config.minDimension,
        maxDimension: config.maxDimension,
      },
      // Everything the frontend needs to build the render-options form.
      renderOptions: describeRenderOptions(config),
    });
  }

  /** `{ "outputDir": string | null }`; null resets to the configured OUTPUT_DIR. */
  function readOutputDirBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('outputDir' in body)) {
      throw errors.validation(
        'Send a JSON body of the form { "outputDir": "E:\\\\Renders" } (or "outputDir": null to reset).',
        { field: 'outputDir' },
      );
    }
    const value = body.outputDir;
    if (value !== null && typeof value !== 'string') {
      throw errors.validation('"outputDir" must be a string, or null to reset it.', {
        field: 'outputDir',
      });
    }
    return value;
  }

  /** GET /api/v1/system/output-dir — the current default render directory. */
  function getOutputDir(req, res) {
    res.json(settingsService.describe());
  }

  /** PUT /api/v1/system/output-dir — change the default for new jobs. */
  function setOutputDir(req, res) {
    const value = readOutputDirBody(req.body);
    res.json(settingsService.setOutputDir(value));
  }

  return { getOutputDir, health, setOutputDir, status };
}

module.exports = { createSystemController };
