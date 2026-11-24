import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { and, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { readingNovelTombstones, readingSessions, userAchievementUnlocks, users } from '../database/schema.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';
import { loadLeaderboard } from '../features/readingSync/leaderboardStore.js';
import { READING_CLOCK_SKEW_MS } from '../features/readingSync/freeStore.js';

const DATABASE_NAME = 'reading_delete_test';

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

const FIXTURE_PREFIX = 'del-pg-';
const JWT_SECRET = 'del-pg-fixture-signing-key-32-bytes-min';
let counter = 0;
const savedEnv = { ...process.env };

describe.skipIf(!url)('Reading delete + late-upload gates (isolated PostgreSQL)', () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let app: Hono;

  const nextSubject = () => `${FIXTURE_PREFIX}${process.pid.toString(36)}-${(counter += 1)}`;
  async function createUser(plan: 'free' | 'pro' = 'free') {
    const externalId = nextSubject();
    const now = Date.now();
    const [row] = await database.insert(users).values({
      externalId,
      email: `${externalId}@test.local`,
      username: externalId,
      readingStatsPlan: plan,
      ...(plan === 'pro' ? {
        readingStatsPlanStartedAt: now,
        readingStatsPlanExpiresAt: now + 30 * 86_400_000,
        readingStatsLastRenewedAt: now,
        readingStatsPlanDurationDays: 30,
        readingStatsPlanStatus: 'active' as const,
        readingStatsRenewalCount: 1,
        readingStatsTotalSubscribedMs: 30 * 86_400_000,
      } : {}),
    }).returning();
    const token = await signToken({ id: externalId, email: `${externalId}@test.local`, role: 'reader' });
    return { row, externalId, token };
  }

  async function request(path: string, body: unknown, token: string | null, query = '') {
    return app.request(`${path}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  const freeSession = (overrides: Record<string, unknown> = {}) => ({
    clientSessionId: `m-${Math.random().toString(36).slice(2, 10)}`,
    novelId: '10',
    chapterId: 1,
    seconds: 600,
    progressPercent: 100,
    completed: true,
    ts: Date.now(),
    ...overrides,
  });

  const freePush = (externalId: string, sessions: unknown[], token: string) =>
    request('/sync/push', { syncVersion: 2, user: { externalId }, deviceId: 'd', sessions }, token);

  const storedSessions = (userId: string) =>
    database.select().from(readingSessions).where(eq(readingSessions.userId, userId));

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
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';
    vi.stubGlobal('__WORKER_ENV__', undefined);
    await initDb();
    const { syncRouter } = await import('./sync.js');
    const { profileRouter } = await import('./profile.js');
    const { statsRouter } = await import('./stats.js');
    app = new Hono()
      .route('/sync', syncRouter)
      .route('/users', profileRouter)
      .route('/stats', statsRouter);
  }, 30_000);

  afterEach(async () => {
    const owned = await database.select({ id: users.id }).from(users).where(like(users.externalId, `${FIXTURE_PREFIX}%`));
    for (const { id } of owned) {
      await database.delete(readingSessions).where(eq(readingSessions.userId, id));
      await database.delete(schema.readingNovels).where(eq(schema.readingNovels.userId, id));
      await database.delete(readingNovelTombstones).where(eq(readingNovelTombstones.userId, id));
      await database.delete(userAchievementUnlocks).where(eq(userAchievementUnlocks.userId, id));
      await database.delete(schema.userLibrary).where(eq(schema.userLibrary.userId, id));
    }
    if (owned.length > 0) {
      await database.delete(users).where(like(users.externalId, `${FIXTURE_PREFIX}%`));
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeDb();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    await pool?.end();
  });

  it('reset deletes sessions/derived/unlocks, zeroes aggregates and leaderboard', async () => {
    const { row, externalId, token } = await createUser('free');
    await freePush(externalId, [
      freeSession({ clientSessionId: 'r1', novelId: '10', chapterId: 1, seconds: 600 }),
      freeSession({ clientSessionId: 'r2', novelId: '20', chapterId: 2, seconds: 300 }),
    ], token);
    await database.insert(schema.readingNovels).values({
      userId: row.id, novelId: '10', title: 'T', genre: 'G', updatedAt: Date.now(),
    });
    await database.insert(userAchievementUnlocks).values({
      userId: row.id, achievementId: 'ach-1', level: 2, firstSeenAt: Date.now(), catalogVersion: 1, updatedAt: Date.now(),
    });
    const before: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(before.stats.totalSecondsRead).toBe(900);
    // No flag: exactly the old 4-key shape, no streak keys at all.
    expect(Object.keys(before.stats).sort()).toEqual([
      'level',
      'levelProgress',
      'totalSecondsRead',
      'uniqueInAppCompletedChapters',
    ]);
    const flaggedBefore: any = await (await request(
      '/sync/pull', { syncVersion: 2, user: { externalId }, readingStatsFreeStreaks: 1 }, token,
    )).json();
    expect(Object.keys(flaggedBefore.stats).sort()).toEqual([
      'currentStreakDays',
      'level',
      'levelProgress',
      'longestStreakDays',
      'totalSecondsRead',
      'uniqueInAppCompletedChapters',
    ]);
    expect(flaggedBefore.stats.currentStreakDays).toBeGreaterThanOrEqual(1);

    const res = await request('/sync/reading/reset', { syncVersion: 2, user: { externalId } }, token);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.plan).toBe('free');
    expect(typeof body.resetAt).toBe('number');
    expect(body.stats.totalSecondsRead).toBe(0);
    expect(body.stats.uniqueInAppCompletedChapters).toBe(0);
    expect(body.stats).not.toHaveProperty('currentStreakDays');
    expect(body.stats).not.toHaveProperty('longestStreakDays');

    const flaggedReset: any = await (await request(
      '/sync/reading/reset', { syncVersion: 2, user: { externalId }, readingStatsFreeStreaks: 1 }, token,
    )).json();
    expect(flaggedReset.stats).toMatchObject({
      totalSecondsRead: 0,
      uniqueInAppCompletedChapters: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
    });

    expect(await storedSessions(row.id)).toHaveLength(0);
    expect(await database.select().from(schema.readingNovels).where(eq(schema.readingNovels.userId, row.id))).toHaveLength(0);
    expect(await database.select().from(userAchievementUnlocks).where(eq(userAchievementUnlocks.userId, row.id))).toHaveLength(0);
    const [userRow] = await database.select().from(users).where(eq(users.id, row.id));
    expect(typeof (userRow as any).statsResetAt).toBe('number');

    const after: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(after.stats.totalSecondsRead).toBe(0);
    const board = await loadLeaderboard('week', 50);
    expect(board.find((r) => r.user.id === externalId)).toBeUndefined();
    const boardAll = await loadLeaderboard('all', 50);
    expect(boardAll.find((r) => r.user.id === externalId)).toBeUndefined();
  });

  it('novel delete removes only that novel and leaves unlocks', async () => {
    const { row, externalId, token } = await createUser('free');
    await freePush(externalId, [
      freeSession({ clientSessionId: 'n1', novelId: '10', chapterId: 1, seconds: 600 }),
      freeSession({ clientSessionId: 'n2', novelId: '20', chapterId: 5, seconds: 300 }),
    ], token);
    await database.insert(userAchievementUnlocks).values({
      userId: row.id, achievementId: 'ach-9', level: 3, firstSeenAt: Date.now(), catalogVersion: 2, updatedAt: Date.now(),
    });
    const res = await request('/sync/reading/delete-novel', { syncVersion: 2, user: { externalId }, novelId: '10' }, token);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.novelId).toBe('10');
    expect(typeof body.deletedAt).toBe('number');
    expect(body.stats.totalSecondsRead).toBe(300);
    expect(Object.keys(body.stats).sort()).toEqual([
      'level',
      'levelProgress',
      'totalSecondsRead',
      'uniqueInAppCompletedChapters',
    ]);

    const flagged: any = await (await request(
      '/sync/reading/delete-novel',
      { syncVersion: 2, user: { externalId }, novelId: '10', readingStatsFreeStreaks: '1' },
      token,
    )).json();
    expect(flagged.success).toBe(true);
    expect(Object.keys(flagged.stats).sort()).toEqual([
      'currentStreakDays',
      'level',
      'levelProgress',
      'longestStreakDays',
      'totalSecondsRead',
      'uniqueInAppCompletedChapters',
    ]);
    expect(flagged.stats.totalSecondsRead).toBe(300);

    const remaining = await storedSessions(row.id);
    expect(remaining.map((r) => r.novelId).sort()).toEqual(['20']);
    const tombs = await database.select().from(readingNovelTombstones).where(eq(readingNovelTombstones.userId, row.id));
    expect(tombs).toHaveLength(1);
    expect(tombs[0].novelId).toBe('10');
    expect(await database.select().from(userAchievementUnlocks).where(eq(userAchievementUnlocks.userId, row.id))).toHaveLength(1);
  });

  it('late pushes before reset/tombstone are dropped but acknowledged', async () => {
    const { row, externalId, token } = await createUser('free');
    await freePush(externalId, [freeSession({ clientSessionId: 'early-1', ts: 1_700_000_000_000 })], token);
    const resetRes: any = await (await request('/sync/reading/reset', { syncVersion: 2, user: { externalId } }, token)).json();
    const resetAt: number = resetRes.resetAt;
    expect(typeof resetAt).toBe('number');

    const late = await freePush(externalId, [freeSession({ clientSessionId: 'late-1', ts: resetAt - READING_CLOCK_SKEW_MS - 10_000 })], token);
    expect(late.status).toBe(200);
    const lateBody: any = await late.json();
    expect(lateBody.applied).toEqual({ sessions: 0 });
    expect(lateBody.acceptedSessionIds).toEqual(['late-1']);
    expect(await storedSessions(row.id)).toHaveLength(0);

    // Exactly on the skew boundary counts as concurrent, not late: stored.
    const edge = await freePush(externalId, [freeSession({ clientSessionId: 'edge-1', ts: resetAt - READING_CLOCK_SKEW_MS })], token);
    expect((await edge.json()).applied).toEqual({ sessions: 1 });
    expect(await storedSessions(row.id)).toHaveLength(1);

    const fresh = await freePush(externalId, [freeSession({ clientSessionId: 'fresh-1', ts: resetAt + 10_000 })], token);
    expect((await fresh.json()).applied).toEqual({ sessions: 1 });

    await request('/sync/reading/delete-novel', { syncVersion: 2, user: { externalId }, novelId: '99' }, token);
    const tombs = await database.select().from(readingNovelTombstones)
      .where(and(eq(readingNovelTombstones.userId, row.id), eq(readingNovelTombstones.novelId, '99')));
    const tombAt = Number((tombs[0] as any).deletedAt);
    const dropped = await freePush(externalId, [freeSession({ clientSessionId: 'late-99', novelId: '99', ts: tombAt - READING_CLOCK_SKEW_MS - 5_000 })], token);
    const droppedBody: any = await dropped.json();
    expect(droppedBody.applied).toEqual({ sessions: 0 });
    expect(droppedBody.acceptedSessionIds).toEqual(['late-99']);

    const otherNovel = await freePush(externalId, [freeSession({ clientSessionId: 'other-1', novelId: '100', ts: Date.now() })], token);
    expect((await otherNovel.json()).applied).toEqual({ sessions: 1 });
  });

  it('drops pre-reset achievement deltas and publishes resetAt on unlock pull', async () => {
    const { externalId, token } = await createUser('free');
    const resetRes: any = await (await request('/sync/reading/reset', { syncVersion: 2, user: { externalId } }, token)).json();
    const resetAt: number = resetRes.resetAt;
    expect(typeof resetAt).toBe('number');

    const push = await request('/sync/unlocks/push', {
      user: { externalId },
      unlocks: [
        // Strictly before the reset (beyond the skew): forgotten, not stored.
        { achievementId: 'old', level: 2, firstSeenAt: resetAt - READING_CLOCK_SKEW_MS - 1, catalogVersion: 1 },
        // Exactly on the skew boundary: concurrent, kept.
        { achievementId: 'edge', level: 2, firstSeenAt: resetAt - READING_CLOCK_SKEW_MS, catalogVersion: 1 },
        { achievementId: 'fresh', level: 2, firstSeenAt: resetAt + 10_000, catalogVersion: 1 },
      ],
    }, token);
    expect(push.status).toBe(200);
    expect((await push.json()).applied).toBe(2);

    const pulls: any = await (await request('/sync/unlocks/pull', { user: { externalId } }, token)).json();
    expect(pulls.resetAt).toBe(resetAt);
    expect(pulls.unlocks.map((u: any) => u.achievementId).sort()).toEqual(['edge', 'fresh']);
  });

  it('reset and novel delete are idempotent', async () => {
    const { row, externalId, token } = await createUser('free');
    await freePush(externalId, [freeSession({ clientSessionId: 'id-1' })], token);
    const first: any = await (await request('/sync/reading/reset', { syncVersion: 2, user: { externalId } }, token)).json();
    const second: any = await (await request('/sync/reading/reset', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(second.success).toBe(true);
    expect(second.stats.totalSecondsRead).toBe(0);
    expect(second.resetAt).toBeGreaterThanOrEqual(first.resetAt);
    expect(await storedSessions(row.id)).toHaveLength(0);

    await freePush(externalId, [freeSession({ clientSessionId: 'id-2', novelId: '7' })], token);
    const d1: any = await (await request('/sync/reading/delete-novel', { syncVersion: 2, user: { externalId }, novelId: '7' }, token)).json();
    const d2: any = await (await request('/sync/reading/delete-novel', { syncVersion: 2, user: { externalId }, novelId: '7' }, token)).json();
    expect(d2.success).toBe(true);
    expect(d2.deletedAt).toBeGreaterThanOrEqual(d1.deletedAt);
    expect(await storedSessions(row.id)).toHaveLength(0);
  });

  it('Free streaks require the opt-in flag; without it the shape is the old 4 keys', async () => {
    const { externalId, token } = await createUser('free');
    const noon = Date.UTC(2026, 9, 15, 12, 0, 0);
    await freePush(externalId, [
      freeSession({ clientSessionId: 's-day1', ts: noon - 86_400_000 }),
      freeSession({ clientSessionId: 's-day2', ts: noon }),
    ], token);
    const plain: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(Object.keys(plain.stats).sort()).toEqual([
      'level',
      'levelProgress',
      'totalSecondsRead',
      'uniqueInAppCompletedChapters',
    ]);
    const pulled: any = await (await request(
      '/sync/pull', { syncVersion: 2, user: { externalId }, readingStatsFreeStreaks: 1 }, token,
    )).json();
    expect(Object.keys(pulled.stats).sort()).toEqual([
      'currentStreakDays',
      'level',
      'levelProgress',
      'longestStreakDays',
      'totalSecondsRead',
      'uniqueInAppCompletedChapters',
    ]);
    expect(typeof pulled.stats.currentStreakDays).toBe('number');
    expect(typeof pulled.stats.longestStreakDays).toBe('number');
    expect(pulled.stats.longestStreakDays).toBeGreaterThanOrEqual(2);

    const profile = await (await import('./profile.js')).profileRouter;
    void profile;
    const meRes = await app.request('/users/me/profile?readingStatsVersion=2&readingStatsFreeStreaks=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    const me: any = await meRes.json();
    expect(typeof me.readingStats.currentStreakDays).toBe('number');
    const mePlainRes = await app.request('/users/me/profile?readingStatsVersion=2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const mePlain: any = await mePlainRes.json();
    expect(mePlain.readingStats).not.toHaveProperty('currentStreakDays');
  });

  it('tz bucketing moves a 22:30 UTC session to the next day for Africa/Cairo', async () => {
    const { externalId, token } = await createUser('pro');
    const now = new Date();
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const tsLate = utcMidnight - 86_400_000 + 22.5 * 3_600_000;
    const utcDay = new Date(tsLate).toISOString().slice(0, 10);
    const minuteOfDay = 22 * 60 + 30;
    await request('/sync/push', {
      syncVersion: 2,
      user: { externalId },
      sessions: [{
        clientSessionId: 'tz-1', novelId: '42', chapterId: 1, seconds: 600, words: 100,
        minuteOfDay, readDay: utcDay, progressPercent: 50, completed: false, ts: tsLate,
      }],
      library: [],
      novels: [],
    }, token);

    const plain: any = await (await request('/sync/pull', {
      syncVersion: 2, user: { externalId }, readingStats: { libraryCursor: null, sessionCursor: null, year: now.getUTCFullYear() },
    }, token)).json();
    expect(plain.plan).toBe('pro');
    const plainDays = Object.keys(plain.stats.yearlyActivity);
    expect(plainDays).toContain(utcDay);

    const tzPull: any = await (await request(
      '/sync/pull',
      {
        syncVersion: 2, user: { externalId },
        readingStats: { libraryCursor: null, sessionCursor: null, year: now.getUTCFullYear(), readingStatsTz: 'Africa/Cairo' },
      },
      token,
    )).json();
    expect(tzPull.plan).toBe('pro');
    const { tzDayLabelFromTs } = await import('../features/readingSync/timezone.js');
    const cairoDay = tzDayLabelFromTs(tsLate, 'Africa/Cairo');
    expect(cairoDay).not.toBeNull();
    expect(cairoDay).not.toBe(utcDay);
    expect(Object.keys(tzPull.stats.yearlyActivity)).toContain(cairoDay);
    expect(tzPull.stats.asOfDay).not.toBeUndefined();
  });

  it('invalid tz falls back to legacy behavior and old clients are unchanged', async () => {
    const { externalId, token } = await createUser('free');
    await freePush(externalId, [freeSession({ clientSessionId: 'old-1', seconds: 120 })], token);
    const plain: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(plain.success).toBe(true);
    const invalid: any = await (await request(
      '/sync/pull?readingStatsTz=Not%2FAZone',
      { syncVersion: 2, user: { externalId } },
      token,
    )).json();
    expect(invalid.success).toBe(true);
    expect(invalid.stats).toEqual(plain.stats);

    const profilePlain = await app.request('/users/me/profile?readingStatsVersion=2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(profilePlain.status).toBe(200);
    const profileInvalid = await app.request('/users/me/profile?readingStatsVersion=2&readingStatsTz=Bogus%2FZone', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(profileInvalid.status).toBe(200);
    expect((await profileInvalid.json()).readingStats).toEqual((await profilePlain.json()).readingStats);
  });
});
