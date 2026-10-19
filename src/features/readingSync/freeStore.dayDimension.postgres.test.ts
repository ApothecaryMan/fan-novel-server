import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../../database/schema.js';
import { readingSessions, users } from '../../database/schema.js';
import { closeDb, initDb } from '../../database/db.js';
import { storeFreeSessions } from './freeStore.js';
import { loadLeaderboard } from './leaderboardStore.js';

const DATABASE_NAME = 'free_day_test';

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

const utcDayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

describe.skipIf(!url)('Free day dimension (isolated PostgreSQL)', () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;
  const dayLabel = utcDayOf(Date.now());

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
    process.env.JWT_SECRET = 'free-day-fixture-signing-key-3200';
    process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';
    process.env.ADMIN_EMAILS = '';
    vi.stubGlobal('__WORKER_ENV__', undefined);
    await initDb();

    const tag = `freeday-${process.pid.toString(36)}`;
    const [row] = await database.insert(users).values({
      externalId: tag,
      email: `${tag}@test.local`,
      username: tag,
      displayName: 'Free Reader',
    }).returning();
    userId = row.id;

    await storeFreeSessions(userId, [
      {
        clientSessionId: 'free-day-1',
        novelId: '7',
        chapterId: 1,
        seconds: 600,
        progressPercent: 100,
        completed: true,
        ts: Date.now(),
      },
    ]);
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
    vi.unstubAllGlobals();
  });

  it('stores the UTC day derived from ts on a Free row', async () => {
    const rows = await database
      .select()
      .from(readingSessions)
      .where(eq(readingSessions.clientSessionId, 'free-day-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0].readDay).toBe(dayLabel);
  });

  it('counts the Free completed chapter in the week leaderboard', async () => {
    const rows = await loadLeaderboard('week', 10);
    const mine = rows.find((r) => r.user.id === `freeday-${process.pid.toString(36)}`);
    expect(mine).toMatchObject({ chapters: 1, trend: 1 });
  });
});
