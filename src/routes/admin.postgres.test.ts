import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { users } from '../database/schema.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';
import { adminRouter } from './admin.js';

/** Minimal shape the list response exposes; the server has no shared DTO type. */
type ListedUser = { id: string; displayName: string | null; role: string };

const DATABASE_NAME = 'admin_route_test';

/**
 * Route-level tests for the admin user list and grant write path.
 *
 * Isolation: provisions its OWN database on the same throwaway cluster booted
 * by src/test/pgGlobalSetup.ts and keys every fixture on a unique
 * `admin-rt-*` externalId. The guard below makes it physically impossible to
 * point this file at production Neon.
 */
const baseUrl = process.env.PHASE1_PG_URL;
let url: string | undefined;
if (baseUrl) {
  const parsed = new URL(baseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash ||
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/phase1_identity_test') {
    throw new Error('PHASE1_PG_URL must name the isolated local phase1_identity_test database');
  }
  parsed.pathname = `/${DATABASE_NAME}`;
  url = parsed.toString();
}

const JWT_SECRET = 'admin-rt-fixture-signing-key-32-bytes-min';
let counter = 0;
const nextSubject = () => `admin-rt-${process.pid.toString(36)}-${(counter += 1)}`;

/** Captured in beforeAll, restored in afterAll — see the note there. */
const savedEnv = { ...process.env };

let pool: pg.Pool;
let database: ReturnType<typeof drizzle<typeof schema>>;
let app: Hono;
let adminToken: string;
let adminExternalId: string | undefined;

async function createUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const externalId = nextSubject();
  const [row] = await database.insert(users).values({
    externalId,
    email: `${externalId}@test.local`,
    username: externalId,
    displayName: `User ${externalId}`,
    role: 'reader',
    isAuthor: false,
    isTranslator: false,
    ...overrides,
  }).returning();
  return row;
}

beforeAll(async () => {
  if (!url) return;

  // initDb() takes no arguments: it reads DATABASE_URL from the environment on
  // every call (getEnv re-parses each time, there is no cache), so pointing the
  // module at the throwaway database means setting the env var first.
  const bootstrap = new pg.Client({ connectionString: baseUrl });
  await bootstrap.connect();
  const existing = await bootstrap.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
  if (existing.rowCount === 0) await bootstrap.query(`CREATE DATABASE ${DATABASE_NAME}`);
  await bootstrap.end();

  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.ADMIN_EMAILS = '';
  process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';

  try {
    await initDb();
    pool = new pg.Pool({ connectionString: url });
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });

    // getCaller resolves the Bearer `sub` against users.external_id and derives
    // isAdmin from the ROW, not from the token, so the fixture must exist in
    // the database and the token must carry that row's externalId as `sub`.
    const adminRow = await createUser({ role: 'admin' });
    adminExternalId = adminRow.externalId ?? undefined;
    adminToken = await signToken({
      id: adminRow.externalId!,
      email: adminRow.email!,
      role: 'admin',
    });

    app = new Hono();
    app.route('/api/v1/admin', adminRouter);
  } catch (err) {
    // Never leave the process pointing at the throwaway database if setup
    // failed partway: every later db call would resolve against it.
    Object.assign(process.env, savedEnv);
    throw err;
  }
  // NOTE: env is deliberately NOT restored here. `db` is a lazy proxy that
  // re-reads getEnv() on every property access and resolveSync() requires
  // cached.url === getEnv().DATABASE_URL, and getSecretKey() re-reads
  // JWT_SECRET per request. Restoring before the `it` bodies run therefore
  // breaks every request if the ambient environment happens to define either
  // variable. Restore in afterAll, as readingStats.plan.postgres.test.ts does.
});

beforeEach(async () => {
  // Makes the file re-runnable against a persistent PHASE1_PG_URL. Without
  // this, rows from a previous run satisfy the search-scoped totals and the
  // exact-count assertions fail on the second run. Same pattern as
  // googleAccount.postgres.test.ts. The admin fixture is preserved: getCaller
  // resolves the bearer subject to a row, so deleting it would 401 every
  // request that follows.
  if (!url) return;
  await database.delete(users).where(ne(users.externalId, adminExternalId!));
});

