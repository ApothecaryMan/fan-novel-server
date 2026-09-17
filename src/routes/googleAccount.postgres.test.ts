import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import { resolveGoogleAccount } from './googleAccount.js';
import type { Db } from '../database/db.js';

const url = process.env.PHASE1_PG_URL;
// No URL means unit-test mode. A supplied non-local URL is a hard failure, never a skip.
if (url) {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash ||
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/phase1_identity_test') {
    throw new Error('PHASE1_PG_URL must name the isolated local phase1_identity_test database');
  }
}
describe.skipIf(!url)('isolated PostgreSQL provisioning', () => {
  let pool: pg.Pool;
  let database: import('drizzle-orm/node-postgres').NodePgDatabase<typeof schema>;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 });
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool?.end(); });
  const identity = { sub: 'pg-subject-1', email: 'pg-reader@test.com' };
  it('concurrent identical first logins converge to one durable row and one event', async () => {
    // Barrier all eight initial lookups so every call takes the insert race path.
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const racing = new Proxy(database, {
      get(target, key) {
        if (key === 'select') return () => ({ from: () => ({ where: (condition: any) => ({ limit: async (limit: number) => {
          const rows = await target.select().from(schema.users).where(condition).limit(limit);
          if (++arrivals <= 8) { if (arrivals === 8) release(); await gate; }
          return rows;
        } }) }) });
        const value = (target as any)[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Db;
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      resolveGoogleAccount(racing, identity, { name: 'PG Reader' }, false, `pg-race-${index}`)));
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    const rows = await database.select().from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: 'google_pg-subject-1', googleSubject: identity.sub, email: identity.email });
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(results.every((row) => row.googleSubject === identity.sub)).toBe(true);
  });
  it('subject uniqueness is enforced directly by PostgreSQL', async () => {
    await resolveGoogleAccount(database, identity, { name: 'First' }, false, 'pg-unique');
    await expect(database.insert(schema.users).values({ externalId: 'google_distinct', googleSubject: identity.sub,
      email: 'distinct@test.com', username: 'Distinct' })).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(await database.select().from(schema.users)).toHaveLength(1);
  });
  it('different subjects sharing verified email never merge or partially insert', async () => {
    const results = await Promise.allSettled([
      resolveGoogleAccount(database, identity, { name: 'First' }, false, 'pg-email-1'),
      resolveGoogleAccount(database, { ...identity, sub: 'pg-subject-2' }, { name: 'Second' }, true, 'pg-email-2'),
    ]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((value) => value.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(await database.select().from(schema.users)).toHaveLength(1);
  });
  it('a colliding email update is atomic with role bootstrap', async () => {
    const first = await resolveGoogleAccount(database, identity, { name: 'First' }, false, 'pg-update-1');
    await resolveGoogleAccount(database, { sub: 'pg-subject-2', email: 'pg-admin@test.com' }, { name: 'Second' }, true, 'pg-update-2');
    await expect(resolveGoogleAccount(database, { ...identity, email: 'pg-admin@test.com' }, {}, true, 'pg-update-3'))
      .rejects.toMatchObject({ status: 409 });
    const [unchanged] = await database.select().from(schema.users).where(eq(schema.users.id, first.id));
    expect(unchanged).toEqual(first);
  });
});
