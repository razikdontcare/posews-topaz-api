'use strict';

/**
 * Per-job output directory resolution (paths.resolveOutputDir / outputDirFor).
 *
 * The output directory is the only path a client may influence, so these are the
 * tests that keep `OUTPUT_DIR_ALLOWLIST` airtight: relative subdirectories are
 * resolved under the default, absolute paths must live inside an allowed root and
 * anything else is rejected before the upload is even accepted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createConfig } = require('../../src/config/env');
const { createPaths } = require('../../src/config/paths');
const { isAppError } = require('../../src/utils/errors');

function fixture(overrides = {}) {
  const root = path.join(os.tmpdir(), 'vua-paths-fixture');
  const outputDir = path.join(root, 'output');
  const config = createConfig({
    nodeEnv: 'test',
    tempDir: path.join(root, 'temp'),
    outputDir,
    dataDir: path.join(root, 'data'),
    logsDir: path.join(root, 'logs'),
    ...overrides,
  });
  return { config, paths: createPaths(config), outputDir, root };
}

test('an absent or empty outputDir falls back to the configured default', () => {
  const { paths, outputDir } = fixture();
  assert.equal(paths.resolveOutputDir(undefined), outputDir);
  assert.equal(paths.resolveOutputDir(null), outputDir);
  assert.equal(paths.resolveOutputDir(''), outputDir);
  assert.equal(paths.resolveOutputDir('   '), outputDir);
});

test('a relative outputDir is resolved under the default output directory', () => {
  const { paths, outputDir } = fixture();
  assert.equal(paths.resolveOutputDir('clients/acme'), path.join(outputDir, 'clients', 'acme'));
  assert.equal(paths.resolveOutputDir('clients\\acme'), path.join(outputDir, 'clients', 'acme'));
  assert.equal(paths.resolveOutputDir('./2026/09'), path.join(outputDir, '2026', '09'));
});

test('an absolute outputDir inside an allowed root is accepted', () => {
  const { paths, outputDir } = fixture();
  const inside = path.join(outputDir, 'nested', 'deep');
  assert.equal(paths.resolveOutputDir(inside), inside);
  // Whitespace and surrounding quotes are tolerated (copy/paste from the UI).
  assert.equal(paths.resolveOutputDir(`  "${inside}"  `), inside);
});

test('an outputDir outside every allowed root is rejected', () => {
  const { paths, root } = fixture();
  for (const candidate of [path.join(root, 'elsewhere'), os.tmpdir(), 'C:\\Windows\\Temp']) {
    assert.throws(
      () => paths.resolveOutputDir(candidate),
      (error) => isAppError(error) && error.code === 'VALIDATION_ERROR',
      `expected ${candidate} to be rejected`,
    );
  }
});

test('path traversal cannot escape the output roots', () => {
  const { paths } = fixture();
  for (const candidate of ['../../evil', '..\\..\\evil', 'clients/../../evil']) {
    assert.throws(
      () => paths.resolveOutputDir(candidate),
      (error) => isAppError(error) && error.code === 'VALIDATION_ERROR',
      `expected ${candidate} to be rejected`,
    );
  }
});

test('a sibling directory sharing a prefix with a root is not "inside" it', () => {
  const { paths, outputDir } = fixture();
  assert.equal(paths.isAllowedOutputDir(`${outputDir}-evil`), false);
  assert.equal(paths.isAllowedOutputDir(outputDir), true);
  assert.equal(paths.isAllowedOutputDir(path.join(outputDir, 'file.mp4')), true);
});

test('additional OUTPUT_DIR_ALLOWLIST roots are usable and the default stays allowed', () => {
  const extraRoot = path.join(os.tmpdir(), 'vua-paths-extra');
  const { paths, outputDir } = fixture({ allowedOutputRoots: [extraRoot] });

  assert.equal(paths.resolveOutputDir(extraRoot), extraRoot);
  assert.equal(paths.resolveOutputDir(path.join(extraRoot, 'client')), path.join(extraRoot, 'client'));
  // The default output directory is always part of the allowlist.
  assert.equal(paths.resolveOutputDir('sub'), path.join(outputDir, 'sub'));
  assert.equal(paths.resolveOutputDir(outputDir), outputDir);
});

test('outputDirFor honours the job row and falls back safely', () => {
  const { paths, outputDir } = fixture();
  const custom = path.join(outputDir, 'clients', 'acme');

  assert.equal(paths.outputDirFor({ output_dir: custom }), custom);
  // Legacy rows (no column) and unset values use the default.
  assert.equal(paths.outputDirFor({ output_dir: null }), outputDir);
  assert.equal(paths.outputDirFor({}), outputDir);
  assert.equal(paths.outputDirFor(null), outputDir);
  // A stored directory that is no longer allowed never escapes the roots.
  assert.equal(paths.outputDirFor({ output_dir: os.tmpdir() }), outputDir);
});

test('tempOutputPath and outputPath stay inside the requested directory', () => {
  const { paths, outputDir } = fixture();
  const custom = path.join(outputDir, 'clients', 'acme');
  const jobId = 'aaaaaaaa-0000-4000-8000-000000000001';

  assert.equal(
    paths.tempOutputPath(jobId, '.mp4', custom),
    path.join(custom, `.${jobId}.rendering.mp4`),
  );
  assert.equal(paths.tempOutputPath(jobId), path.join(outputDir, `.${jobId}.rendering.mp4`));
  assert.equal(paths.outputPath('out.mp4', custom), path.join(custom, 'out.mp4'));

  assert.throws(
    () => paths.tempOutputPath(jobId, '.mp4', os.tmpdir()),
    (error) => isAppError(error) && error.code === 'VALIDATION_ERROR',
  );
});
