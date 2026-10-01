import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { readingSessions, users } from '../database/schema.js';
import { FREE_STATS_KEYS, MAX_SESSIONS_PER_PUSH, PRO_ONLY_STATS_KEYS, freeReadingSyncPushResponseSchema, proReadingSyncPullResponseSchema } from '../features/readingSync/contracts.js';
import { calculateFreeStats } from '../features/readingSync/calculations.js';
import { toFreeScanSession } from '../features/readingSync/freeStore.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';

const DATABASE_NAME = 'plan_sync_test';

/**
 * End-to-end Free-plan sync against the isolated local cluster booted by
 * src/test/pgGlobalSetup.ts. The wire contract is asserted in
 * readingStats.plan.test.ts; this file proves the storage consequences:
 * the safe defaults, the completion marker, the (user, clientSessionId)
 * idempotency boundary, the 85% boundary, and that a legacy v1 row never
 * counts as completion evidence.
 *
 * Isolation: the sibling PostgreSQL suite truncates `users` between tests, so
 * this file provisions its OWN database on the same throwaway cluster and keys
 * every fixture on a unique `plan-pg-*` externalId. Neither file can observe
 * or erase the other's rows, and neither can touch a production database: the
 * derived URL must stay on the local host that PHASE1_PG_URL named.
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

const FIXTURE_PREFIX = 'plan-pg-';
const JWT_SECRET = 'plan-pg-fixture-signing-key-32-bytes-min';
let counter = 0;

const savedEnv = { ...process.env };

describe.skipIf(!url)('Free reading plan sync (isolated PostgreSQL)', () => {
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

  async function request(path: string, body: unknown, token: string | null) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  const freePush = (externalId: string, sessions: unknown[], token: string) =>
    request('/sync/push', { syncVersion: 2, user: { externalId }, deviceId: 'device-a', sessions }, token);

  const session = (overrides: Record<string, unknown> = {}) => ({
    clientSessionId: 'm-abc123-7',
    novelId: '42',
    chapterId: 7,
    seconds: 83,
    progressPercent: 91,
    completed: true,
    ts: 1782470400000,
    ...overrides,
  });

  const storedRows = (userId: string) => database
    .select()
    .from(readingSessions)
    .where(eq(readingSessions.userId, userId));

  /**
   * Block until some backend is parked on a lock while touching
   * reading_sessions — i.e. until the push under test has finished its pre-flight
   * read and is waiting inside its INSERT for the uncommitted winner. Polling
   * pg_stat_activity keeps the race deterministic; a fixed sleep would make the
   * mid-batch 409 assertion a coin flip.
   */
  async function waitForBlockedSessionInsert(observer: pg.Pool, attempts = 200): Promise<void> {
    for (let index = 0; index < attempts; index += 1) {
      const { rows } = await observer.query<{ blocked: number }>(
        `SELECT count(*)::int AS blocked FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%reading_sessions%'`,
      );
      if (rows[0]?.blocked && rows[0].blocked > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no session insert blocked on the uncommitted winner');
  }

  beforeAll(async () => {
    // Provision the suite's own database on the throwaway cluster.
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
    await admin.end();

    pool = new pg.Pool({ connectionString: url, max: 5 });
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });
    // Production-shaped env: sync closed, no fixture provisioning, and a real
    // (isolated) database URL so the route's lazy db proxy resolves here.
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = url;
    process.env.SYNC_OPEN = 'false';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';
    vi.stubGlobal('__WORKER_ENV__', undefined);
    await initDb();
    const { syncRouter } = await import('./sync.js');
    const { profileRouter } = await import('./profile.js');
    app = new Hono().route('/sync', syncRouter).route('/users', profileRouter);
  }, 30_000);

  afterEach(async () => {
    const owned = await database.select({ id: users.id }).from(users).where(like(users.externalId, `${FIXTURE_PREFIX}%`));
    for (const { id } of owned) {
      await database.delete(readingSessions).where(eq(readingSessions.userId, id));
      await database.delete(schema.userLibrary).where(eq(schema.userLibrary.userId, id));
      await database.delete(schema.readingHistory).where(eq(schema.readingHistory.userId, id));
      await database.delete(schema.readingChapterState).where(eq(schema.readingChapterState.userId, id));
      await database.delete(schema.readingNovels).where(eq(schema.readingNovels.userId, id));
    }
    if (owned.length > 0) {
      await database.delete(users).where(like(users.externalId, `${FIXTURE_PREFIX}%`));
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // Release the route's own pool before the throwaway cluster is stopped.
    await closeDb();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    await pool?.end();
  });

  it('stores a Free event with completion markers and inert Pro defaults', async () => {
    const { row, externalId, token } = await createUser();
    const before = Date.now();
    const res = await freePush(externalId, [session(), session({ clientSessionId: 'm-def456-8', chapterId: 8 })], token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      plan: 'free',
      serverNow: expect.any(Number),
      applied: { sessions: 2 },
      acceptedSessionIds: ['m-abc123-7', 'm-def456-8'],
    });
    // The route assembles the envelope field by field; parsing it back through
    // the declared contract keeps that hand-assembly from drifting.
    const parsed = freeReadingSyncPushResponseSchema.safeParse(body);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    // serverNow is the client's clock anchor, not a build-time constant: it must
    // be this request's now, never a fixture value or a stale cached body.
    expect(body.serverNow).toBeGreaterThanOrEqual(before);
    expect(body.serverNow).toBeLessThanOrEqual(Date.now());

    const rows = await storedRows(row.id);
    expect(rows).toHaveLength(2);
    for (const stored of rows) {
      expect(stored).toMatchObject({
        completionSignalPresent: true,
        proFieldsPresent: false,
        // NOT NULL Pro columns keep safe defaults, never client data.
        words: 0,
        minuteOfDay: 0,
        readDay: '',
        genre: '',
      });
    }
    expect(rows[0]).toMatchObject({
      clientSessionId: 'm-abc123-7',
      novelId: '42',
      chapterId: 7,
      seconds: 83,
      progressPercent: 91,
      completed: true,
      ts: 1782470400000,
    });
  });

  it('rejects Pro fields before any row is written', async () => {
    const { row, externalId, token } = await createUser();
    for (const payload of [
      { ...session(), words: 900 },
      { ...session(), minuteOfDay: 1380 },
      { ...session(), readDay: '2026-09-25' },
      { ...session(), genre: 'Fantasy' },
      { ...session(), fullWords: 900 },
      { ...session(), scrollY: 420 },
      { ...session(), content: 'chapter body' },
      { ...session(), cover: 'https://cdn.test/c.png' },
      { ...session(), filePath: '/sdcard/novel.txt' },
    ]) {
      const res = await freePush(externalId, [payload], token);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('pro_fields_not_allowed');
      expect(await storedRows(row.id)).toHaveLength(0);
    }
    for (const key of ['library', 'history', 'chapterStates', 'novels']) {
      const res = await request('/sync/push', {
        syncVersion: 2, user: { externalId }, [key]: [{ novelId: '42' }], sessions: [session()],
      }, token);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('pro_fields_not_allowed');
      expect(await storedRows(row.id)).toHaveLength(0);
    }
  });

  it('acknowledges an identical retry as a duplicate without double counting', async () => {
    const { row, externalId, token } = await createUser();
    const payload = [session()];
    const first: any = await (await freePush(externalId, payload, token)).json();
    const second = await freePush(externalId, payload, token);
    expect(second.status).toBe(200);
    const retry: any = await second.json();
    expect(retry.success).toBe(true);
    expect(retry.applied).toEqual({ sessions: 0 });
    expect(retry.acceptedSessionIds).toEqual(['m-abc123-7']);
    // A push response no longer carries an aggregate at all.
    expect(retry).not.toHaveProperty('stats');
    expect(await storedRows(row.id)).toHaveLength(1);
  });

  it('converges concurrent retries of one id on a single immutable row', async () => {
    const { row, externalId, token } = await createUser();
    const results = await Promise.all(Array.from({ length: 5 }, () => freePush(externalId, [session()], token)));
    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    const applied = (await Promise.all(results.map((res) => res.json()))).map((body: any) => body.applied.sessions);
    expect(applied.reduce((sum: number, count: number) => sum + count, 0)).toBe(1);
    expect(await storedRows(row.id)).toHaveLength(1);
  });

  // Five different events under ONE id, pushed concurrently: exactly one can be
  // the first accepted payload, so exactly one 200 and four 409s. This is the
  // real-database shape of losing the single multi-row insert, and it proves the
  // loser neither overwrites the winner nor reports a success.
  it('resolves a real concurrent insert race to one winner and named 409s', async () => {
    const { row, externalId, token } = await createUser();
    const events = [0, 1, 2, 3, 4].map((i) => session({ clientSessionId: 'm-race', seconds: 100 + i }));
    const results = await Promise.all(events.map((event) => freePush(externalId, [event], token)));
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(4);
    for (const res of results.filter((candidate) => candidate.status === 409)) {
      const body: any = await res.json();
      expect(body).toMatchObject({ success: false, code: 'session_conflict', conflictingSessionIds: ['m-race'] });
      // A single-id batch lost the race, so it applied nothing of its own.
      expect(body).not.toHaveProperty('acceptedSessionIds');
    }
    const [stored] = await storedRows(row.id);
    expect(events.map((event) => event.seconds)).toContain(stored.seconds);
  });

  // The mid-batch case: a batch whose own id inserts fine and whose raced id
  // does not. Those rows are immutable valid events, so the 409 has to name them
  // as accepted or the client keeps re-pushing events the server already stored.
  //
  // The interleaving is forced rather than raced: a second transaction inserts
  // the contested id and stays uncommitted, so the push's pre-flight read sees
  // nothing (a READ COMMITTED reader never blocks and never sees it) and its
  // statement then blocks on the unique index. Committing the winner at that
  // point is the only way to reach the mid-batch answer, and the test waits for
  // the blocked statement instead of sleeping and hoping.
  it('reports the ids it did create on a mid-batch 409', async () => {
    const { row, externalId, token } = await createUser();
    const winner = new pg.Client({ connectionString: url });
    await winner.connect();
    try {
      await winner.query('BEGIN');
      await winner.query(
        `INSERT INTO reading_sessions
           (user_id, client_session_id, novel_id, chapter_id, progress_percent, completed,
            completion_signal_present, pro_fields_present, seconds, words, minute_of_day, read_day, genre, ts)
         VALUES ($1, 'm-race', '42', 7, 100, true, true, false, 10, 0, 0, '', '', 1782470400000)`,
        [row.id],
      );

      const pending = freePush(externalId, [
        session({ clientSessionId: 'm-a1' }),
        session({ clientSessionId: 'm-race', seconds: 20 }),
      ], token);
      await waitForBlockedSessionInsert(pool);
      await winner.query('COMMIT');

      const res = await pending;
      expect(res.status).toBe(409);
      const body: any = await res.json();
      expect(body).toMatchObject({ success: false, code: 'session_conflict' });
      expect(body.conflictingSessionIds).toEqual(['m-race']);
      // The row this request DID create is reported, so the client can drop it.
      expect(body.acceptedSessionIds).toEqual(['m-a1']);
    } finally {
      await winner.query('ROLLBACK').catch(() => {});
      await winner.end();
    }

    // Nothing was overwritten: the winner's row stands, and a retry of our own
    // id is a duplicate acknowledgement rather than a conflict.
    const rows = await storedRows(row.id);
    expect(rows.map((r) => r.clientSessionId).sort()).toEqual(['m-a1', 'm-race']);
    expect(rows.find((r) => r.clientSessionId === 'm-race')).toMatchObject({ seconds: 10 });
    const retry: any = await (await freePush(externalId, [session({ clientSessionId: 'm-a1' })], token)).json();
    expect(retry).toMatchObject({ applied: { sessions: 0 }, acceptedSessionIds: ['m-a1'] });
  });

  it('rejects a changed retry with 409 and never overwrites the first event', async () => {
    const { row, externalId, token } = await createUser();
    expect((await freePush(externalId, [session()], token)).status).toBe(200);

    for (const changed of [
      { seconds: 84 },
      { progressPercent: 92 },
      { chapterId: 9 },
      { novelId: '43' },
      { ts: 1782470400001 },
    ]) {
      const res = await freePush(externalId, [session(changed)], token);
      expect(res.status).toBe(409);
      const body: any = await res.json();
      expect(body).toMatchObject({ success: false, code: 'session_conflict', conflictingSessionIds: ['m-abc123-7'] });
    }
    const [stored] = await storedRows(row.id);
    expect(stored).toMatchObject({ seconds: 83, progressPercent: 91, chapterId: 7, novelId: '42', ts: 1782470400000 });
  });

  it('rejects a conflicted batch whole so no sibling session is half applied', async () => {
    const { row, externalId, token } = await createUser();
    await freePush(externalId, [session()], token);
    const res = await freePush(externalId, [session({ seconds: 1 }), session({ clientSessionId: 'm-new-9' })], token);
    expect(res.status).toBe(409);
    expect(await storedRows(row.id)).toHaveLength(1);
  });

  // A payload that carries one id twice with different values is
  // self-contradictory: storing either copy would make the other a permanent
  // conflict, so the whole batch is refused before any row is written.
  it('rejects a self-contradictory duplicate id inside one payload', async () => {
    const { row, externalId, token } = await createUser();
    const res = await freePush(externalId, [
      session({ clientSessionId: 'm-dup-1', seconds: 10, progressPercent: 10, completed: false }),
      session({ clientSessionId: 'm-dup-1', seconds: 20, progressPercent: 10, completed: false }),
      session({ clientSessionId: 'm-sibling-2', chapterId: 8 }),
    ], token);
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body).toMatchObject({ success: false, code: 'session_conflict', conflictingSessionIds: ['m-dup-1'] });
    expect(await storedRows(row.id)).toHaveLength(0);

    // An identical repeat of one id inside a payload is a harmless duplicate.
    const ok = await freePush(externalId, [
      session({ clientSessionId: 'm-same-1', seconds: 10, progressPercent: 10, completed: false }),
      session({ clientSessionId: 'm-same-1', seconds: 10, progressPercent: 10, completed: false }),
    ], token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ applied: { sessions: 1 }, acceptedSessionIds: ['m-same-1'] });
    expect(await storedRows(row.id)).toHaveLength(1);
  });

  it('honours the 85% completion boundary and counts each chapter once', async () => {
    const { externalId, token } = await createUser();
    const res = await freePush(externalId, [
      session({ clientSessionId: 'm-below-1', chapterId: 1, progressPercent: 84.9, completed: false }),
      session({ clientSessionId: 'm-at-2', chapterId: 2, progressPercent: 85, completed: true }),
      session({ clientSessionId: 'm-above-3', chapterId: 3, progressPercent: 100, completed: true }),
      session({ clientSessionId: 'm-again-2', chapterId: 2, progressPercent: 100, completed: true }),
    ], token);
    expect(res.status).toBe(200);
    // The aggregate is a READ: the push only acknowledges the write.
    const pulled: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(pulled.stats.uniqueInAppCompletedChapters).toBe(2);
    const body: any = await res.json();
    expect(body).not.toHaveProperty('stats');
    expect(body.applied).toEqual({ sessions: 4 });
  });

  // The completion marker proves the client emitted the in-app signal; it is
  // what separates a real completion from a legacy row. A valid 84.9% row is
  // therefore stored as signalled-but-not-completed, and is never counted.
  it('marks a valid non-completed 84.9% v2 row as signalled but not completed', async () => {
    const { row, externalId, token } = await createUser();
    const res = await freePush(externalId, [
      session({ clientSessionId: 'm-near-1', chapterId: 1, seconds: 120, progressPercent: 84.9, completed: false }),
    ], token);
    expect(res.status).toBe(200);
    const [stored] = await storedRows(row.id);
    expect(stored).toMatchObject({
      clientSessionId: 'm-near-1',
      progressPercent: 84.9,
      completed: false,
      completionSignalPresent: true,
      proFieldsPresent: false,
    });
    // Signed but below the boundary: time counts, the chapter does not.
    const pulled: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(pulled.stats).toMatchObject({ totalSecondsRead: 120, uniqueInAppCompletedChapters: 0 });
  });

  it('treats a legacy v1 session as time only, never as completion evidence', async () => {
    const { row, externalId, token } = await createUser();
    const legacy = await request('/sync/push', {
      user: { externalId },
      sessions: [{ clientSessionId: 'legacy-1', novelId: '42', chapterId: 7, seconds: 600, words: 500, readDay: '2026-09-20', genre: 'Fantasy', ts: 1782000000000 }],
    }, token);
    expect(legacy.status).toBe(200);
    // Legacy response shape is untouched: no plan, no stats projection.
    const legacyBody: any = await legacy.json();
    expect(legacyBody).toMatchObject({ success: true, applied: { sessions: 1 } });
    expect(legacyBody).not.toHaveProperty('plan');
    expect(legacyBody).not.toHaveProperty('stats');

    const [stored] = await storedRows(row.id);
    expect(stored.completionSignalPresent).toBe(false);
    expect(stored.proFieldsPresent).toBe(false);

    const push: any = await (await freePush(externalId, [session({ clientSessionId: 'v2-1', chapterId: 11 })], token)).json();
    // The write is acknowledged without an aggregate; only the pull returns one.
    expect(push).not.toHaveProperty('stats');
    expect(push.applied).toEqual({ sessions: 1 });

    const pulled: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(Object.keys(pulled).sort()).toEqual(['plan', 'stats', 'success']);
    expect(pulled.stats).toMatchObject({ totalSecondsRead: 683, uniqueInAppCompletedChapters: 1 });
  });

  it('keeps the existing owner policy on the v2 channel', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const res = await freePush(stranger.externalId, [session()], owner.token);
    expect(res.status).toBe(403);
    expect(await storedRows(stranger.row.id)).toHaveLength(0);
    expect((await request('/sync/push', { syncVersion: 2, user: { externalId: stranger.externalId } }, null)).status).toBe(401);
    expect((await request('/sync/pull', { syncVersion: 2, user: { externalId: stranger.externalId } }, null)).status).toBe(401);
  });

  it.skip('legacy Task 6 expectation: pro account failed closed', async () => {
    const free = await createUser('free');
    const pro = await createUser('pro');
    expect((await request('/sync/push', { syncVersion: 2, user: { externalId: free.externalId }, plan: 'pro', sessions: [session()] }, free.token)).status).toBe(400);
    expect((await freePush(free.externalId, [session()], free.token)).status).toBe(200);

    for (const res of [
      await freePush(pro.externalId, [session()], pro.token),
      await request('/sync/pull', { syncVersion: 2, user: { externalId: pro.externalId } }, pro.token),
      await app.request(`/users/me/profile?readingStatsVersion=2`, { headers: { Authorization: `Bearer ${pro.token}` } }),
    ]) {
      expect(res.status).toBe(501);
      const body: any = await res.json();
      expect(body).toMatchObject({ success: false, code: 'pro_plan_not_implemented', plan: 'pro' });
      expect(JSON.stringify(body)).not.toMatch(/level|streak|words/i);
    }
    // A Pro account's Free-shaped push must not have written anything.
    expect(await storedRows(pro.row.id)).toHaveLength(0);
  });

  // A Pro client sends the payload it really sends: Pro session dimensions and
  // Pro collections. The plan is resolved before parsing, so the answer is the
  // documented 501 (surface unimplemented) rather than the Free contract's
  // 403/400 (payload shape) — and nothing is stored either way.
  it.skip('legacy Task 6 expectation: Pro-shaped push 501', async () => {
    const pro = await createUser('pro');
    const free = await createUser('free');
    const proShapedSession = { ...session(), words: 120, minuteOfDay: 1380, readDay: '2026-09-25' };
    const proShaped = { sessions: [proShapedSession], library: [{ novelId: '42' }] };

    const res = await request('/sync/push', { syncVersion: 2, user: { externalId: pro.externalId }, ...proShaped }, pro.token);
    expect(res.status).toBe(501);
    const body: any = await res.json();
    expect(body).toMatchObject({ success: false, code: 'pro_plan_not_implemented', plan: 'pro' });
    expect(JSON.stringify(body)).not.toMatch(/level|streak|words/i);
    expect(await storedRows(pro.row.id)).toHaveLength(0);
    expect(await database.select().from(schema.userLibrary).where(eq(schema.userLibrary.userId, pro.row.id))).toHaveLength(0);

    // Same payload for a Free account: a 403 entitlement violation, still no rows.
    const freeRes = await request('/sync/push', { syncVersion: 2, user: { externalId: free.externalId }, ...proShaped }, free.token);
    expect(freeRes.status).toBe(403);
    expect((await freeRes.json()).code).toBe('pro_fields_not_allowed');
    expect(await storedRows(free.row.id)).toHaveLength(0);
  });

  // The legacy channel keeps wire shapes but gates Pro values per § Legacy v1
  // gating: a Free-derived caller stores readDay '' for history (sessions get
  // FREE_SESSION_SAFE_DEFAULTS). Library merge rules are untouched.
  it('keeps the legacy v1 library and history writes unchanged', async () => {
    const { row, externalId, token } = await createUser();
    const legacyPush = () => request('/sync/push', {
      user: { externalId },
      library: [{ novelId: '42', sourceId: 'novel-42', categoryIds: ['a'], lastReadChapterId: 7,
        lastReadChapterNumber: 7, progressPercent: 40, addedAt: '2026-09-20T10:00:00.000Z', updatedAt: 1782000000000 }],
      history: [{ novelId: '42', novelTitle: 'A Novel', novelAuthor: 'An Author', category: 'Fantasy', sourceId: 'novel-42',
        chapterId: 7, chapterNumber: 7, chapterTitle: 'Ch 7', progressPercent: 40, readDay: '2026-09-20',
        readAt: 1782000000000, updatedAt: 1782000000000 }],
    }, token);

    const first = await legacyPush();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, applied: { library: 1, history: 1 } });

    const [library] = await database.select().from(schema.userLibrary).where(eq(schema.userLibrary.userId, row.id));
    expect(library).toMatchObject({ novelId: '42', sourceId: 'novel-42', categoryIds: ['a'],
      lastReadChapterId: 7, lastReadChapterNumber: 7, progressPercent: 40 });
    const [history] = await database.select().from(schema.readingHistory).where(eq(schema.readingHistory.userId, row.id));
    expect(history).toMatchObject({ novelId: '42', novelTitle: 'A Novel', novelAuthor: 'An Author', category: 'Fantasy',
      chapterId: 7, chapterNumber: 7, readDay: '', readAt: 1782000000000 });

    // The merge rules are untouched: an identical replay writes nothing.
    const replay = await legacyPush();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ applied: { library: 0, history: 0 } });
    expect(await database.select().from(schema.userLibrary).where(eq(schema.userLibrary.userId, row.id))).toHaveLength(1);
    expect(await database.select().from(schema.readingHistory).where(eq(schema.readingHistory.userId, row.id))).toHaveLength(1);

    // A newer client clock does win, as before.
    const newer = await request('/sync/push', {
      user: { externalId },
      library: [{ novelId: '42', progressPercent: 55, updatedAt: 1782000000001 }],
      history: [{ novelId: '42', chapterId: 7, progressPercent: 55, readAt: 1782000000001, updatedAt: 1782000000001 }],
    }, token);
    expect(newer.status).toBe(200);
    expect(await newer.json()).toMatchObject({ applied: { library: 1, history: 1 } });
    const [updatedLibrary] = await database.select().from(schema.userLibrary).where(eq(schema.userLibrary.userId, row.id));
    expect(updatedLibrary.progressPercent).toBe(55);
    // Collections are Pro scope, so they stay invisible to the Free projection.
    const pulled: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(pulled).toEqual({ success: true, plan: 'free',
      stats: { level: 1, levelProgress: 0, totalSecondsRead: 0, uniqueInAppCompletedChapters: 0 } });
  });

  it('returns the authoritative plan and exactly the Free stats keys', async () => {
    const { externalId, token } = await createUser();
    await freePush(externalId, [session()], token);
    const res = await app.request('/users/me/profile?readingStatsVersion=2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.plan).toBe('free');
    expect(body.readingStatsVersion).toBe(2);
    expect(Object.keys(body.readingStats).sort()).toEqual([...FREE_STATS_KEYS].sort());
    expect(body.readingStats).toEqual({
      level: 1,
      // floor(83s / 60) = 1 active minute against a 60-minute first threshold.
      levelProgress: expect.closeTo(1 / 60, 6),
      totalSecondsRead: 83,
      uniqueInAppCompletedChapters: 1,
    });
    for (const key of PRO_ONLY_STATS_KEYS) {
      expect(body.readingStats).not.toHaveProperty(key);
    }
  });

  // The versioned body is plan-scoped, not "legacy + extra keys": only the
  // identity fields, the authoritative plan, the version and the four Free
  // stats. `stats` and the levelInfo spread are Pro dimensions, so the whole
  // serialized body is checked for them.
  it('carries no legacy aggregate in the versioned body', async () => {
    const { externalId, token } = await createUser();
    await freePush(externalId, [session()], token);
    const legacy = await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
    const versioned = await app.request('/users/me/profile?readingStatsVersion=2', { headers: { Authorization: `Bearer ${token}` } });
    expect(versioned.status).toBe(200);
    const legacyBody: any = await legacy.json();
    const versionedText = await versioned.text();
    const versionedBody: any = JSON.parse(versionedText);

    expect(Object.keys(versionedBody).sort()).toEqual(['plan', 'planExpiresAt', 'readingStats', 'readingStatsVersion', 'success', 'user']);
    // The identity projection is identical on both payloads.
    expect(versionedBody.user).toEqual(legacyBody.user);
    // `stats` and the levelInfo spread are Pro dimensions, so no legacy-only key
    // may appear anywhere in the versioned body — top level or nested.
    const legacyOnlyKeys = [
      ...Object.keys(legacyBody)
        .filter((key) => key !== 'user' && key !== 'success' && !(FREE_STATS_KEYS as readonly string[]).includes(key)),
      ...Object.keys(legacyBody.stats),
    ];
    expect(legacyOnlyKeys).toEqual(expect.arrayContaining(
      ['stats', 'tier', 'totalWords', 'streakDays', 'minutesToNext', 'library', 'totalSeconds'],
    ));
    for (const key of legacyOnlyKeys) {
      expect(versionedText.includes(`"${key}":`)).toBe(false);
    }
    // The four shared Free keys live inside readingStats only, never at the top.
    for (const key of FREE_STATS_KEYS) {
      expect(versionedBody).not.toHaveProperty(key);
      expect(versionedBody.readingStats).toHaveProperty(key);
    }
    expect(versionedBody).not.toHaveProperty('stats');
    // ...and the legacy payload keeps its own shape untouched.
    expect(legacyBody).not.toHaveProperty('readingStats');
    expect(legacyBody).not.toHaveProperty('plan');
    expect(legacyBody).not.toHaveProperty('readingStatsVersion');
    expect(legacyBody.stats).toEqual({ library: 0, history: 0, sessions: 1, totalSeconds: 83, totalWords: 0, streakDays: 0 });
  });

  it('never leaks raw rows or Pro aggregates in a v2 response', async () => {
    const { externalId, token } = await createUser();
    await freePush(externalId, [session()], token);
    // 'level' and 'levelProgress' are shared by both plans, so the Pro-only
    // allowlist is the meaningful privacy check.
    const proOnly = PRO_ONLY_STATS_KEYS;
    const rawRowPattern = /"clientSessionId"|"library"|"history"|"chapterStates"|"novels"|"words"|"scrollY"|"content"/;

    // A push now carries NO aggregate at all, which is the strongest form of
    // this check: there is no projection to leak.
    const pushText = await (await freePush(externalId, [], token)).text();
    const pushBody = JSON.parse(pushText);
    expect(pushBody).not.toHaveProperty('stats');
    for (const key of proOnly) expect(pushBody).not.toHaveProperty(key);
    expect(pushText).not.toMatch(rawRowPattern);

    const pullText = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).text();
    const pullBody = JSON.parse(pullText);
    expect(Object.keys(pullBody.stats).sort()).toEqual([...FREE_STATS_KEYS].sort());
    for (const key of proOnly) expect(pullBody).not.toHaveProperty(key);
    expect(pullText).not.toMatch(rawRowPattern);

    // The plan-scoped profile body is checked WHOLE, not only inside
    // readingStats: the legacy payload used to be spread into it, so a leak
    // would show up as a top-level `stats`/levelInfo key.
    const profileText = await (await app.request('/users/me/profile?readingStatsVersion=2', {
      headers: { Authorization: `Bearer ${token}` },
    })).text();
    const profile = JSON.parse(profileText);
    expect(Object.keys(profile.readingStats).sort()).toEqual([...FREE_STATS_KEYS].sort());
    for (const key of proOnly) {
      expect(profile).not.toHaveProperty(key);
      expect(profileText).not.toContain(`"${key}":`);
    }
    expect(profileText).not.toMatch(rawRowPattern);
  });

  it('answers malformed payloads with 400 and leaves storage untouched', async () => {
    const { row, externalId, token } = await createUser();
    const cases: unknown[] = [
      [session({ seconds: -1 })],
      [session({ progressPercent: 101, completed: true })],
      [session({ progressPercent: 85, completed: false })],
      [session({ clientSessionId: 'not a valid id' })],
      [session({ chapterId: 0 })],
      'not-an-array',
    ];
    for (const sessions of cases) {
      const res = await freePush(externalId, sessions as never, token);
      expect(res.status).toBe(400);
      expect((await res.json()).success).toBe(false);
    }
    expect(await storedRows(row.id)).toHaveLength(0);
  });

  it('stores a push at the contract limit in one request and rejects anything above it', async () => {
    const { externalId, token } = await createUser();
    const batch = (count: number, prefix: string) => Array.from({ length: count }, (_value, index) =>
      session({ clientSessionId: `${prefix}-${index}`, chapterId: index + 1, seconds: 10, progressPercent: 10, completed: false }));
    const res = await freePush(externalId, batch(MAX_SESSIONS_PER_PUSH, 'bulk'), token);
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toEqual({ sessions: MAX_SESSIONS_PER_PUSH });
    const overflow = await freePush(externalId, batch(MAX_SESSIONS_PER_PUSH + 1, 'over'), token);
    expect(overflow.status).toBe(400);
  }, 30_000);

  it('answers an empty push without writing anything', async () => {
    const { row, externalId, token } = await createUser();
    const res = await freePush(externalId, [], token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      applied: { sessions: 0 },
      acceptedSessionIds: [],
    });
    expect(await storedRows(row.id)).toHaveLength(0);
  });

  it('scopes stats to the authenticated user only', async () => {
    const first = await createUser();
    const second = await createUser();
    await freePush(first.externalId, [session()], first.token);
    const pulled: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId: second.externalId } }, second.token)).json();
    expect(pulled.stats).toEqual({ level: 1, levelProgress: 0, totalSecondsRead: 0, uniqueInAppCompletedChapters: 0 });
  });

  it('rejects a syncVersion that is not exactly 2 before reaching storage', async () => {
    const { row, externalId, token } = await createUser();
    for (const syncVersion of ['2', 1.5, 3, null]) {
      const res = await request('/sync/push', { syncVersion, user: { externalId }, sessions: [session({ words: 900 })] }, token);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('unsupported_sync_version');
    }
    // v1 stays compatible on its own permissive channel.
    const legacy = await request('/sync/push', { syncVersion: 1, user: { externalId }, sessions: [] }, token);
    expect(legacy.status).toBe(200);
    expect(await storedRows(row.id)).toHaveLength(0);
  });

  it('recomputes the projection from stored rows, not from the pushed payload', async () => {
    const { externalId, token } = await createUser();
    await freePush(externalId, [session({ clientSessionId: 'seed-1', seconds: 3600 })], token);
    // The retry claims a different event but is rejected, so the projection
    // still reflects the immutable first event.
    expect((await freePush(externalId, [session({ clientSessionId: 'seed-1', seconds: 60 })], token)).status).toBe(409);
    const pulled: any = await (await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token)).json();
    expect(pulled.stats).toMatchObject({ level: 2, totalSecondsRead: 3600, uniqueInAppCompletedChapters: 1 });
  });

  // The read path aggregates in SQL instead of streaming every stored session
  // into memory. These rows are the ones that make a naive SQL total differ from
  // a row-by-row calculation: a duplicated chapter pair, a legacy row with no
  // completion marker, a blank novel id, a non-positive chapter id, a value just
  // below the 85% boundary, and a negative `seconds` that only the plan-blind
  // legacy v1 writer can produce.
  it('agrees with a full row scan on rows designed to break a naive aggregate', async () => {
    const { row, externalId, token } = await createUser();
    const base = {
      userId: row.id,
      progressPercent: 0,
      completed: false,
      proFieldsPresent: false,
      words: 0,
      minuteOfDay: 0,
      readDay: '',
      genre: '',
      ts: 1782000000000,
    } as const;
    await database.insert(readingSessions).values([
      { ...base, clientSessionId: 'agg-1', novelId: '42', chapterId: 1, seconds: 3600, progressPercent: 100, completed: true, completionSignalPresent: true },
      // Same (novel, chapter) again: one chapter, two events.
      { ...base, clientSessionId: 'agg-2', novelId: '42', chapterId: 1, seconds: 60, progressPercent: 100, completed: true, completionSignalPresent: true },
      // Legacy v1 row: time counts, never a completed chapter.
      { ...base, clientSessionId: 'agg-legacy', novelId: '42', chapterId: 1, seconds: 600, progressPercent: 100, completed: true, completionSignalPresent: false },
      // Blank novel id: normalizeNovelId rejects it, so no chapter is counted.
      { ...base, clientSessionId: 'agg-blank', novelId: '   ', chapterId: 2, seconds: 300, progressPercent: 100, completed: true, completionSignalPresent: true },
      // Chapter 0: normalizeChapterId rejects it.
      { ...base, clientSessionId: 'agg-zero', novelId: '42', chapterId: 0, seconds: 300, progressPercent: 100, completed: true, completionSignalPresent: true },
      // Just below the boundary, signalled but not completed.
      { ...base, clientSessionId: 'agg-below', novelId: '42', chapterId: 3, seconds: 300, progressPercent: 84.9, completionSignalPresent: true },
      // Negative seconds: credited as zero by the calculation boundary.
      { ...base, clientSessionId: 'agg-negative', novelId: '42', chapterId: 4, seconds: -100, progressPercent: 50, completionSignalPresent: true },
    ]);

    const scanned = calculateFreeStats((await storedRows(row.id)).map(toFreeScanSession));
    // Not trivially zero: 3600 + 60 + 600 + 300 + 300 + 300 + 0.
    expect(scanned.totalSecondsRead).toBe(5160);
    expect(scanned.uniqueInAppCompletedChapters).toBe(1);
    expect(scanned.level).toBe(2);

    const pulled = await request('/sync/pull', { syncVersion: 2, user: { externalId } }, token);
    expect(pulled.status).toBe(200);
    const body: any = await pulled.json();
    // The aggregated projection is byte-identical to the full scan it replaces.
    expect(body.stats).toEqual(scanned);
  });

  it('accepts Pro sessions and all Pro collections, then serves the full projection', async () => {
    const { externalId, token } = await createUser('pro');
    const payload = {
      syncVersion: 2,
      user: { externalId },
      deviceId: 'device-pro',
      sessions: [{
        clientSessionId: 'pro-session-1', novelId: '42', chapterId: 1,
        seconds: 600, words: 1000, minuteOfDay: 600, readDay: '2026-09-25',
        progressPercent: 100, completed: true, ts: 1782470400000,
      }],
      library: [{ novelId: '42', categoryIds: ['currently_reading'], updatedAt: 1782470400000 }],
      history: [{
        novelId: '42', chapterId: 1, chapterNumber: 1, readDay: '2026-09-25',
        readAt: 1782470400000, updatedAt: 1782470400000,
      }],
      chapterStates: [{ novelId: '42', chapterId: 2, isRead: true, origin: 'manual', updatedAt: 1782470400000 }],
      novels: [{ novelId: '42', title: 'Example', genre: 'Fantasy', totalChapters: 2, updatedAt: 1782470400000 }],
    };
    const res = await request('/sync/push', payload, token);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.plan).toBe('pro');
    expect(body.applied).toEqual({ sessions: 1, library: 1, history: 1, chapterStates: 1, novels: 1 });
    expect(body).not.toHaveProperty('stats');

    const pull = await request('/sync/pull', {
      syncVersion: 2, user: { externalId },
      readingStats: { libraryCursor: null, historyCursor: null, sessionCursor: null, year: 2026 },
    }, token);
    expect(pull.status).toBe(200);
    const pulled: any = await pull.json();
    expect(pulled.plan).toBe('pro');
    expect(pulled.sessions.rows).toHaveLength(1);
    expect(pulled.library.rows).toHaveLength(1);
    expect(pulled.history.rows).toHaveLength(1);
    expect(pulled.stats).toMatchObject({
      totalSecondsRead: 600,
      totalWords: 1000,
      uniqueInAppCompletedChapters: 1,
      combinedTotalChaptersCompleted: 2,
      completedNovels: [{ novelId: '42', title: 'Example' }],
    });
    // Every strict reader validates the page rows against proSessionSchema, so
    // ONE stale key invalidates the whole pull rather than just that row. The
    // matchObject assertions above cannot see that; this can.
    const parsed = proReadingSyncPullResponseSchema.safeParse(pulled);
    expect(parsed.success ? null : parsed.error.issues.slice(0, 3)).toBeNull();
    expect(pulled.sessions.rows[0]).not.toHaveProperty('genre');
  });

  it('keeps Pro session events immutable and idempotent', async () => {
    const { externalId, token } = await createUser('pro');
    const event = {
      clientSessionId: 'pro-immutable', novelId: '42', chapterId: 1,
      seconds: 60, words: 100, minuteOfDay: 60, readDay: '2026-09-25',
      progressPercent: 90, completed: true, ts: 1782470400000,
    };
    const envelope = (session: Record<string, unknown>) => ({ syncVersion: 2, user: { externalId }, sessions: [session] });
    expect((await request('/sync/push', envelope(event), token)).status).toBe(200);
    expect((await request('/sync/push', envelope(event), token)).status).toBe(200);
    const conflict = await request('/sync/push', envelope({ ...event, words: 200 }), token);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('session_conflict');
  });
  // The collection writers were rewritten from read-modify-write to a batched
  // conditional upsert. These pin the merge rules that rewrite had to preserve:
  // a lost LWW rule silently overwrites newer data with older.
  describe('collection merge rules', () => {
    const proCollectionPush = (externalId: string, token: string, body: Record<string, unknown>) =>
      request('/sync/push', {
        syncVersion: 2,
        user: { externalId },
        deviceId: 'device-merge',
        // Required by the Pro shape; these tests are about the collections.
        sessions: [],
        ...body,
      }, token);

    const readLibrary = (userId: string) =>
      database.select().from(schema.userLibrary).where(eq(schema.userLibrary.userId, userId));
    const readHistory = (userId: string) =>
      database.select().from(schema.readingHistory).where(eq(schema.readingHistory.userId, userId));
    const readStates = (userId: string) =>
      database.select().from(schema.readingChapterState).where(eq(schema.readingChapterState.userId, userId));
    const readNovels = (userId: string) =>
      database.select().from(schema.readingNovels).where(eq(schema.readingNovels.userId, userId));

    it('never lets an older write overwrite a newer one', async () => {
      const { row, externalId, token } = await createUser('pro');
      await proCollectionPush(externalId, token, {
        library: [{ novelId: '42', progressPercent: 80, updatedAt: 1782000000002 }],
        history: [{ novelId: '42', chapterId: 1, progressPercent: 80, readAt: 1782000000002, updatedAt: 1782000000002 }],
        chapterStates: [{ novelId: '42', chapterId: 1, isRead: true, origin: 'snapshot', updatedAt: 1782000000002 }],
        novels: [{ novelId: '42', title: 'New', genre: 'Fantasy', totalChapters: 10, updatedAt: 1782000000002 }],
      });

      const older = await proCollectionPush(externalId, token, {
        library: [{ novelId: '42', progressPercent: 10, updatedAt: 1782000000001 }],
        history: [{ novelId: '42', chapterId: 1, progressPercent: 10, readAt: 1782000000001, updatedAt: 1782000000001 }],
        chapterStates: [{ novelId: '42', chapterId: 1, isRead: false, origin: 'snapshot', updatedAt: 1782000000001 }],
        novels: [{ novelId: '42', title: 'Old', genre: 'Fantasy', totalChapters: 1, updatedAt: 1782000000001 }],
      });
      expect(await older.json()).toMatchObject({ applied: { library: 0, history: 0, chapterStates: 0, novels: 0 } });

      expect((await readLibrary(row.id))[0].progressPercent).toBe(80);
      expect(Number((await readHistory(row.id))[0].readAt)).toBe(1782000000002);
      expect((await readStates(row.id))[0].isRead).toBe(true);
      expect((await readNovels(row.id))[0].title).toBe('New');
    });

    it('breaks a history tie on the edit clock, not the read clock', async () => {
      const { row, externalId, token } = await createUser('pro');
      await proCollectionPush(externalId, token, {
        history: [{ novelId: '42', chapterId: 1, progressPercent: 70, readAt: 1782000000005, updatedAt: 1782000000005 }],
      });

      // Same readAt, OLDER edit: the tie-break must reject it.
      const olderEdit = await proCollectionPush(externalId, token, {
        history: [{ novelId: '42', chapterId: 1, progressPercent: 20, readAt: 1782000000005, updatedAt: 1782000000004 }],
      });
      expect(await olderEdit.json()).toMatchObject({ applied: { history: 0 } });
      expect((await readHistory(row.id))[0].progressPercent).toBe(70);

      // Same readAt, NEWER edit: applies.
      const newerEdit = await proCollectionPush(externalId, token, {
        history: [{ novelId: '42', chapterId: 1, progressPercent: 90, readAt: 1782000000005, updatedAt: 1782000000006 }],
      });
      expect(await newerEdit.json()).toMatchObject({ applied: { history: 1 } });
      expect((await readHistory(row.id))[0].progressPercent).toBe(90);
    });

    it('keeps a library tombstone final against a newer live write', async () => {
      const { row, externalId, token } = await createUser('pro');
      await proCollectionPush(externalId, token, {
        library: [{ novelId: '42', updatedAt: 1782000000001 }],
      });
      const removed = await proCollectionPush(externalId, token, {
        library: [{ novelId: '42', deletedAt: 1782000000000, updatedAt: 1782000000000 }],
      });
      expect(await removed.json()).toMatchObject({ applied: { library: 1 } });
      expect((await readLibrary(row.id))[0].deletedAt).not.toBeNull();

      const resurrect = await proCollectionPush(externalId, token, {
        library: [{ novelId: '42', updatedAt: 1782000000009 }],
      });
      expect(await resurrect.json()).toMatchObject({ applied: { library: 0 } });
      expect((await readLibrary(row.id))[0].deletedAt).not.toBeNull();
    });

    it('keeps a manual chapter mark sticky and never lets the read flag fall', async () => {
      const { row, externalId, token } = await createUser('pro');
      await proCollectionPush(externalId, token, {
        chapterStates: [{ novelId: '42', chapterId: 1, isRead: true, origin: 'snapshot', updatedAt: 1782000000001 }],
      });
      const fall = await proCollectionPush(externalId, token, {
        chapterStates: [{ novelId: '42', chapterId: 1, isRead: false, origin: 'snapshot', updatedAt: 1782000000001 }],
      });
      expect(await fall.json()).toMatchObject({ applied: { chapterStates: 0 } });
      expect((await readStates(row.id))[0].isRead).toBe(true);

      await proCollectionPush(externalId, token, {
        chapterStates: [{ novelId: '42', chapterId: 1, isRead: true, origin: 'manual', updatedAt: 1782000000002 }],
      });
      await proCollectionPush(externalId, token, {
        chapterStates: [{ novelId: '42', chapterId: 1, isRead: true, origin: 'snapshot', updatedAt: 1782000000003 }],
      });
      expect((await readStates(row.id))[0].origin).toBe('manual');
    });

    it('applies a same-clock novel update and never blanks a known label', async () => {
      const { row, externalId, token } = await createUser('pro');
      await proCollectionPush(externalId, token, {
        novels: [{ novelId: '42', title: 'Titled', genre: 'Fantasy', totalChapters: 10, updatedAt: 1782000000001 }],
      });
      const sameClock = await proCollectionPush(externalId, token, {
        novels: [{ novelId: '42', title: '', genre: '', totalChapters: null, updatedAt: 1782000000001 }],
      });
      expect(await sameClock.json()).toMatchObject({ applied: { novels: 1 } });
      const [novel] = await readNovels(row.id);
      expect(novel.title).toBe('Titled');
      expect(novel.genre).toBe('Fantasy');
      expect(novel.totalChapters).toBe(10);
    });
  });
});
