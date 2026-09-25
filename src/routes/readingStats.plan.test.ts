import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { signToken } from '../middleware/auth.js';
import { users } from '../database/schema.js';
import {
  FREE_STATS_KEYS,
  PRO_ONLY_STATS_KEYS,
  PRO_STATS_KEYS,
  freeReadingSyncPullResponseSchema,
} from '../features/readingSync/contracts.js';

// Protocol/authorization layer of the plan-scoped reading statistics channel.
// Persistence, idempotency and the real level ladder are covered by
// readingStats.plan.postgres.test.ts against the isolated local cluster; this
// file proves every rejection happens BEFORE a write is attempted, which the
// identity fake can assert exactly (its insert mock must stay untouched).
const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_target, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
}));

const SUBJECT = 'google_plan_subject';
let app: Hono;
let token: string;
const fake = () => holder.fake!;

const validSession = {
  clientSessionId: 'm-abc123-7',
  novelId: '42',
  chapterId: 7,
  seconds: 83,
  progressPercent: 91,
  completed: true,
  ts: 1782470400000,
};

const freeEnvelope = (sessions: unknown[] = [validSession]) => ({
  syncVersion: 2,
  user: { externalId: SUBJECT },
  deviceId: 'device-a',
  sessions,
});

// A Pro-shaped v2 push: every one of these keys is what a Pro client actually
// sends on upgrade, and the strict Free contract answers 403 for all of them.
const proShapedSession = () => ({
  ...validSession,
  words: 120,
  minuteOfDay: 1380,
  readDay: '2026-09-25',
  genre: 'Fantasy',
});

// Plan-scoped bodies are privacy-checked as a WHOLE: a Pro aggregate must not
// appear at any depth, so the assertion runs against the serialized text and not
// only against the nested `readingStats` object a leak would most easily hide in.
// `level` is deliberately absent from this list because it is a shared Free key —
// its placement is asserted structurally instead (exactly four keys inside
// readingStats, and no top-level `level`).
const PRO_LEAK_KEYS = [
  ...PRO_ONLY_STATS_KEYS,
  // Legacy /me/profile aggregates the versioned body must not carry either.
  'stats', 'library', 'history', 'sessions', 'totalSeconds', 'totalWords', 'streakDays',
  'tier', 'tierMeta', 'isTierEntry', 'isMax', 'progress', 'totalMinutes',
  'currentRequiredHours', 'nextRequiredHours', 'minutesIntoLevel', 'minutesToNext',
];

function expectNoProAggregateInBody(serialized: string) {
  for (const key of PRO_LEAK_KEYS) {
    expect(serialized.includes(`"${key}":`)).toBe(false);
  }
}

async function post(path: string, body: unknown, bearer: string | null = token) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}
const push = (body: unknown, bearer?: string | null) => post('/sync/push', body, bearer);
const pull = (body: unknown, bearer?: string | null) => post('/sync/pull', body, bearer);

async function seedUser(externalId = SUBJECT, extra: Record<string, unknown> = {}) {
  await fake().db.insert(users).values({
    externalId, email: `${externalId}@test.com`, username: `reader-${externalId}`, ...extra,
  } as any).returning();
  const issued = await signToken({ id: externalId, email: `${externalId}@test.com`, role: 'reader' });
  if (externalId === SUBJECT) token = issued;
  // Seeding is a write: clear the mock so expectNoWrites() only ever observes
  // writes attempted by the request under test.
  fake().db.insert.mockClear();
  fake().db.update.mockClear();
  return issued;
}

function expectNoWrites() {
  expect(fake().db.insert).not.toHaveBeenCalled();
  expect(fake().db.update).not.toHaveBeenCalled();
}

