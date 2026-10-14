'use strict';

/**
 * Runtime settings service.
 *
 * Holds the values an operator can change through the API while the server is
 * running and that must survive a restart. Persistence lives in SQLite
 * (`settings`); the in-memory value is the fast path, and the effective output
 * directory is pushed into `paths` so the whole runtime (new uploads, the render
 * worker, cleanup) sees the change immediately.
 *
 * Only `outputDir` exists today: it is the default destination for jobs that do
 * not carry their own per-job `outputDir`.
 */

const { errors } = require('../utils/errors');

const OUTPUT_DIR_KEY = 'outputDir';

function createSettingsService({ config, paths, repository, logger }) {
  if (!repository) throw errors.internal('createSettingsService requires a settings repository.');

  /**
   * Restores persisted settings.
   *
   * A malformed row (blank or non-string) is discarded so it can never move the
   * render destination somewhere unusable.
   */
  function load() {
    const stored = repository.get(OUTPUT_DIR_KEY);
    if (typeof stored === 'string' && stored.trim()) {
      const dir = paths.setDefaultOutputDir(paths.resolveOutputDir(stored));
      logger?.info?.(`default output directory restored from settings: ${paths.redact(dir)}`);
      return { outputDir: dir, source: 'settings' };
    }
    if (stored !== null && stored !== undefined) repository.remove(OUTPUT_DIR_KEY);
    paths.setDefaultOutputDir(config.outputDir);
    return { outputDir: config.outputDir, source: 'environment' };
  }

  /** Machine-readable state for `GET /api/v1/system/output-dir`. */
  function describe() {
    return {
      outputDir: paths.currentOutputDir(),
      configured: config.outputDir,
      allowOverride: config.allowOutputDirOverride,
    };
  }

  /**
   * Sets (or, with `null`/`""`, resets) the default output directory for **new**
   * jobs. Already created jobs keep the directory stored on their row.
   *
   * @param {string|null} value absolute or relative directory, or null to reset
   * @returns {ReturnType<typeof describe>}
   */
  function setOutputDir(value) {
    if (!config.allowOutputDirOverride) {
      throw errors.validation(
        'Changing the output directory is disabled on this server (ALLOW_OUTPUT_DIR_OVERRIDE=false).',
        { field: 'outputDir' },
      );
    }

    const reset =
      value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
    if (!reset && typeof value !== 'string') {
      throw errors.validation('"outputDir" must be a string, or null to reset it.', {
        field: 'outputDir',
      });
    }

    if (reset) {
      repository.remove(OUTPUT_DIR_KEY);
      paths.setDefaultOutputDir(config.outputDir);
      logger?.info?.(
        `default output directory reset to OUTPUT_DIR (${paths.redact(config.outputDir)})`,
      );
      return describe();
    }

    // Relative values resolve under the current default; anything else is used
    // as given (no allowlist).
    const dir = paths.resolveOutputDir(value);
    if (paths.isSamePath(dir, config.outputDir)) {
      // Equal to the environment default: keep the environment as source of truth.
      repository.remove(OUTPUT_DIR_KEY);
    } else {
      repository.set(OUTPUT_DIR_KEY, dir);
    }
    paths.setDefaultOutputDir(dir);
    logger?.info?.(`default output directory set to ${paths.redact(dir)} (applies to new jobs)`);
    return describe();
  }

  return {
    OUTPUT_DIR_KEY,
    describe,
    getOutputDir: () => paths.currentOutputDir(),
    load,
    setOutputDir,
  };
}

module.exports = { createSettingsService, OUTPUT_DIR_KEY };
