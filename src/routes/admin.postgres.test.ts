import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { users } from '../database/schema.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';
import { adminRouter } from './admin.js';

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

let pool: pg.Pool;
let database: ReturnType<typeof drizzle<typeof schema>>;
let app: Hono;
let adminToken: string;

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

  const savedEnv = { ...process.env };
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.ADMIN_EMAILS = '';
  process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';

  await initDb();
  pool = new pg.Pool({ connectionString: url });
  database = drizzle(pool, { schema });
  await migrate(database, { migrationsFolder: './drizzle' });

  // getCaller resolves the Bearer `sub` against users.external_id and derives
  // isAdmin from the ROW, not from the token, so the fixture must exist in the
  // database and the token must carry that row's externalId as `sub`.
  const adminRow = await createUser({ role: 'admin' });
  adminToken = await signToken({
    id: adminRow.externalId!,
    email: adminRow.email!,
    role: 'admin',
  });

  app = new Hono();
  app.route('/api/v1/admin', adminRouter);

  Object.assign(process.env, savedEnv);
});

afterAll(async () => {
  if (pool) await pool.end();
  await closeDb();
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
    expect(listQueries[0]).toContain('over()');
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
});