beforeEach(async () => {
  holder.fake = identityDb();
  vi.stubGlobal('__WORKER_ENV__', undefined);
  setWorkerEnv(productionBindings);
  const { syncRouter } = await import('./sync.js');
  const { profileRouter } = await import('./profile.js');
  app = new Hono().route('/sync', syncRouter).route('/users', profileRouter);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('reading sync version routing', () => {
  it('keeps v1 payloads (with or without syncVersion 1) on the legacy channel', async () => {
    await seedUser();
    for (const body of [
      { user: { externalId: SUBJECT }, sessions: [] },
      { syncVersion: 1, user: { externalId: SUBJECT }, sessions: [] },
    ]) {
      const res = await push(body);
      expect(res.status).toBe(200);
      const payload: any = await res.json();
      // Legacy response is unchanged: no plan, no stats projection.
      expect(payload).toMatchObject({ success: true, applied: { library: 0, history: 0, sessions: 0 } });
      expect(payload).not.toHaveProperty('plan');
      expect(payload).not.toHaveProperty('stats');
      expect(payload).not.toHaveProperty('readingStatsVersion');
    }
  });

  // A spoofed/loose version must not fall through onto the permissive legacy
  // schemas, which is the only way Pro fields could reach storage.
  it.each([['2'], [3], [2.5], [null], ['v2'], [{}]])('rejects declared syncVersion %o with 400 and no write', async (syncVersion) => {
    await seedUser();
    const res = await push({ ...freeEnvelope(), syncVersion, plan: 'pro' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'unsupported_sync_version' });
    expectNoWrites();
  });

  it('rejects an unsupported version on pull too', async () => {
    await seedUser();
    const res = await pull({ syncVersion: '2', user: { externalId: SUBJECT } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unsupported_sync_version');
  });
});

describe('Free v2 push refuses Pro entitlement before any write', () => {
  it.each(['library', 'history', 'chapterStates', 'novels'])(
    'rejects a top-level %s collection with 403 pro_fields_not_allowed',
    async (key) => {
      await seedUser();
      const res = await push({ ...freeEnvelope(), [key]: [] });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ success: false, code: 'pro_fields_not_allowed' });
      expectNoWrites();
    },
  );

  it.each([
    'words', 'minuteOfDay', 'readDay', 'genre',
    'fullWords', 'scrollY', 'content', 'cover', 'filePath',
  ])('rejects a session carrying %s with 403 pro_fields_not_allowed', async (key) => {
    await seedUser();
    const value = key === 'words' ? 900
      : key === 'minuteOfDay' ? 1380
        : key === 'readDay' ? '2026-09-25'
          : key === 'genre' ? 'Fantasy'
            : 'leak';
    const res = await push(freeEnvelope([{ ...validSession, [key]: value }]));
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body).toMatchObject({ success: false, code: 'pro_fields_not_allowed' });
    expect(JSON.stringify(body)).not.toContain('Fantasy');
    expectNoWrites();
  });

  it('reports the offending path and never echoes the smuggled value', async () => {
    await seedUser();
    const body: any = await (await push(freeEnvelope([{ ...validSession, words: 900 }]))).json();
    expect(body.issues.some((issue: any) => issue.path.join('.') === 'sessions.0.words')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('900');
  });
});

describe('Free v2 push rejects malformed core payloads with 400', () => {
  it.each([
    ['missing sessions', { ...freeEnvelope(), sessions: undefined }],
    ['sessions is not an array', freeEnvelope('nope' as unknown as unknown[])],
    ['missing novelId', freeEnvelope([{ ...validSession, novelId: undefined }])],
    ['chapterId is zero', freeEnvelope([{ ...validSession, chapterId: 0 }])],
    ['negative seconds', freeEnvelope([{ ...validSession, seconds: -1 }])],
    ['progressPercent over 100', freeEnvelope([{ ...validSession, progressPercent: 101, completed: true }])],
    ['fractional seconds', freeEnvelope([{ ...validSession, seconds: 1.5 }])],
    ['malformed clientSessionId', freeEnvelope([{ ...validSession, clientSessionId: 'has space' }])],
    ['non-finite ts', freeEnvelope([{ ...validSession, ts: Number.POSITIVE_INFINITY }])],
    ['completed contradicts progressPercent', freeEnvelope([{ ...validSession, progressPercent: 85, completed: false }])],
    ['unknown envelope key', { ...freeEnvelope(), extra: true }],
    ['unknown session key', freeEnvelope([{ ...validSession, nickname: 'x' }])],
    ['empty externalId', { ...freeEnvelope(), user: { externalId: '' } }],
  ])('%s fails as 400 without a write', async (_label, body) => {
    await seedUser();
    const res = await push(body as never);
    expect(res.status).toBe(400);
    const payload: any = await res.json();
    expect(payload).toMatchObject({ success: false, code: expect.stringMatching(/^[a-z_]+$/) });
    expect(payload.code).not.toBe('pro_fields_not_allowed');
    expect(payload.error).toBe('invalid sync payload');
    expectNoWrites();
  });

  it('caps reported issues so a 500-row bad push cannot balloon the 400', async () => {
    await seedUser();
    const body: any = await (await push(freeEnvelope(Array.from({ length: 500 }, () => ({ ...validSession, words: 1 }))))).json();
    expect(body.issues.length).toBeLessThanOrEqual(20);
  });

  it('never honors a client-supplied plan field', async () => {
    await seedUser();
    for (const plan of ['pro', 'free']) {
      expect((await push({ ...freeEnvelope(), plan })).status).toBe(400);
      expect((await push(freeEnvelope([{ ...validSession, plan }]))).status).toBe(400);
    }
    expectNoWrites();
  });

  it('treats an unparseable body as a malformed payload, not a crash', async () => {
    await seedUser();
    const res = await app.request('/sync/push', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{not json' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid push payload');
    expectNoWrites();
  });
});

describe('Free v2 channel keeps the existing token and owner rules', () => {
  it('requires a valid Bearer token in production', async () => {
    await seedUser();
    expect((await push(freeEnvelope(), null)).status).toBe(401);
    expect((await pull({ syncVersion: 2, user: { externalId: SUBJECT } }, null)).status).toBe(401);
    expectNoWrites();
  });

  it('refuses a token that does not own the declared identity', async () => {
    await seedUser();
    await seedUser('google_other_subject');
    const res = await push({ ...freeEnvelope(), user: { externalId: 'google_other_subject' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden: token identity does not match user.externalId' });
    expectNoWrites();
  });

  it('checks ownership before payload shape so a foreign caller learns nothing', async () => {
    await seedUser();
    const res = await push({ syncVersion: 2, user: { externalId: 'google_other_subject' }, library: [] });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBeUndefined();
  });

  it('fails closed when storage is unavailable or broken', async () => {
    await seedUser();
    fake().unavailable(true);
    expect((await push(freeEnvelope())).status).toBe(503);
    fake().unavailable(false);
    fake().fail(new Error('private-db-password'));
    const res = await push(freeEnvelope());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('private-db-password');
  });
});

describe('plan matrix', () => {
  it('serves the Free projection for a free-plan account', async () => {
    await seedUser(SUBJECT, { readingStatsPlan: 'free' });
    const res = await pull({ syncVersion: 2, user: { externalId: SUBJECT } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Object.keys(body).sort()).toEqual(['plan', 'stats', 'success']);
    expect(body.plan).toBe('free');
    expect(Object.keys(body.stats).sort()).toEqual([...FREE_STATS_KEYS].sort());
  });

  // The route builds its response from hand-picked fields; parsing it back
  // through the declared contract proves the wire shape cannot drift from the
  // schema a client validates against. (The push envelope needs real storage
  // and is asserted in readingStats.plan.postgres.test.ts.)
  it('emits a pull response that satisfies the published v2 Free contract', async () => {
    await seedUser(SUBJECT, { readingStatsPlan: 'free' });
    const parsed = freeReadingSyncPullResponseSchema.safeParse(
      await (await pull({ syncVersion: 2, user: { externalId: SUBJECT } })).json(),
    );
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  // Pro push/collections are a later task: fail closed instead of handing a
  // Pro account a Free projection labelled 'pro'.
  it('fails closed for a pro-plan account on every plan-aware surface', async () => {
    await seedUser(SUBJECT, { readingStatsPlan: 'pro' });
    for (const res of [
      await push(freeEnvelope()),
      await pull({ syncVersion: 2, user: { externalId: SUBJECT } }),
      await app.request('/users/me/profile?readingStatsVersion=2', { headers: { Authorization: `Bearer ${token}` } }),
    ]) {
      expect(res.status).toBe(501);
      const body: any = await res.json();
      expect(body).toMatchObject({ success: false, code: 'pro_plan_not_implemented', plan: 'pro' });
      expect(body).not.toHaveProperty('stats');
      expect(body).not.toHaveProperty('readingStats');
    }
  });

  it('degrades an absent or unknown plan column to free', async () => {
    await seedUser(SUBJECT, { readingStatsPlan: null });
    expect((await pull({ syncVersion: 2, user: { externalId: SUBJECT } })).status).toBe(200);
    await seedUser('google_odd_plan', { readingStatsPlan: 'enterprise' });
    const other = await signToken({ id: 'google_odd_plan', email: 'odd@test.com', role: 'reader' });
    const res = await pull({ syncVersion: 2, user: { externalId: 'google_odd_plan' } }, other);
    expect(res.status).toBe(200);
    expect((await res.json()).plan).toBe('free');
  });

  // The plan is resolved BEFORE the payload is parsed, so a Pro client sending
  // the payload it really sends (Pro session dimensions and Pro collections)
  // gets the documented 501 instead of the Free contract's 403/400: the Pro
  // surface is unimplemented, not merely mis-shaped, and the status must not
  // depend on how Pro-shaped the request happened to be.
  it.each([
    ['Pro session dimensions', () => push(freeEnvelope([proShapedSession()]))],
    ['a Pro library collection', () => push({ ...freeEnvelope(), library: [{ novelId: '42' }] })],
    ['a Pro novels collection', () => push({ ...freeEnvelope(), novels: [{ novelId: '42', title: 'T', genre: 'Fantasy' }] })],
    ['a malformed v2 push', () => push({ ...freeEnvelope(), sessions: 'not-an-array' })],
    ['a Pro-shaped v2 pull', () => pull({ syncVersion: 2, user: { externalId: SUBJECT }, readingStats: { year: 2026 } })],
  ])('fails closed with 501 for a pro account sending %s', async (_label, request) => {
    await seedUser(SUBJECT, { readingStatsPlan: 'pro' });
    const res = await request();
    expect(res.status).toBe(501);
    const body: any = await res.json();
    expect(body).toMatchObject({ success: false, code: 'pro_plan_not_implemented', plan: 'pro' });
    expectNoProAggregateInBody(JSON.stringify(body));
    expectNoWrites();
  });

  // The contrast that makes the gate meaningful: the same Pro-shaped payload is
  // a 403 entitlement violation for a Free account and a 501 unimplemented
  // surface for a Pro one.
  it('answers 403 for Free and 501 for Pro on the identical Pro-shaped push', async () => {
    await seedUser(SUBJECT, { readingStatsPlan: 'free' });
    expect((await push(freeEnvelope([proShapedSession()]))).status).toBe(403);
    expectNoWrites();
    await seedUser('google_pro_subject', { readingStatsPlan: 'pro' });
    const proToken = await signToken({ id: 'google_pro_subject', email: 'pro@test.com', role: 'reader' });
    const res = await push({ ...freeEnvelope(), user: { externalId: 'google_pro_subject' } }, proToken);
    expect(res.status).toBe(501);
    expect((await res.json()).code).toBe('pro_plan_not_implemented');
    expectNoWrites();
  });

  // The pre-parse plan lookup is read-only, so a rejected payload can never
  // mint an account — not even on the dev provisioning path that a valid Free
  // payload still takes.
  it('never provisions a user for a v2 payload the contract rejects', async () => {
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'test', SYNC_OPEN: 'true' });
    const stranger = 'google_unknown_subject';
    const strangerToken = await signToken({ id: stranger, email: 'unknown@test.com', role: 'reader' });
    const envelope = (sessions: unknown) => ({ syncVersion: 2, user: { externalId: stranger }, sessions });
    for (const body of [
      envelope([{ ...validSession, words: 120, readDay: '2026-09-25' }]),
      envelope([{ ...validSession, seconds: -1 }]),
      envelope('not-an-array'),
      { syncVersion: 2, user: { externalId: stranger } },
      { syncVersion: 2, user: {}, sessions: [] },
    ]) {
      const res = await push(body as never, strangerToken);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expectNoWrites();
      expect(fake().rows.some((row) => row.externalId === stranger)).toBe(false);
    }
    // The contrast: the dev provisioning path is reached only after a payload
    // has passed the contract. (The identity fake models `users` alone, so the
    // following reading_sessions write then fails closed with 503 — irrelevant
    // to what is asserted here: the users row exists.)
    await push(envelope([validSession]), strangerToken);
    expect(fake().rows.some((row) => row.externalId === stranger)).toBe(true);
  });
});

describe('v2 pull exposes the derived projection only', () => {
  it('returns exactly the Free stats allowlist', async () => {
    await seedUser();
    const body: any = await (await pull({ syncVersion: 2, user: { externalId: SUBJECT } })).json();
    expect(Object.keys(body).sort()).toEqual(['plan', 'stats', 'success']);
    expect(Object.keys(body.stats).sort()).toEqual([...FREE_STATS_KEYS].sort());
    for (const key of PRO_STATS_KEYS) expect(body).not.toHaveProperty(key);
  });

  it.each(['library', 'history', 'chapterStates', 'novels'])(
    'refuses to accept a Pro %s collection with 403',
    async (key) => {
      await seedUser();
      const res = await pull({ syncVersion: 2, user: { externalId: SUBJECT }, [key]: [] });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('pro_fields_not_allowed');
    },
  );

  // `sessions` and `readingStats` are not Pro-forbidden keys on this envelope;
  // they are simply not part of a Free pull at all.
  it.each(['sessions', 'readingStats', 'since'])('refuses a %s key on a Free pull with 400', async (key) => {
    await seedUser();
    const res = await pull({ syncVersion: 2, user: { externalId: SUBJECT }, [key]: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unknown_key');
  });
});

describe('GET /users/me/profile?readingStatsVersion=2', () => {
  it('leaves the legacy no-query payload byte-for-byte compatible', async () => {
    const legacyToken = await seedUser();
    const body: any = await (await app.request('/users/me/profile', {
      headers: { Authorization: `Bearer ${legacyToken}` },
    })).json();
    expect(body).not.toHaveProperty('readingStats');
    expect(body).not.toHaveProperty('plan');
    expect(body).not.toHaveProperty('readingStatsVersion');
    expect(Object.keys(body).sort()).toEqual(Object.keys({
      success: true, user: {}, stats: {}, level: 1, tier: 1, tierMeta: {}, isTierEntry: false,
      isMax: false, progress: 0, totalMinutes: 0, currentRequiredHours: 0, nextRequiredHours: 1,
      minutesIntoLevel: 0, minutesToNext: 60,
    }).sort());
  });

  it('adds the authoritative plan and exactly the Free readingStats keys', async () => {
    await seedUser(SUBJECT, { readingStatsPlan: 'free' });
    const res = await app.request('/users/me/profile?readingStatsVersion=2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.readingStatsVersion).toBe(2);
    expect(body.plan).toBe('free');
    expect(Object.keys(body.readingStats).sort()).toEqual([...FREE_STATS_KEYS].sort());
    expect(body.readingStats).toEqual({ level: 1, levelProgress: 0, totalSecondsRead: 0, uniqueInAppCompletedChapters: 0 });
    // Plan-scoped means plan-scoped: the identity fields plus the plan, the
    // version and the four Free stats — nothing else at the top level.
    expect(Object.keys(body).sort()).toEqual(['plan', 'readingStats', 'readingStatsVersion', 'success', 'user']);
    expect(body.success).toBe(true);
    expect(body.user).toMatchObject({ id: SUBJECT, externalId: SUBJECT, email: `${SUBJECT}@test.com` });
  });

  it('omits every Pro aggregate from the serialized body', async () => {
    await seedUser();
    const serialized = await (await app.request('/users/me/profile?readingStatsVersion=2', {
      headers: { Authorization: `Bearer ${token}` },
    })).text();
    // Whole-body, not just the nested projection: the legacy payload used to be
    // spread in, which leaked `stats` and the levelInfo keys at the top level.
    expectNoProAggregateInBody(serialized);
    for (const key of PRO_ONLY_STATS_KEYS) expect(JSON.parse(serialized).readingStats).not.toHaveProperty(key);
    const body = JSON.parse(serialized);
    expect(body).not.toHaveProperty('stats');
    expect(body).not.toHaveProperty('level');
    expect(body.user).not.toHaveProperty('readingStatsPlan');
  });

  it.each(['1', '3', 'v2', '', '2.0'])('rejects an unsupported readingStatsVersion=%o with 400', async (value) => {
    await seedUser();
    const res = await app.request(`/users/me/profile?readingStatsVersion=${encodeURIComponent(value)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported readingStatsVersion', supported: [2] });
  });

  it('still requires a token', async () => {
    await seedUser();
    expect((await app.request('/users/me/profile?readingStatsVersion=2')).status).toBe(401);
  });
});
