'use strict';

/**
 * Schema migrations.
 *
 * Migrations run automatically the first time the server starts and are applied
 * inside a transaction. Append new entries instead of editing released ones.
 */

const { ALL_STATUSES } = require('../domain/job-status');

const MIGRATIONS = [
  {
    version: 1,
    name: 'create_jobs_table',
    up(database) {
      const statusList = ALL_STATUSES.map((status) => `'${status}'`).join(', ');
      database.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id                TEXT PRIMARY KEY,
          status            TEXT NOT NULL CHECK (status IN (${statusList})),
          original_filename TEXT NOT NULL,
          input_path        TEXT NOT NULL,
          output_path       TEXT,
          temp_output_path  TEXT,
          width             INTEGER NOT NULL CHECK (width > 0),
          height            INTEGER NOT NULL CHECK (height > 0),
          duration_seconds  REAL,
          progress_percent  REAL NOT NULL DEFAULT 0,
          frame             INTEGER,
          fps               REAL,
          speed             TEXT,
          elapsed_seconds   REAL,
          total_size        INTEGER,
          pid               INTEGER,
          error_code        TEXT,
          error_message     TEXT,
          has_audio         INTEGER,
          audio_codec       TEXT,
          render_options    TEXT,
          created_at        TEXT NOT NULL,
          started_at        TEXT,
          completed_at      TEXT,
          updated_at        TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
        CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at);
      `);
    },
  },
  {
    version: 2,
    name: 'add_render_options',
    up(database) {
      // Per-job render options (JSON): model, Topaz tunables, encoder quality,
      // audio handling. Rows created before this migration keep the baseline.
      const columns = database.all('PRAGMA table_info(jobs)').map((row) => row.name);
      if (!columns.includes('render_options')) {
        database.exec('ALTER TABLE jobs ADD COLUMN render_options TEXT');
      }
    },
  },
];

function currentVersion(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const row = database.get('SELECT MAX(version) AS version FROM schema_migrations');
  return row && Number.isFinite(row.version) ? Number(row.version) : 0;
}

/** Applies every pending migration; returns the executed versions. */
function runMigrations(database, logger) {
  const applied = [];
  const version = currentVersion(database);
  const pending = MIGRATIONS.filter((migration) => migration.version > version).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    const apply = database.transaction(() => {
      migration.up(database);
      database.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, new Date().toISOString()],
      );
    });
    apply();
    applied.push(migration.version);
    logger?.info?.(`migration ${migration.version} (${migration.name}) applied`);
  }

  if (pending.length === 0) {
    logger?.debug?.(`database schema is up to date (version ${version})`);
  }

  return applied;
}

module.exports = { MIGRATIONS, currentVersion, runMigrations };
