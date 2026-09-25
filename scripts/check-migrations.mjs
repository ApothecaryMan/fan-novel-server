#!/usr/bin/env node

/**
 * Validate the Drizzle migration ledger without changing the database.
 *
 * This intentionally checks the files rather than a live database so it can run
 * in CI before a deploy. A live PostgreSQL smoke test is still useful, but it
 * must not be the only guard against a broken snapshot/journal chain.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'drizzle');
const metaDir = join(migrationsDir, 'meta');
const journalPath = join(metaDir, '_journal.json');
const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path}: invalid JSON (${error.message})`);
    return undefined;
  }
}

if (!existsSync(journalPath)) {
  fail(`missing ${journalPath}`);
  process.exit(1);
}

const journal = readJson(journalPath);
if (!journal) process.exit(1);

const entries = Array.isArray(journal.entries) ? journal.entries : [];
if (!Array.isArray(journal.entries)) fail('journal.entries must be an array');

const snapshotFiles = existsSync(metaDir)
  ? readdirSync(metaDir)
      .filter((name) => /^\d{4}_snapshot\.json$/.test(name))
      .sort()
  : [];
const snapshots = new Map();
for (const file of snapshotFiles) {
  const snapshot = readJson(join(metaDir, file));
  if (snapshot) snapshots.set(file, snapshot);
}

if (entries.length !== snapshots.size) {
  fail(`journal has ${entries.length} entries but meta has ${snapshots.size} snapshots`);
}

const seenIdx = new Set();
const seenTags = new Set();
const seenSnapshotIds = new Set();
const operations = new Map();

function checkOperation(statement, migrationTag) {
  // Ignore comments and normalize only for operation matching. The SQL files
  // remain human-readable; this check is about duplicate schema operations.
  const sql = statement
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const tableMatch = sql.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i);
  if (tableMatch) {
    addOperation(`table:${tableMatch[1]}`, migrationTag);
  }

  const columnMatch = sql.match(
    /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i,
  );
  if (columnMatch) {
    addOperation(`column:${columnMatch[1]}.${columnMatch[2]}`, migrationTag);
  }

  const indexMatch = sql.match(
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i,
  );
  if (indexMatch) {
    addOperation(`index:${indexMatch[2]}`, migrationTag);
  }
}

function addOperation(key, migrationTag) {
  const previous = operations.get(key);
  if (previous) {
    fail(`duplicate schema operation ${key} in ${previous} and ${migrationTag}`);
  } else {
    operations.set(key, migrationTag);
  }
}

let previousSnapshotId = '00000000-0000-0000-0000-000000000000';
let previousWhen = -Infinity;
for (const [position, entry] of entries.entries()) {
  const label = `journal entry ${position}`;
  if (!entry || typeof entry !== 'object') {
    fail(`${label} is not an object`);
    continue;
  }
  if (entry.idx !== position) fail(`${label} has idx ${entry.idx}; expected ${position}`);
  if (seenIdx.has(entry.idx)) fail(`duplicate journal idx ${entry.idx}`);
  seenIdx.add(entry.idx);
  if (typeof entry.tag !== 'string' || !/^\d{4}_/.test(entry.tag)) {
    fail(`${label} has an invalid tag: ${entry.tag}`);
    continue;
  }
  if (seenTags.has(entry.tag)) fail(`duplicate journal tag ${entry.tag}`);
  seenTags.add(entry.tag);
  if (typeof entry.when !== 'number' || entry.when <= previousWhen) {
    fail(`${entry.tag} has a non-increasing journal timestamp`);
  }
  previousWhen = entry.when;
  const prefix = entry.tag.slice(0, 4);

  const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
  if (!existsSync(sqlPath)) {
    fail(`missing SQL migration ${entry.tag}`);
  } else {
    const sql = readFileSync(sqlPath, 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) checkOperation(statement, entry.tag);
  }

  const snapshotFile = `${prefix}_snapshot.json`;
  const snapshot = snapshots.get(snapshotFile);
  if (!snapshot) {
    fail(`missing snapshot ${snapshotFile} for ${entry.tag}`);
    continue;
  }
  if (snapshot.dialect !== journal.dialect || String(snapshot.version) !== String(journal.version)) {
    fail(`${snapshotFile} does not match journal dialect/version`);
  }
  if (typeof snapshot.id !== 'string' || seenSnapshotIds.has(snapshot.id)) {
    fail(`${snapshotFile} has a missing or duplicate snapshot id`);
  }
  seenSnapshotIds.add(snapshot.id);
  if (snapshot.prevId !== previousSnapshotId) {
    fail(`${snapshotFile} prevId ${snapshot.prevId} does not point to ${previousSnapshotId}`);
  }
  previousSnapshotId = snapshot.id;
}

for (const file of snapshots.keys()) {
  const prefix = file.slice(0, 4);
  if (!entries.some((entry) => entry?.tag?.slice(0, 4) === prefix)) {
    fail(`orphan snapshot ${file}`);
  }
}

if (errors.length > 0) {
  console.error('Migration integrity check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Migration integrity OK: ${entries.length} journal entries, ${snapshots.size} chained snapshots, ` +
    `${operations.size} unique table/column/index operations.`,
);
