'use strict';

/**
 * Health and system status endpoints (AGENTS.md §23, §42).
 */

function createSystemController({ config, repository, queue, renderService, rendererService, startedAt }) {
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
        status: rendererState,
        state: renderer.state,
        ffmpeg: renderer.ffmpeg,
        ffprobe: renderer.ffprobe,
        tvaiUp: renderer.tvaiUp,
        h264Nvenc: renderer.h264Nvenc,
        nvencSelftest: renderer.nvencWorking,
        model: renderer.model,
        modelSelftest: renderer.modelWorking,
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
    });
  }

  return { health, status };
}

module.exports = { createSystemController };