afterAll(async () => {
  if (url) {
    try {
      if (pool) await pool.end();
      await closeDb();
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${DATABASE_NAME}`);
      await cleanup.end();
    } finally {
      Object.assign(process.env, savedEnv);
    }
  }
});

describe.skipIf(!url)('GET /api/v1/admin/users (isolated PostgreSQL)', () => {
  it('returns total as a number, not a string', async () => {
    await createUser();
    await createUser();
    const res = await app.request('/api/v1/admin/users?page=1&limit=20', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.total).toBe('number');
    expect(Number.isInteger(json.total)).toBe(true);
    expect(json.total).toBeGreaterThanOrEqual(2);
  });

  it('reports total 0 for a page past the end of the result set', async () => {
    await createUser({ displayName: 'paging-fixture' });
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&q=paging-fixture', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const first = await res.json();
    expect(first.total).toBe(1);

    const beyond = await app.request('/api/v1/admin/users?page=9&limit=100&q=paging-fixture', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const json = await beyond.json();
    expect(json.total).toBe(0);
    expect(json.data).toEqual([]);
  });

  it('resolves the page and the total in one query against users', async () => {
    // Two users queries are expected, not one: getCaller resolves the Bearer
    // subject with its own `from "users"` lookup before the route body runs.
    // The route's own list query must be the single one carrying the window
    // count. Before the fix there were three (caller + rows + count(*)).
    const original = pg.Pool.prototype.query;
    const seen: string[] = [];
    const patched = function (this: pg.Pool, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as any)?.text;
      if (typeof text === 'string' && text.includes('from "users"')) seen.push(text);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    pg.Pool.prototype.query = patched as unknown as typeof pg.Pool.prototype.query;
    try {
      const res = await app.request('/api/v1/admin/users?page=1&limit=20', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect((await res.json()).success).toBe(true);
    } finally {
      pg.Pool.prototype.query = original;
    }
    expect(seen).toHaveLength(2);
    const listQueries = seen.filter((text) => /order by/i.test(text));
    expect(listQueries).toHaveLength(1);
    // Assert the windowed COUNT specifically: a bare 'over()' would also match
    // any other window function and would not pin the contract.
    expect(listQueries[0]).toContain('count(*) over()');
  });

  it('orders by created_at then id so pages cannot skip or repeat a row', async () => {
    const original = pg.Pool.prototype.query;
    let listSql = '';
    const patched = function (this: pg.Pool, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as any)?.text;
      if (typeof text === 'string' && /order by/i.test(text) && text.includes('from "users"')) listSql = text;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    pg.Pool.prototype.query = patched as unknown as typeof pg.Pool.prototype.query;
    try {
      const res = await app.request('/api/v1/admin/users?page=1&limit=20', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect((await res.json()).success).toBe(true);
    } finally {
      pg.Pool.prototype.query = original;
    }
    expect(listSql).toMatch(/order by\s+"users"\."created_at" desc,\s*"users"\."id" desc/i);
  });

  it('never selects password or billing columns', async () => {
    const original = pg.Pool.prototype.query;
    let listSql = '';
    const patched = function (this: pg.Pool, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as any)?.text;
      if (typeof text === 'string' && /order by/i.test(text) && text.includes('from "users"')) listSql = text;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    pg.Pool.prototype.query = patched as unknown as typeof pg.Pool.prototype.query;
    try {
      const res = await app.request('/api/v1/admin/users?page=1&limit=20', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect((await res.json()).success).toBe(true);
    } finally {
      pg.Pool.prototype.query = original;
    }
    expect(listSql).not.toContain('password_hash');
    expect(listSql).not.toContain('reading_stats_');
  });

  it('treats a percent wildcard in the search term as a literal', async () => {
    // Without escaping, q=% becomes ILIKE '%%%', which matches every row.
    await createUser({ displayName: 'literal-percent-fixture' });
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&q=%25', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.total).toBe(0);
    expect(json.data).toEqual([]);
  });

  it('still matches a real substring containing no wildcard', async () => {
    await createUser({ displayName: 'needle-in-haystack' });
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&q=needle-in', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const json = await res.json();
    expect(json.total).toBe(1);
  });

  it('treats an underscore as a literal, not a single-character wildcard', async () => {
    await createUser({ displayName: 'snake_case-name' });
    const literal = await app.request('/api/v1/admin/users?page=1&limit=100&q=snake_case', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect((await literal.json()).total).toBe(1);

    // If `_` were still a wildcard this would match the same row.
    const wildcard = await app.request('/api/v1/admin/users?page=1&limit=100&q=snakeXcase', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect((await wildcard.json()).total).toBe(0);
  });

  it('treats a backslash as a literal, not as an escape introducer', async () => {
    await createUser({ displayName: 'back\\slash-name' });
    const literal = await app.request('/api/v1/admin/users?page=1&limit=100&q=back%5Cslash', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect((await literal.json()).total).toBe(1);

    // Unescaped, `\\b` would consume the `b` and match `backslash`.
    const swallowed = await app.request('/api/v1/admin/users?page=1&limit=100&q=back%5Cb', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect((await swallowed.json()).total).toBe(0);
  });
});

describe.skipIf(!url)('admin route input validation (isolated PostgreSQL)', () => {
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  it('rejects a non-integer limit with 400 instead of failing the query', async () => {
    for (const bad of ['2.5', '0.1', 'abc', 'NaN', 'Infinity']) {
      const res = await app.request(`/api/v1/admin/users?page=1&limit=${bad}`, { headers: auth() });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a non-integer page with 400', async () => {
    const res = await app.request('/api/v1/admin/users?page=1.5&limit=20', { headers: auth() });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed user id with 400 instead of failing the query', async () => {
    const res = await app.request('/api/v1/admin/users/not-a-uuid', {
      method: 'PUT',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAuthor: true }),
    });
    expect(res.status).toBe(400);
  });

  it('keeps the database available after bad input', async () => {
    // The real defect: a client-input error used to reach Postgres as a bigint
    // cast, hit the catch, and call noteDbFailure(), which makes
    // isDbAvailable() false for 30s and degrades EVERY db-backed route.
    const bad = await app.request('/api/v1/admin/users?page=1&limit=2.5', { headers: auth() });
    expect(bad.status).toBe(400);

    const badId = await app.request('/api/v1/admin/users/not-a-uuid', {
      method: 'PUT',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAuthor: true }),
    });
    expect(badId.status).toBe(400);

    // A perfectly valid request immediately afterwards must still work.
    const good = await app.request('/api/v1/admin/users?page=1&limit=20', { headers: auth() });
    expect(good.status).toBe(200);
    expect((await good.json()).success).toBe(true);
  });
});

describe.skipIf(!url)('GET /api/v1/admin/users role filters (isolated PostgreSQL)', () => {
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  it('filters by each role and defines reader as the plain remainder', async () => {
    const author = await createUser({ isAuthor: true });
    const translator = await createUser({ isTranslator: true });
    const both = await createUser({ isAuthor: true, isTranslator: true });
    const plain = await createUser({});

    const ids = async (query: string) => {
      const res = await app.request(`/api/v1/admin/users?page=1&limit=100&${query}`, { headers: auth() });
      const json = await res.json();
      return (json.data as ListedUser[]).map((u) => u.id).sort();
    };

    expect(await ids('roles=author')).toEqual([author.id, both.id].sort());
    expect(await ids('roles=translator')).toEqual([translator.id, both.id].sort());

    // reader is a three-way clause: role=reader AND neither grant set.
    // The admin fixture must be excluded because its role is 'admin'.
    expect(await ids('roles=reader')).toEqual([plain.id]);
  });

  it('unions multiple roles', async () => {
    const author = await createUser({ isAuthor: true });
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&roles=admin,author', {
      headers: auth(),
    });
    const json = await res.json();
    const ids = (json.data as ListedUser[]).map((u) => u.id);
    expect(ids).toContain(author.id);
    // The admin fixture plus the author, and nothing else.
    expect(json.total).toBe(2);
  });

  it('combines a role filter with a search term', async () => {
    await createUser({ isAuthor: true, displayName: 'combo-target' });
    await createUser({ displayName: 'combo-other' });
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&roles=author&q=combo-target', {
      headers: auth(),
    });
    const json = await res.json();
    expect(json.total).toBe(1);
    expect((json.data as ListedUser[])[0].displayName).toBe('combo-target');
  });

  it('rejects an unknown role filter with 400', async () => {
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&roles=superuser', {
      headers: auth(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid role filter');
  });

  it('clamps limit to 100 and normalises a non-positive page', async () => {
    await createUser();
    const clamped = await app.request('/api/v1/admin/users?page=1&limit=1000', { headers: auth() });
    expect((await clamped.json()).data.length).toBeLessThanOrEqual(100);

    // page=0 and page=-3 must both resolve to the first page, not an error.
    for (const page of ['0', '-3', '']) {
      const res = await app.request(`/api/v1/admin/users?page=${page}&limit=20`, { headers: auth() });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    }
  });

  it('requires an admin session', async () => {
    const anonymous = await app.request('/api/v1/admin/users?page=1&limit=20');
    expect(anonymous.status).toBe(401);

    const reader = await createUser({});
    const readerToken = await signToken({
      id: reader.externalId!,
      email: reader.email!,
      role: 'reader',
    });
    const forbidden = await app.request('/api/v1/admin/users?page=1&limit=20', {
      headers: { Authorization: `Bearer ${readerToken}` },
    });
    expect(forbidden.status).toBe(403);
  });
});
