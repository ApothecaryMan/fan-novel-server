import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../../database/schema.js';
import { readingSessions, users } from '../../database/schema.js';
import { loadLeaderboard } from './leaderboardStore.js';
import { closeDb, initDb } from '../../database/db.js';

const DATABASE_NAME = 'leaderboard_store_test';

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

const dayLabel = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return dayLabel(d);
};

describe.skipIf(!url)('loadLeaderboard (isolated PostgreSQL)', () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let n = 0;

  async function createUser(name: string) {
    const tag = `lb-${process.pid.toString(36)}-${(n += 1)}`;
    const [row] = await database.insert(users).values({
      externalId: tag,
      email: `${tag}@test.local`,
      username: tag,
      displayName: name,
    }).returning();
    return row;
  }

  function sessionRow(userId: string, overrides: Record<string, unknown> = {}) {
    n += 1;
    return {
      userId,
      clientSessionId: `lb-${userId.slice(0, 8)}-${n}`,
      novelId: '7',
      chapterId: 1,
      progressPercent: 91,
      completed: true,
      completionSignalPresent: true,
      proFieldsPresent: false,
      seconds: 600,
      words: 300,
      minuteOfDay: 600,
      readDay: daysAgo(0),
      ts: Date.now(),
      ...overrides,
    } as typeof readingSessions.$inferInsert;
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
    await admin.end();

    pool = new pg.Pool({ connectionString: url, max: 5 });
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });

    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = url;
    process.env.SYNC_OPEN = 'false';
    process.env.JWT_SECRET = 'leaderboard-pg-fixture-signing-key-32';
    process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';
    process.env.ADMIN_EMAILS = '';
    vi.stubGlobal('__WORKER_ENV__', undefined);
    await initDb();

    const a = await createUser('Reader A');
    const b = await createUser('Reader B');
    const c = await createUser('Reader C');
    await database.insert(readingSessions).values([
      sessionRow(a.id, { chapterId: 1, readDay: daysAgo(0) }),
      sessionRow(a.id, { chapterId: 2, readDay: daysAgo(1) }),
      sessionRow(a.id, { chapterId: 3, readDay: daysAgo(10) }),
      sessionRow(b.id, { chapterId: 1, readDay: daysAgo(0) }),
      sessionRow(b.id, { chapterId: 2, readDay: daysAgo(0), completionSignalPresent: false, progressPercent: 10, completed: false }),
      sessionRow(b.id, { chapterId: 9, readDay: daysAgo(40) }),
      sessionRow(c.id, { chapterId: 1, readDay: daysAgo(10) }),
      sessionRow(c.id, { chapterId: 2, readDay: daysAgo(12) }),
      sessionRow(c.id, { chapterId: 3, readDay: daysAgo(13) }),
    ]);
    (globalThis as any).__lbUsers = { a, b, c };
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
    vi.unstubAllGlobals();
  });

  it('ranks users by distinct completed chapters in the week window', async () => {
    const rows = await loadLeaderboard('week', 10);
    const { a, b } = (globalThis as any).__lbUsers;
    expect(rows.map((r) => r.user.id)).toEqual([a.externalId, b.externalId]);
    expect(rows[0]).toMatchObject({ chapters: 2, trend: 1 });
    expect(rows[1]).toMatchObject({ chapters: 1, trend: 1 });
  });

  it('never leaks email into the public rows', async () => {
    const rows = await loadLeaderboard('week', 10);
    for (const r of rows) expect(r.user).not.toHaveProperty('email');
  });

  it('honors the limit', async () => {
    const rows = await loadLeaderboard('week', 1);
    expect(rows).toHaveLength(1);
  });
});
