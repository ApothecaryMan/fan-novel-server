import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { eq, like, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { comments, readingSessions, users } from '../database/schema.js';
import { closeDb, initDb } from '../database/db.js';
import { signToken } from '../middleware/auth.js';
import { profileRouter } from './profile.js';
import type { ProfileDecorations } from '../domain/profileDecorations.js';

/**
 * The profile aggregates against REAL PostgreSQL, not the in-memory fake.
 *
 * Why this file exists: profile.ts computes its aggregates with hand-written
 * `sql` fragments (scalar subqueries correlated on the resolved users row).
 * The fake in src/test/identityDb.ts re-implements that logic itself — it
 * matches on select KEYS, never parses the route's SQL — so it cannot detect a
 * regression in the SQL text at all. Proven: dropping `deleted_at IS NULL`,
 * zeroing the words SUM, and removing the GREATEST clamp all left the fake
 * suite green. Only Postgres can see those, which is exactly how the
 * bare-identifier bug ("user_id" = "id") was first caught.
 *
 * The guard makes it impossible to point this file at production Neon.
 */
const DATABASE_NAME = 'profile_route_test';

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

const FIXTURE_PREFIX = 'profile-pg-';
// The UUID-precedence test writes a shadow account whose externalId is another
// user's UUID, so it does NOT carry the prefix the cleanup below matches on.
// Without this the row survives a failed run and every later run dies on the
// primary key before it reaches a single assertion.
const SHADOW_UUID = '44444444-4444-4444-8444-444444444444';
const JWT_SECRET = 'profile-pg-fixture-signing-key-32-b';
let counter = 0;
const savedEnv = { ...process.env };

describe.skipIf(!url)('Profile aggregates (isolated PostgreSQL)', () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let app: Hono;
  let novelId: string;

  const nextSubject = () => `${FIXTURE_PREFIX}${process.pid.toString(36)}-${(counter += 1)}`;

  async function createUser(plan: 'free' | 'pro' = 'free') {
    const externalId = nextSubject();
    const now = Date.now();
    const [row] = await database.insert(users).values({
      externalId,
      email: `${externalId}@test.local`,
      username: externalId,
      displayName: `User ${counter}`,
      role: 'reader',
      readingStatsPlan: plan,
      ...(plan === 'pro' ? {
        readingStatsPlanStartedAt: now,
        readingStatsPlanExpiresAt: now + 30 * 86_400_000,
      } : {}),
    }).returning();
    const token = await signToken({ id: externalId, email: `${externalId}@test.local`, role: 'reader' });
    return { row, externalId, token };
  }

  /** A session row with every NOT NULL column satisfied. */
  function sessionRow(userId: string, overrides: Record<string, unknown> = {}) {
    const n = (counter += 1);
    return {
      userId,
      clientSessionId: `pg-${userId.slice(0, 8)}-${n}`,
      novelId: '1',
      chapterId: 1,
      progressPercent: 50,
      completed: false,
      completionSignalPresent: false,
      proFieldsPresent: false,
      seconds: 600,
      words: 300,
      minuteOfDay: 600,
      readDay: '2026-09-01',
      ts: Date.now(),
      ...overrides,
    } as typeof readingSessions.$inferInsert;
  }

  const me = async (token: string) => {
    const res = await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() as any };
  };
  const pub = async (id: string) => {
    const res = await app.request(`/users/${id}/profile`);
    return { status: res.status, body: await res.json() as any };
  };

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
    process.env.ADMIN_EMAILS = '';
    vi.stubGlobal('__WORKER_ENV__', undefined);
    await initDb();

    novelId = `prof-novel-${process.pid.toString(36)}`;
    await database.insert(schema.novels).values({
      id: novelId, title: 'Profile Novel', author: 'Seed',
      category: 'test', coverUrl: 'https://cdn.test/c.png', summary: 's',
    });

    app = new Hono().route('/users', profileRouter);
  }, 30_000);

  afterEach(async () => {
    const owned = await database.select({ id: users.id }).from(users)
      .where(like(users.externalId, `${FIXTURE_PREFIX}%`));
    for (const { id } of owned) {
      await database.delete(comments).where(eq(comments.userId, id));
      await database.delete(readingSessions).where(eq(readingSessions.userId, id));
      await database.delete(schema.userLibrary).where(eq(schema.userLibrary.userId, id));
    }
    await database.delete(comments).where(eq(comments.novelId, novelId));
    if (owned.length > 0) {
      await database.delete(users).where(like(users.externalId, `${FIXTURE_PREFIX}%`));
    }
    await database.delete(users).where(eq(users.id, SHADOW_UUID));
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (!url) return;
    try {
      if (pool) await pool.end();
    } catch { /* already closed */ }
    try { await closeDb(); } catch { /* ignore */ }
    Object.assign(process.env, savedEnv);
  });

  // The activity seal rides in the SAME correlated statement as the level SUM,
  // as one jsonb_build_object with two FILTERed aggregates. That makes it the
  // most testable part of the route: the fake answers the shape from fixtures
  // and never parses the SQL, so only these assertions can catch a dropped
  // bound, a missing GREATEST, or a bare identifier that binds to the wrong
  // table.
  describe('public activityTier (real SQL)', () => {
    const iso = (ago: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - ago);
      return d.toISOString().slice(0, 10);
    };

    /** One qualifying day inside the window: 90 minutes, 13_500 words. */
    const qualifyingWeek = (userId: string) => Array.from({ length: 7 }, (_, i) =>
      sessionRow(userId, { seconds: 90 * 60, words: 13_500, readDay: iso(i) }));

    it('publishes the rolling seven-day tier', async () => {
      const { row } = await createUser('pro');
      await database.insert(readingSessions).values(qualifyingWeek(row.id));
      const { body } = await pub(row.id);
      // 90 min and 13_500 words a day: tier 2.
      expect(body.activityTier).toBe(2);
      // Same response, same statement — the seal cost the level nothing.
      expect(body.level).toBeGreaterThanOrEqual(1);
    });

    it('applies both window bounds, so an old day cannot drag the average up', async () => {
      const { row } = await createUser('pro');
      await database.insert(readingSessions).values([
        ...qualifyingWeek(row.id),
        // Two days outside the window. Counted in, the average would be
        // 432 min/day and the route would report tier 4.
        sessionRow(row.id, { seconds: 40 * 3_600, words: 500_000, readDay: iso(8) }),
      ]);
      const { body } = await pub(row.id);
      expect(body.activityTier).toBe(2);
    });

    it('ignores a Free-origin row, which stores no read day', async () => {
      const { row } = await createUser('pro');
      await database.insert(readingSessions).values([
        ...qualifyingWeek(row.id),
        // FREE_SESSION_SAFE_DEFAULTS: a Free session carries read_day = '' and
        // words = 0. The lower text bound must drop it on its own.
        sessionRow(row.id, { seconds: 40 * 3_600, words: 500_000, readDay: '', proFieldsPresent: false }),
      ]);
      const { body } = await pub(row.id);
      expect(body.activityTier).toBe(2);
    });

    it('clamps negative seconds and words per row inside the window', async () => {
      const { row } = await createUser('pro');
      await database.insert(readingSessions).values([
        ...qualifyingWeek(row.id),
        // Summed raw, this row would erase 833 minutes and 90_000 words and
        // report tier 0. GREATEST is what keeps the reader's tier honest.
        sessionRow(row.id, { seconds: -50_000, words: -90_000, readDay: iso(3) }),
      ]);
      const { body } = await pub(row.id);
      expect(body.activityTier).toBe(2);
    });

    it('reports tier 0, not null or a string, for a reader with no rows', async () => {
      const { row } = await createUser('free');
      const { body } = await pub(row.id);
      expect(body.activityTier).toBe(0);
      expect(typeof body.activityTier).toBe('number');
    });
  });

  // Each of these pins one predicate in the hand-written subquery. The fake
  // cannot fail them; a renamed column or a dropped predicate breaks here.
  it('excludes soft-deleted library rows and counts live ones', async () => {    const { row, token } = await createUser('pro');
    const base = Date.now();
    await database.insert(schema.userLibrary).values([
      { userId: row.id, novelId: 'a', updatedAt: base, receivedAt: new Date(base) },
      { userId: row.id, novelId: 'b', updatedAt: base, receivedAt: new Date(base) },
      { userId: row.id, novelId: 'c', updatedAt: base, deletedAt: base, receivedAt: new Date(base) },
    ]);
    const { body } = await me(token);
    expect(body.stats.library).toBe(2);
  });

  it('sums session seconds and words, and reports the ladder level', async () => {
    const { row, token } = await createUser('pro');
    await database.insert(readingSessions).values([
      sessionRow(row.id, { seconds: 3600, words: 900, readDay: '2026-09-20' }),
      sessionRow(row.id, { seconds: 600, words: 150, readDay: '2026-09-21' }),
    ]);
    const { body } = await me(token);
    // int8/numeric aggregates arrive as strings on node-postgres; the route
    // must coerce them. Asserted as numbers so a raw string leaks out loudly.
    expect(body.stats.sessions).toBe(2);
    expect(body.stats.totalSeconds).toBe(4200);
    expect(body.stats.totalWords).toBe(1050);
    expect(body.level).toBe(2);
  });

  it('clamps negative session seconds so they cannot lower the level', async () => {
    const { row, token } = await createUser('pro');
    await database.insert(readingSessions).values([
      sessionRow(row.id, { seconds: 3600, words: 900, readDay: '2026-09-21' }),
      // A legacy v1 row can store negative seconds; the clamp must ignore it.
      sessionRow(row.id, { seconds: -500, words: -100, readDay: '2026-09-21' }),
    ]);
    const { body } = await me(token);
    expect(body.stats.totalSeconds).toBe(3600);
    expect(body.stats.totalWords).toBe(900);
    expect(body.level).toBe(2);
  });

  it('derives the streak from distinct read days, newest first, ignoring gaps', async () => {
    const { row, token } = await createUser('pro');
    const iso = (ago: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - ago);
      return d.toISOString().slice(0, 10);
    };
    await database.insert(readingSessions).values([
      sessionRow(row.id, { readDay: iso(0) }),
      sessionRow(row.id, { readDay: iso(0) }),
      sessionRow(row.id, { readDay: iso(1) }),
      sessionRow(row.id, { readDay: iso(9) }),
    ]);
    const { body } = await me(token);
    expect(body.stats.sessions).toBe(4);
    expect(body.stats.streakDays).toBe(2);
  });

  // The direction of the days subquery only matters past the 60-day cap: with
  // fewer distinct days, ASC and DESC return the same set and a reversed
  // ORDER BY would pass unnoticed. Seeding 90 distinct days makes the newest
  // 60 (which contain today) distinguishable from the oldest 60 (which do not).
  it('keeps the newest days when a reader has more distinct days than the cap', async () => {
    const { row, token } = await createUser('pro');
    const days: string[] = [];
    for (let ago = 0; ago < 90; ago += 1) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - ago);
      days.push(d.toISOString().slice(0, 10));
    }
    await database.insert(readingSessions).values(
      days.map((readDay) => sessionRow(row.id, { readDay })),
    );
    const { body } = await me(token);
    expect(body.stats.sessions).toBe(90);
    // The cap bounds the streak at the 60 returned days: today is inside the
    // newest 60, so the streak is 60. With the order reversed the slice is the
    // oldest 60 (days 89..30 ago), which excludes today, and the streak is 0.
    expect(body.stats.streakDays).toBe(60);
  });

  it('reads zero, not null, for an account with no rows at all', async () => {
    const { token } = await createUser();
    const { body } = await me(token);
    expect(body.stats).toMatchObject({ library: 0, history: 0, sessions: 0, totalSeconds: 0, totalWords: 0 });
    expect(body.level).toBe(1);
    expect(body.stats.streakDays).toBe(0);
  });

  it('counts visible comments and their likes on the public card', async () => {
    const { row } = await createUser('pro');
    const base = Date.now();
    await database.insert(comments).values([
      { novelId, userId: row.id, chapterNumber: 1, body: 'a', bodyHash: 'ha', status: 'visible', likesCount: 3, depth: 0, createdAt: new Date(base) },
      { novelId, userId: row.id, chapterNumber: 1, body: 'b', bodyHash: 'hb', status: 'visible', likesCount: 5, depth: 0, createdAt: new Date(base) },
      { novelId, userId: row.id, chapterNumber: 1, body: 'c', bodyHash: 'hc', status: 'hidden', likesCount: 100, depth: 0, createdAt: new Date(base) },
    ]);
    await database.insert(readingSessions).values([sessionRow(row.id, { seconds: 10800, readDay: '2026-09-28' })]);
    const { status, body } = await pub(row.id);
    expect(status).toBe(200);
    expect(body.stats).toEqual({ commentsCount: 2, likesReceived: 8 });
    expect(body.level).toBe(3);
    expect(body.isPro).toBe(true);
  });

  // The unit fake cannot catch this one: it answers from row OBJECTS and matches
  // on select keys, so it never executes the column list. Omitting
  // `profileDecorations` from PROFILE_USER_COLUMNS therefore left all 29 unit
  // tests green while the real query returned no such column and the projection
  // read `undefined`. Only Postgres runs the SQL, so only Postgres catches it.
  it('reads the decorations column off the real users row', async () => {
    const { row, token } = await createUser('pro');
    const stored: ProfileDecorations = {
      nameEffect: { kind: 'fire', color: '#FF7043', color2: '#FFD740' },
      bannerGradient: { target: 'below', color: '#4CAF50', fade: 'soft', extent: 'mid', strength: 60 },
      avatarFrameKey: 'fan_avatar/gold_avatar_frame_512.png',
    };
    await database.update(users)
      .set({ profileDecorations: stored })
      .where(eq(users.id, row.id));
    // Private projection.
    const priv = await me(token);
    expect(priv.status).toBe(200);
    expect(priv.body.user.decorations).toEqual(stored);
    // And the public one, which reads the same row through a different route.
    const publicCard = await pub(row.id);
    expect(publicCard.body.user.decorations).toEqual(stored);
  });

  // A row that cannot be validated must not reach a renderer as a partial card.
  it('degrades a hand-written unvalidatable column to null on real Postgres', async () => {
    const { row } = await createUser();
    // Written past the zod gate, exactly what a newer client or a hand edit does.
    await database.execute(sql`
      UPDATE "users" SET "profile_decorations" = ${JSON.stringify({
        nameEffect: { kind: 'hologram', color: '#fff', color2: '#000' },
      })}::jsonb WHERE "id" = ${row.id}::uuid
    `);
    const body = await pub(row.id);
    expect(body.body.user.decorations).toBeNull();
  });

  it('never exposes email on the public card, and rejects unknown ids', async () => {
    const { row } = await createUser();
    const { body } = await pub(row.id);
    expect(body.user).not.toHaveProperty('email');
    expect(JSON.stringify(body)).not.toContain(row.email);
    const missing = await pub('33333333-3333-4333-8333-333333333333');
    expect(missing.status).toBe(404);
  });

  it('keeps UUID precedence when a second account stores that UUID as externalId', async () => {
    const { row, externalId } = await createUser();
    // The shadow row claims the first account's UUID in its externalId column.
    const [shadow] = await database.insert(users).values({
      id: SHADOW_UUID,
      externalId: row.id,
      email: `${nextSubject()}@shadow.test`,
      username: `${nextSubject()}-shadow`,
      displayName: 'Shadow',
      role: 'reader',
    }).returning();
    expect(shadow.externalId).toBe(row.id);
    const byUuid = await pub(row.id);
    expect(byUuid.body.user.externalId).toBe(externalId);
    const byShadow = await pub(shadow.id);
    expect(byShadow.body.user.externalId).toBe(row.id);
  });
});
