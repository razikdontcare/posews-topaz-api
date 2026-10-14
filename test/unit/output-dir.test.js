'use strict';

/**
 * Per-job output directory resolution (paths.resolveOutputDir / outputDirFor).
 *
 * There is no allowlist: the renderer runs on a trusted machine, so any
 * destination is honoured. These tests pin the resolution rules that remain —
 * empty values fall back to the default, relative values resolve under the
 * default (a `..` segment therefore resolves to a sibling directory) and
 * absolute values are used as given.
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

test('an absolute outputDir is used as-is', () => {
  const { paths, outputDir } = fixture();
  const inside = path.join(outputDir, 'nested', 'deep');
  assert.equal(paths.resolveOutputDir(inside), inside);
  // Whitespace and surrounding quotes are tolerated (copy/paste from the UI).
  assert.equal(paths.resolveOutputDir(`  "${inside}"  `), inside);
});

test('any absolute destination is accepted, even outside OUTPUT_DIR', () => {
  const { paths, root } = fixture();
  for (const candidate of [path.join(root, 'elsewhere'), os.tmpdir()]) {
    assert.equal(
      paths.resolveOutputDir(candidate),
      path.normalize(candidate),
      `expected ${candidate} to be accepted`,
    );
  }
});

test('a relative outputDir may step outside the default directory', () => {
  const { paths, outputDir } = fixture();
  assert.equal(paths.resolveOutputDir('../../evil'), path.resolve(outputDir, '../../evil'));
  assert.equal(paths.resolveOutputDir('clients/../../evil'), path.resolve(outputDir, 'clients/../../evil'));
});

test('outputDirFor honours the job row and falls back safely', () => {
  const { paths, outputDir } = fixture();
  const custom = path.join(outputDir, 'clients', 'acme');

  assert.equal(paths.outputDirFor({ output_dir: custom }), custom);
  // Legacy rows (no column) and unset values use the default.
  assert.equal(paths.outputDirFor({ output_dir: null }), outputDir);
  assert.equal(paths.outputDirFor({}), outputDir);
  assert.equal(paths.outputDirFor(null), outputDir);
  // A stored directory is used as-is, wherever it points.
  assert.equal(paths.outputDirFor({ output_dir: os.tmpdir() }), path.resolve(os.tmpdir()));
});

test('tempOutputPath keeps the job id inside the requested directory', () => {
  const { paths, outputDir } = fixture();
  const custom = path.join(outputDir, 'clients', 'acme');
  const jobId = 'aaaaaaaa-0000-4000-8000-000000000001';

  assert.equal(
    paths.tempOutputPath(jobId, '.mp4', custom),
    path.join(custom, `.${jobId}.rendering.mp4`),
  );
  assert.equal(paths.tempOutputPath(jobId), path.join(outputDir, `.${jobId}.rendering.mp4`));
  assert.equal(paths.outputPath('out.mp4', custom), path.join(custom, 'out.mp4'));

  // An unusable directory value falls back to the default instead of escaping it.
  assert.equal(paths.tempOutputPath(jobId, '.mp4', ''), path.join(outputDir, `.${jobId}.rendering.mp4`));

  // The job id is still validated: it must stay a single safe path segment.
  assert.throws(
    () => paths.tempOutputPath('../../evil', '.mp4', custom),
    (error) => isAppError(error) && error.code === 'VALIDATION_ERROR',
  );
});
