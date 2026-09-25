import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { getEnv, setWorkerEnv } from '../config/env.js';
import { users } from '../database/schema.js';
import { TIER_META, streakFromReadDays } from './profile.js';
// The level ladder is asserted where it is defined: the canonical calculation
// module. profile.ts only projects it, so a copy of the table there would be a
// second thing to keep in sync — and a mirror test here would test that copy.
import {
  getLevelFromMinutes,
  getLevelFromSeconds,
  isTierEntryLevel,
  minutesToReach,
  tierOfLevel,
} from '../features/readingSync/calculations.js';

const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_t, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
}));

let app: Hono;
const fake = () => holder.fake!;
const claims = (sub: string, email: string) => ({ sub, email, aud: 'web-client',
  iss: 'accounts.google.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 });

async function loginAs(sub: string, email: string) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(claims(sub, email))));
  return app.request('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, idToken: 'google-token' }) });
}

beforeEach(async () => {
  holder.fake = identityDb();
  vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { authRouter } = await import('./auth.js');
  const { profileRouter } = await import('./profile.js');
  app = new Hono().use('*', requestId()).route('/auth', authRouter).route('/users', profileRouter);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('app level engine mirror', () => {
  it('tier names follow the swapped spec', () => {
    expect(TIER_META.map((m) => m.nameAr)).toEqual(['مبتدئ', 'قارئ', 'خبير', 'مهووس', 'أسطورة']);
    expect(TIER_META.map((m) => m.nameEn)).toEqual(['Beginner', 'Reader', 'Expert', 'Devourer', 'Legend']);
  });
  it('level 1 at 0, level 2 at 60min, level 11 at 55h', () => {
    expect(getLevelFromMinutes(0).level).toBe(1);
    expect(getLevelFromMinutes(59).level).toBe(1);
    expect(getLevelFromMinutes(60).level).toBe(2);
    expect(minutesToReach(11)).toBe(55 * 60);
  });
  it('seconds map through floor minutes', () => {
    expect(getLevelFromSeconds(0).level).toBe(1);
    expect(getLevelFromSeconds(3599).level).toBe(1);
    expect(getLevelFromSeconds(3600).level).toBe(2);
  });
  it('tier entries are 11/21/31/41 only', () => {
    for (const l of [11, 21, 31, 41]) expect(isTierEntryLevel(l)).toBe(true);
    expect(isTierEntryLevel(10)).toBe(false);
    expect(tierOfLevel(25)).toBe(3);
  });
  it('streak counts consecutive days ending today/yesterday', () => {
    const today = new Date('2026-09-22T12:00:00Z');
    expect(streakFromReadDays(['2026-09-22', '2026-09-21', '2026-09-20'], today)).toBe(3);
    expect(streakFromReadDays(['2026-09-21', '2026-09-20'], today)).toBe(2);
    expect(streakFromReadDays(['2026-09-20'], today)).toBe(0);
  });
});

describe('GET /users/me/profile', () => {
  it('fresh account returns level 1 tier 1 in one payload', async () => {
    const { token }: any = await (await loginAs('lvl-1', 'lvl@test.com')).json();
    const res = await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ success: true, level: 1, tier: 1, isMax: false,
      tierMeta: { nameKey: 'levels.tier1', nameAr: 'مبتدئ' },
      stats: { library: 0, history: 0, sessions: 0, totalSeconds: 0, streakDays: 0 },
      user: { email: 'lvl@test.com', bio: null, status: null } });
    expect(body.minutesToNext).toBe(60);
  });
  it('401 without token, 503 on storage failure without leaking', async () => {
    expect((await app.request('/users/me/profile')).status).toBe(401);
    const { token }: any = await (await loginAs('lvl-2', 'lvl2@test.com')).json();
    fake().fail(new Error('private-db-password'));
    const res = await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/private-db-password|lvl2@test/);
    // Read-only route: see the note on the public sibling — no breaker trip.
    expect(fake().noteDbFailure).not.toHaveBeenCalled();
  });

  // The body is the caller's own account, email included, so no shared cache may
  // keep it. The public route below deliberately keeps its `public` header.
  it('marks the authenticated profile private, no-store on every outcome', async () => {
    const { token }: any = await (await loginAs('cache-1', 'cache@test.com')).json();
    const ok = await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store');

    const unauthenticated = await app.request('/users/me/profile');
    expect(unauthenticated.headers.get('Cache-Control')).toBe('private, no-store');
    const versioned = await app.request('/users/me/profile?readingStatsVersion=2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(versioned.headers.get('Cache-Control')).toBe('private, no-store');
  });

  // The legacy levelInfo keys are a projection of the canonical engine, so the
  // payload is checked against that engine rather than against a second ladder.
  it('projects the canonical level ladder onto the legacy keys', async () => {
    const { token }: any = await (await loginAs('lvl-3', 'lvl3@test.com')).json();
    const body: any = await (await app.request('/users/me/profile', {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    // No stored sessions in this fake, so the engine is evaluated at zero.
    const canonical = getLevelFromSeconds(0);
    expect(body).toMatchObject({
      level: canonical.level,
      tier: canonical.tier,
      isTierEntry: canonical.isTierEntry,
      isMax: canonical.isMax,
      progress: canonical.progress,
      totalMinutes: canonical.totalMinutes,
      currentRequiredHours: canonical.currentRequiredMinutes / 60,
      nextRequiredHours: canonical.nextRequiredMinutes === null ? null : canonical.nextRequiredMinutes / 60,
      tierMeta: { nameKey: `levels.tier${canonical.tier}` },
    });
  });
});
describe('GET /users/:id/profile (public)', () => {
  const A1_UUID = '11111111-1111-4111-8111-111111111111';
  const A1_EXTERNAL = 'google_sub1';
  const A1_EMAIL = 'author1@test.com';
  const B_UUID = '22222222-2222-4222-8222-222222222222';

  async function seedAuthorA() {
    await fake().db.insert(users).values({ id: A1_UUID, externalId: A1_EXTERNAL,
      email: A1_EMAIL, displayName: 'Author One', username: 'authorone',
      avatarUrl: 'https://cdn.test/a1.png', bannerUrl: null, bio: 'hello bio',
      role: 'reader', isAuthor: true, isTranslator: false }).returning();
  }

  it('resolves the same author by UUID and by externalId with identical identity', async () => {
    await seedAuthorA();
    fake().seedComments([{ userId: A1_UUID, status: 'visible', likesCount: 1 }]);
    const byUuid = await app.request(`/users/${A1_UUID}/profile`);
    const byExt = await app.request(`/users/${A1_EXTERNAL}/profile`);
    expect(byUuid.status).toBe(200);
    expect(byExt.status).toBe(200);
    const a: any = await byUuid.json();
    const b: any = await byExt.json();
    expect(a).toMatchObject({ success: true, stats: { commentsCount: 1, likesReceived: 1 } });
    expect(b.user).toEqual(a.user);
    expect(a.user).toMatchObject({ id: A1_EXTERNAL, externalId: A1_EXTERNAL,
      name: 'Author One', username: 'authorone', role: 'reader',
      isAuthor: true, isTranslator: false, provider: 'google', status: 'hello bio', bio: 'hello bio' });
  });

  it('counts visible only (pending/hidden/deleted excluded, replies included)', async () => {
    await seedAuthorA();
    fake().seedComments([
      { userId: A1_UUID, status: 'visible', likesCount: 0 },
      { userId: A1_UUID, status: 'visible', likesCount: 0 },
      { userId: A1_UUID, status: 'pending', likesCount: 0 },
      { userId: A1_UUID, status: 'hidden', likesCount: 0 },
      { userId: A1_UUID, status: 'deleted', likesCount: 0 },
    ]);
    const res = await app.request(`/users/${A1_UUID}/profile`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.stats.commentsCount).toBe(2);
  });

  it('sums likes over visible rows only and zeroes COALESCE for authors with none visible', async () => {
    await seedAuthorA();
    await fake().db.insert(users).values({ id: B_UUID, externalId: 'google_subB',
      email: 'b@test.com', displayName: 'B', role: 'reader' }).returning();
    fake().seedComments([
      { userId: A1_UUID, status: 'visible', likesCount: 3 },
      { userId: A1_UUID, status: 'visible', likesCount: 5 },
      { userId: A1_UUID, status: 'hidden', likesCount: 100 },
      { userId: B_UUID, status: 'hidden', likesCount: 7 },
    ]);
    const a: any = await (await app.request(`/users/${A1_UUID}/profile`)).json();
    expect(a.stats).toEqual({ commentsCount: 2, likesReceived: 8 });
    const b: any = await (await app.request(`/users/${B_UUID}/profile`)).json();
    expect(b.stats).toEqual({ commentsCount: 0, likesReceived: 0 });
  });

  it('never exposes email (key absent, address absent from serialized body)', async () => {
    await seedAuthorA();
    fake().seedComments([]);
    const res = await app.request(`/users/${A1_EXTERNAL}/profile`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.user).not.toHaveProperty('email');
    expect(JSON.stringify(body)).not.toContain(A1_EMAIL);
    expect(Object.keys(body.user).sort()).toEqual(['avatarUrl', 'bannerUrl', 'bio',
      'createdAt', 'externalId', 'id', 'isAuthor', 'isTranslator', 'memberSince', 'name', 'provider', 'role', 'status', 'username']);
  });

  it('exposes join date as ISO createdAt + memberSince on public and private profiles', async () => {
    await seedAuthorA();
    fake().seedComments([]);
    const pub: any = await (await app.request(`/users/${A1_UUID}/profile`)).json();
    expect(pub.user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pub.user.memberSince).toBe(pub.user.createdAt);
    const { token }: any = await (await loginAs('join-1', 'join@test.com')).json();
    const priv: any = await (await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(priv.user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(priv.user.memberSince).toBe(priv.user.createdAt);
  });

  it('sends the exact public cache header on success; 404 for unknown ids', async () => {
    await seedAuthorA();
    fake().seedComments([]);
    const res = await app.request(`/users/${A1_UUID}/profile`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=60');
    expect(res.headers.get('Vary')).toBeNull();
    const unknownUuid = await app.request('/users/33333333-3333-4333-8333-333333333333/profile');
    expect(unknownUuid.status).toBe(404);
    expect(await unknownUuid.json()).toEqual({ success: false, code: 'user_not_found', error: 'user not found' });
    const unknownExt = await app.request('/users/google_nonexistent/profile');
    expect(unknownExt.status).toBe(404);
    expect(await unknownExt.json()).toEqual({ success: false, code: 'user_not_found', error: 'user not found' });
    expect(unknownUuid.headers.get('Cache-Control') ?? '').not.toContain('public');
  });

  it('400 invalid_id for whitespace-only id; 503 without leak on storage failure', async () => {
    const empty = await app.request('/users/%20/profile');
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ success: false, code: 'invalid_id', error: 'invalid user id' });
    await seedAuthorA();
    fake().fail(new Error('secret-driver-detail'));
    const res = await app.request(`/users/${A1_UUID}/profile`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('secret-driver-detail');
    expect(text).not.toContain(A1_EMAIL);
    expect(await JSON.parse(text)).toEqual({ success: false, code: 'account_unavailable', error: 'account storage unavailable' });
    // The breaker is for storage that is failing, not for a read that did not
    // work: this route never writes, so a failed lookup must not take the write
    // surfaces offline with it.
    expect(fake().noteDbFailure).not.toHaveBeenCalled();
  });

  it('memory fallback in non-prod returns zeros for known fixtures and 404 for unknown', async () => {
    vi.stubGlobal('__WORKER_ENV__', { ...productionBindings, NODE_ENV: 'development', DATABASE_URL: undefined });
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', DATABASE_URL: undefined } as any);
    expect(getEnv().isProd).toBe(false);
    fake().unavailable(true);
    try {
      const created = await app.request('/auth/google', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'mem@test.com', name: 'Mem Fixture' }) });
      expect(created.status).toBe(200);
      const res = await app.request('/users/dev_mem@test.com/profile');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toMatchObject({ success: true, stats: { commentsCount: 0, likesReceived: 0 } });
      expect(body.user).not.toHaveProperty('email');
      expect(body.user.externalId).toBe('dev_mem@test.com');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=60');
      const miss = await app.request('/users/dev_ghost@test.com/profile');
      expect(miss.status).toBe(404);
      expect(await miss.json()).toEqual({ success: false, code: 'user_not_found', error: 'user not found' });
    } finally {
      fake().unavailable(false);
      vi.stubGlobal('__WORKER_ENV__', undefined);
      setWorkerEnv(productionBindings);
    }
  });

  it('private /me/profile still works byte-for-byte (regression)', async () => {
    const { token }: any = await (await loginAs('regress-1', 'regress@test.com')).json();
    const res = await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.user.email).toBe('regress@test.com');
    expect(body.stats).toMatchObject({ library: 0, history: 0, sessions: 0 });
  });
});
