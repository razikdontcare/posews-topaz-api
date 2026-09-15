'use strict';

/**
 * FFprobe service.
 *
 * Used for two things:
 *  1. validating an upload is a readable video before a job is created (§8),
 *  2. obtaining `duration` so progress can be computed (§13).
 *
 * Always the Topaz Video AI ffprobe binary, always via `spawn` (never a shell),
 * always with a timeout and bounded output buffers.
 */

const { AppError, errors, toAppError } = require('../utils/errors');
const { buildProbeArgs, summarizeStderr } = require('../utils/ffmpeg');

function parseDuration(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.toUpperCase() === 'N/A') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** `30/1` -> 30 (frames per second). */
function parseFrameRate(value) {
  if (!value) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized === '0/0') return null;
  const [numerator, denominator] = normalized.split('/');
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top <= 0) return null;
  return top / bottom;
}

function createProbeService({ config, paths, logger, runCommand }) {
  /**
   * @returns {Promise<{
   *   durationSeconds: number|null, formatName: string|null, hasVideo: boolean,
   *   hasAudio: boolean, audioCodec: string|null, video: object|null,
   *   audioStreams: object[], streams: object[]
   * }>}
   * @throws {AppError} FFPROBE_ERROR / RENDERER_UNAVAILABLE
   */
  async function probe(filePath, options = {}) {
    const timeoutMs = options.timeoutMs ?? config.probeTimeoutMs;
    const result = await runCommand(config.ffprobePath, buildProbeArgs(filePath), {
      timeoutMs,
      maxOutputBytes: 2 * 1024 * 1024,
      stderrTailBytes: 8192,
    });

    if (result.spawnError) {
      throw new AppError(
        'RENDERER_UNAVAILABLE',
        `FFprobe could not be started (${config.ffprobePath}): ${result.spawnError.message}`,
        { cause: result.spawnError },
      );
    }
    if (result.timedOut) {
      throw new AppError('FFPROBE_ERROR', `FFprobe timed out after ${timeoutMs} ms.`);
    }
    if (result.code !== 0) {
      const summary = summarizeStderr(result.stderrTail, config.maxStderrSummaryLength);
      logger?.debug?.(`ffprobe exit ${result.code}: ${summary}`);
      throw new AppError('INVALID_VIDEO', 'Uploaded file could not be read as a video.', {
        details: { ffprobe: paths.redact(summary) },
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new AppError('INVALID_VIDEO', 'Uploaded file could not be read as a video.', {
        details: { reason: 'FFprobe did not return valid JSON.' },
        cause: error,
      });
    }

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video') || null;
    const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');

    const streamDuration = videoStream ? parseDuration(videoStream.duration) : null;
    // Some containers only expose nb_frames + frame rate: without a duration the
    // progress percentage could never be computed (§18).
    const frameRate = parseFrameRate(videoStream?.avg_frame_rate);
    const totalFrames = parseDuration(videoStream?.nb_frames);
    const estimatedDuration =
      frameRate && totalFrames ? Number((totalFrames / frameRate).toFixed(3)) : null;
    const durationSeconds =
      parseDuration(parsed.format?.duration) ?? streamDuration ?? estimatedDuration;

    return {
      durationSeconds,
      formatName: parsed.format?.format_name ?? null,
      hasVideo: Boolean(videoStream),
      hasAudio: audioStreams.length > 0,
      audioCodec: audioStreams.length > 0 ? audioStreams[0].codec_name ?? null : null,
      video: videoStream
        ? {
            codec: videoStream.codec_name ?? null,
            width: Number.isFinite(videoStream.width) ? videoStream.width : null,
            height: Number.isFinite(videoStream.height) ? videoStream.height : null,
            avgFrameRate: videoStream.avg_frame_rate ?? null,
          }
        : null,
      audioStreams,
      streams: streams.map((stream) => ({
        index: stream.index,
        codecType: stream.codec_type,
        codec: stream.codec_name,
      })),
    };
  }

  /**
   * Probe + strict validation for uploads. Throws INVALID_VIDEO when the file
   * cannot be decoded as a video with a video stream.
   */
  async function inspect(filePath, options = {}) {
    let result;
    try {
      result = await probe(filePath, options);
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_VIDEO') throw error;
      throw toAppError(error, 'FFPROBE_ERROR');
    }

    if (!result.hasVideo) {
      throw errors.invalidVideo('Uploaded file does not contain a video stream.');
    }
    return result;
  }

  /** Duration only; `null` when it cannot be determined. */
  async function probeDuration(filePath, options = {}) {
    try {
      const result = await probe(filePath, options);
      return result.durationSeconds;
    } catch (error) {
      logger?.debug?.(`duration probe failed: ${error.message}`);
      return null;
    }
  }

  return { inspect, probe, probeDuration };
}

module.exports = { createProbeService, parseDuration, parseFrameRate };
