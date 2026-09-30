'use strict';

/**
 * Settings repository: the key/value store for runtime-adjustable, persistent
 * settings (see AGENTS.md §15 — state that must survive a restart).
 *
 * Values are stored as TEXT; a missing key means "not configured, use the
 * environment default". All statements are parameterized.
 */

const { errors } = require('../../utils/errors');

function createSettingsRepository({ database }) {
  if (!database) throw errors.internal('createSettingsRepository requires a database instance.');

  /** Reads a single setting, or `null` when it was never set. */
  function get(key) {
    const row = database.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  /** Inserts or replaces a setting. */
  function set(key, value) {
    database.withRetry(() =>
      database.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, String(value), new Date().toISOString()],
      ),
    );
    return get(key);
  }

  /** Removes a setting (used to fall back to the environment default). */
  function remove(key) {
    const result = database.withRetry(() => database.run('DELETE FROM settings WHERE key = ?', [key]));
    return result.changes > 0;
  }

  /** Every stored setting as a plain object. */
  function all() {
    const entries = database.all('SELECT key, value FROM settings ORDER BY key');
    const settings = {};
    for (const row of entries) settings[row.key] = row.value;
    return settings;
  }

  return { all, get, remove, set };
}

module.exports = { createSettingsRepository };
