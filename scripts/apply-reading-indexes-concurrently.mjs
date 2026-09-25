#!/usr/bin/env node

/**
 * Build the 0011 reading-sync indexes without holding a table-write lock.
 *
 * This is deliberately an out-of-band step. Drizzle's node-postgres migrator
 * wraps journal migrations in a transaction, where PostgreSQL rejects CREATE
 * INDEX CONCURRENTLY. Run this script before db:migrate when zero-downtime
 * index creation is required; 0011 uses IF NOT EXISTS and will then skip the
 * already-built indexes.
 */
import 'dotenv/config';
import pg from 'pg';

const indexes = [
  {
    name: 'library_user_updated_id_idx',
    table: 'user_library',
    columns: ['user_id', 'updated_at', 'id'],
  },
  {
    name: 'history_user_read_at_id_idx',
    table: 'reading_history',
    columns: ['user_id', 'read_at', 'id'],
  },
  {
    name: 'sessions_user_novel_chapter_idx',
    table: 'reading_sessions',
    columns: ['user_id', 'novel_id', 'chapter_id'],
  },
  {
    name: 'sessions_user_read_day_idx',
    table: 'reading_sessions',
    columns: ['user_id', 'read_day'],
  },
  {
    name: 'sessions_user_ts_id_idx',
    table: 'reading_sessions',
    columns: ['user_id', 'ts', 'id'],
  },
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required (see .env.example)');
}

const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
const client = new pg.Client({ connectionString });

async function indexState(name) {
  const result = await client.query(
    `select i.indisvalid
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_index i on i.indexrelid = c.oid
      where n.nspname = current_schema()
        and c.relname = $1`,
    [name],
  );
  return result.rows[0]?.indisvalid;
}

try {
  await client.connect();
  // These are session settings; no BEGIN/COMMIT is used, so PostgreSQL keeps
  // CREATE INDEX CONCURRENTLY in its required autocommit mode.
  await client.query("set lock_timeout = '5s'");
  await client.query("set statement_timeout = '30min'");

  for (const index of indexes) {
    const valid = await indexState(index.name);
    if (valid === true) {
      console.log(`[indexes] ${index.name} already valid`);
      continue;
    }
    if (valid === false) {
      // A failed concurrent build can leave an invalid relation behind. It is
      // safe to remove that relation concurrently before retrying.
      await client.query(`drop index concurrently if exists ${quote(index.name)}`);
      console.log(`[indexes] removed invalid ${index.name}`);
    }

    const columns = index.columns.map(quote).join(', ');
    await client.query(
      `create index concurrently if not exists ${quote(index.name)} ` +
        `on ${quote(index.table)} using btree (${columns})`,
    );
    if ((await indexState(index.name)) !== true) {
      throw new Error(`index ${index.name} was not marked valid`);
    }
    console.log(`[indexes] built ${index.name}`);
  }
} finally {
  await client.end();
}
