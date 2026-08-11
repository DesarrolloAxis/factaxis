#!/usr/bin/env node
'use strict';

/**
 * Runner de migraciones SQL, minimalista y sin dependencias de framework.
 *
 * Convención de archivos en /migrations:
 *   NNN_nombre_descriptivo.up.sql
 *   NNN_nombre_descriptivo.down.sql
 *
 * Uso:
 *   node scripts/migrate.js up            # aplica todas las pendientes
 *   node scripts/migrate.js up 003         # aplica hasta la 003 inclusive
 *   node scripts/migrate.js down           # revierte la última aplicada
 *   node scripts/migrate.js down 003       # revierte hasta dejar aplicada la 003
 *   node scripts/migrate.js status
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      version VARCHAR(20) NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function listMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.up.sql'));
  return files
    .map((f) => {
      const match = f.match(/^(\d+)_(.+)\.up\.sql$/);
      if (!match) return null;
      const [, version, name] = match;
      return {
        version,
        name,
        upFile: path.join(MIGRATIONS_DIR, f),
        downFile: path.join(MIGRATIONS_DIR, `${version}_${name}.down.sql`),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version));
}

async function getAppliedVersions() {
  const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
  return new Set(rows.map((r) => r.version));
}

async function up(targetVersion) {
  await ensureMigrationsTable();
  const applied = await getAppliedVersions();
  const migrations = listMigrationFiles();

  for (const m of migrations) {
    if (targetVersion && m.version > targetVersion) break;
    if (applied.has(m.version)) continue;

    const sql = fs.readFileSync(m.upFile, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [m.version, m.name]
      );
      await client.query('COMMIT');
      console.log(`[migrate] up   ${m.version}_${m.name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAILED up ${m.version}_${m.name}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

async function down(targetVersion) {
  await ensureMigrationsTable();
  const applied = await getAppliedVersions();
  const migrations = listMigrationFiles().reverse();

  for (const m of migrations) {
    if (!applied.has(m.version)) continue;
    if (targetVersion && m.version <= targetVersion) break;

    if (!fs.existsSync(m.downFile)) {
      throw new Error(`No existe down migration para ${m.version}_${m.name}`);
    }
    const sql = fs.readFileSync(m.downFile, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [m.version]);
      await client.query('COMMIT');
      console.log(`[migrate] down ${m.version}_${m.name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAILED down ${m.version}_${m.name}:`, err.message);
      throw err;
    } finally {
      client.release();
    }

    if (!targetVersion) break; // sin target: solo revierte la última
  }
}

async function status() {
  await ensureMigrationsTable();
  const applied = await getAppliedVersions();
  const migrations = listMigrationFiles();
  for (const m of migrations) {
    const mark = applied.has(m.version) ? '[x]' : '[ ]';
    console.log(`${mark} ${m.version}_${m.name}`);
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'up') await up(arg);
    else if (cmd === 'down') await down(arg);
    else if (cmd === 'status') await status();
    else {
      console.error('Uso: node scripts/migrate.js <up|down|status> [version]');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { up, down, status };
