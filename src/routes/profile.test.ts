import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { TIER_META, getLevelFromMinutes, getLevelFromSeconds, isTierEntryLevel, minutesToReach, streakFromReadDays, tierOfLevel } from './profile.js';

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
  });
});
