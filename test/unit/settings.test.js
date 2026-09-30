'use strict';

/**
 * Runtime settings: persistence, validation and the "survives a restart"
 * guarantee of the default output directory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createConfig } = require('../../src/config/env');
const { createPaths } = require('../../src/config/paths');
const { createDatabase } = require('../../src/database/database');
const { runMigrations } = require('../../src/database/migrations');
const { createSettingsRepository } = require('../../src/database/repositories/settings.repository');
const { createSettingsService, OUTPUT_DIR_KEY } = require('../../src/services/settings.service');
const { isAppError } = require('../../src/utils/errors');

async function createFixture(overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vua-settings-'));
  const outputDir = path.join(root, 'output');
  const extraRoot = path.join(root, 'renders');
  const config = createConfig({
    nodeEnv: 'test',
    tempDir: path.join(root, 'temp'),
    outputDir,
    allowedOutputRoots: [extraRoot],
    dataDir: path.join(root, 'data'),
    logsDir: path.join(root, 'logs'),
    ...overrides,
  });
  const database = createDatabase({ file: config.dbFile });
  runMigrations(database);
  const repository = createSettingsRepository({ database });

  return {
    config,
    outputDir,
    extraRoot,
    database,
    repository,
    /** A fresh service + paths pair, as a restart would create. */
    boot() {
      const paths = createPaths(config);
      const service = createSettingsService({ config, paths, repository });
      service.load();
      return { paths, service };
    },
    async close() {
      database.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

test('with no stored value the configured OUTPUT_DIR is used', async () => {
  const fixture = await createFixture();
  try {
    const { service } = fixture.boot();
    const state = service.describe();

    assert.equal(state.outputDir, fixture.outputDir);
    assert.equal(state.configured, fixture.outputDir);
    assert.equal(state.allowOverride, true);
    assert.deepEqual(state.allowedRoots, [fixture.outputDir, fixture.extraRoot]);
  } finally {
    await fixture.close();
  }
});

test('setOutputDir persists the choice and it survives a restart', async () => {
  const fixture = await createFixture();
  try {
    const first = fixture.boot();
    const state = first.service.setOutputDir(fixture.extraRoot);
    assert.equal(state.outputDir, fixture.extraRoot);
    assert.equal(fixture.repository.get(OUTPUT_DIR_KEY), fixture.extraRoot);

    // A new process (fresh paths/service) restores the persisted directory.
    const second = fixture.boot();
    assert.equal(second.service.getOutputDir(), fixture.extraRoot);
    assert.equal(second.paths.outputDir, fixture.extraRoot);
  } finally {
    await fixture.close();
  }
});

test('a relative value is resolved under the current default', async () => {
  const fixture = await createFixture();
  try {
    const { service, paths } = fixture.boot();
    service.setOutputDir('clients/acme');
    assert.equal(paths.outputDir, path.join(fixture.outputDir, 'clients', 'acme'));
  } finally {
    await fixture.close();
  }
});

test('null resets to OUTPUT_DIR and clears the stored override', async () => {
  const fixture = await createFixture();
  try {
    const { service, paths } = fixture.boot();
    service.setOutputDir(fixture.extraRoot);
    assert.ok(fixture.repository.get(OUTPUT_DIR_KEY));

    const state = service.setOutputDir(null);
    assert.equal(state.outputDir, fixture.outputDir);
    assert.equal(paths.outputDir, fixture.outputDir);
    assert.equal(fixture.repository.get(OUTPUT_DIR_KEY), null);
  } finally {
    await fixture.close();
  }
});

test('a directory outside the allowed roots is rejected and changes nothing', async () => {
  const fixture = await createFixture();
  try {
    const { service, paths } = fixture.boot();
    assert.throws(
      () => service.setOutputDir(path.join(os.tmpdir(), 'not-allowed')),
      (error) => isAppError(error) && error.code === 'VALIDATION_ERROR',
    );
    assert.equal(paths.outputDir, fixture.outputDir);
    assert.equal(fixture.repository.get(OUTPUT_DIR_KEY), null);
  } finally {
    await fixture.close();
  }
});

test('a persisted value that is no longer allowed is discarded on load', async () => {
  const fixture = await createFixture();
  try {
    fixture.repository.set(OUTPUT_DIR_KEY, path.join(os.tmpdir(), 'gone'));
    const { service, paths } = fixture.boot();

    assert.equal(paths.outputDir, fixture.outputDir, 'falls back to OUTPUT_DIR');
    assert.equal(fixture.repository.get(OUTPUT_DIR_KEY), null, 'the stale row is removed');
    assert.equal(service.describe().outputDir, fixture.outputDir);
  } finally {
    await fixture.close();
  }
});

test('ALLOW_OUTPUT_DIR_OVERRIDE=false refuses changes but still loads a stored value', async () => {
  const fixture = await createFixture({ allowOutputDirOverride: false });
  try {
    fixture.repository.set(OUTPUT_DIR_KEY, fixture.extraRoot);
    const { service, paths } = fixture.boot();

    assert.equal(service.describe().allowOverride, false);
    assert.equal(paths.outputDir, fixture.extraRoot, 'the persisted value is still applied');
    assert.throws(
      () => service.setOutputDir(fixture.extraRoot),
      (error) => isAppError(error) && error.code === 'VALIDATION_ERROR',
    );
  } finally {
    await fixture.close();
  }
});
