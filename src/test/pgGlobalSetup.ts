/**
 * Boots a throwaway PostgreSQL cluster for the isolated DB suite so those
 * tests never silently skip again.
 *
 * Why this exists: `src/routes/googleAccount.postgres.test.ts` gates itself on
 * `PHASE1_PG_URL`. With no URL it `skipIf`s, so 7 tests covering real
 * concurrency guarantees (racing logins converging to one row, subject
 * uniqueness, no partial merges) were never checked by a plain `npm test`.
 *
 * Safety: the suite itself rejects any URL that is not a LOCAL database named
 * `phase1_identity_test` (see that file's top-level guard), so this setup
 * physically cannot be pointed at production Neon. We also never overwrite a
 * PHASE1_PG_URL the caller supplied — if one is set, this setup is a no-op and
 * the caller's database is used as-is.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const DB_NAME = 'phase1_identity_test';
let dataDir: string | null = null;
let started = false;

function have(bin: string): boolean {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

/** Ask the OS for a free port, then release it. Small race window, fine for tests. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

async function waitForReady(port: number, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const r = spawnSync('pg_isready', ['-h', '127.0.0.1', '-p', String(port), '-q'], { stdio: 'ignore' });
    if (r.status === 0) return true;
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

export async function setup(): Promise<void> {
  if (process.env.PHASE1_PG_URL) return; // caller owns the database
  if (!have('initdb') || !have('pg_ctl') || !have('psql')) {
    console.warn('[pg-test] PostgreSQL binaries not found — isolated DB tests will skip.');
    return;
  }

  dataDir = mkdtempSync(join(tmpdir(), 'fn-pgtest-'));
  const pgdata = join(dataDir, 'data');
  const port = await freePort();

  try {
    execFileSync('initdb', ['-D', pgdata, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' });
    execFileSync(
      'pg_ctl',
      ['-D', pgdata, '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, '-l', join(dataDir, 'pg.log'), 'start'],
      { stdio: 'ignore' },
    );
    started = true;
    if (!(await waitForReady(port))) throw new Error('cluster did not become ready');
    execFileSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME};`], { stdio: 'ignore' });
    process.env.PHASE1_PG_URL = `postgres://postgres@127.0.0.1:${port}/${DB_NAME}`;
  } catch (err) {
    console.warn(`[pg-test] could not start an isolated cluster — those tests will skip: ${(err as Error).message}`);
    teardown();
  }
}

export async function teardown(): Promise<void> {
  if (started && dataDir) {
    spawnSync('pg_ctl', ['-D', join(dataDir, 'data'), 'stop', '-m', 'fast'], { stdio: 'ignore' });
    started = false;
  }
  if (dataDir && existsSync(dataDir)) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    dataDir = null;
  }
  delete process.env.PHASE1_PG_URL;
}
