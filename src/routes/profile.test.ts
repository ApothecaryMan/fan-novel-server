import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { levelForXp, rankForLevel, streakFromReadDays, xpForTotals, xpThresholdForLevel } from './profile.js';

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

describe('level math', () => {
  it('xp sums non-negative integers', () => {
    expect(xpForTotals(0, 0)).toBe(0);
    expect(xpForTotals(90, 10)).toBe(100);
    expect(xpForTotals(-5, NaN)).toBe(0);
  });
  it('level thresholds follow 1000*(L-1)^2', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(999)).toBe(1);
    expect(levelForXp(1000)).toBe(2);
    expect(xpThresholdForLevel(1)).toBe(0);
    expect(xpThresholdForLevel(2)).toBe(1000);
    expect(xpThresholdForLevel(3)).toBe(4000);
  });
  it('rank tiers map from level', () => {
    expect(rankForLevel(1)).toBe('Bronze');
    expect(rankForLevel(5)).toBe('Silver');
    expect(rankForLevel(10)).toBe('Gold');
    expect(rankForLevel(20)).toBe('Diamond');
  });
  it('streak counts consecutive days ending today/yesterday', () => {
    const today = new Date('2026-09-22T12:00:00Z');
    expect(streakFromReadDays(['2026-09-22', '2026-09-21', '2026-09-20'], today)).toBe(3);
    expect(streakFromReadDays(['2026-09-21', '2026-09-20'], today)).toBe(2);
    expect(streakFromReadDays(['2026-09-20'], today)).toBe(0);
    expect(streakFromReadDays([], today)).toBe(0);
  });
});

describe('GET /users/me/profile', () => {
  it('fresh account returns level 1 Bronze with zero stats in one payload', async () => {
    const { token }: any = await (await loginAs('lvl-1', 'lvl@test.com')).json();
    const res = await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ success: true, xp: 0, level: 1, rank: 'Bronze',
      stats: { library: 0, history: 0, sessions: 0, totalSeconds: 0, totalWords: 0, streakDays: 0 },
      user: { email: 'lvl@test.com', bio: null, status: null } });
    expect(body.progressToNext).toBeGreaterThanOrEqual(0);
    expect(body.nextLevelAt).toBe(1000);
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
