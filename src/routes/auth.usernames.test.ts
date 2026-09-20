import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { signToken } from '../middleware/auth.js';

const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_t, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
}));
let app: Hono;
const fake = () => holder.fake!;
const claimsFor = (sub: string, email: string) => ({ sub, email, aud: 'web-client',
  iss: 'accounts.google.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 });

async function loginAs(sub: string, email: string, body: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(claimsFor(sub, email))));
  return app.request('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, idToken: 'google-token', ...body }) });
}
const me = (token: string, method = 'GET', body?: Record<string, unknown>) =>
  app.request('/auth/me', { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
const avail = (token: string | null, username: string) => app.request(
  `/auth/username/availability?username=${encodeURIComponent(username)}`,
  { headers: token ? { Authorization: `Bearer ${token}` } : {} });

beforeEach(async () => {
  holder.fake = identityDb();
  vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { authRouter } = await import('./auth.js');
  app = new Hono().use('*', requestId()).route('/auth', authRouter);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('username ownership routes', () => {
  it('creation without username yields null username and display name from Google data', async () => {
    const res = await loginAs('new-1', 'newone@test.com', { name: 'New One' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.user.username).toBeNull();
    expect(body.user.name).toBe('New One');
    expect(fake().rows[0]).toMatchObject({ username: null, displayName: 'New One' });
  });
  it('creation without name falls back to the email prefix for display only', async () => {
    const body: any = await (await loginAs('new-2', 'prefixuser@test.com')).json();
    expect(body.user.username).toBeNull();
    expect(body.user.name).toBe('prefixuser');
  });
  it('creation with an explicit valid username persists it verbatim', async () => {
    const body: any = await (await loginAs('new-3', 'picked@test.com', { name: 'Picked', username: 'picked_one' })).json();
    expect(body.user.username).toBe('picked_one');
    expect(fake().rows[0].username).toBe('picked_one');
  });
  it('creation with an invalid username returns 400 and creates nothing', async () => {
    expect((await loginAs('new-4', 'bad@test.com', { username: 'bad-name!' })).status).toBe(400);
    expect(fake().rows).toHaveLength(0);
  });
  it('creation with a taken username returns 409 username_taken with suggestions and creates no row', async () => {
    await loginAs('holder-1', 'holder@test.com', { username: 'taken_name' });
    const res = await loginAs('new-5', 'newfive@test.com', { username: 'taken_name' });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe('username_taken');
    expect(body.suggestions).toEqual(['taken_name_1', 'taken_name_2', 'taken_name_3']);
    expect(fake().rows).toHaveLength(1);
  });
  it('availability matrix: free, taken, malformed, unauthenticated', async () => {
    await loginAs('holder-2', 'holder2@test.com', { username: 'held_one' });
    const { token }: any = await (await loginAs('checker-1', 'checker@test.com')).json();
    expect(await (await avail(token, 'fresh_one')).json()).toEqual({ available: true, suggestions: [] });
    const taken: any = await (await avail(token, 'held_one')).json();
    expect(taken.available).toBe(false);
    expect(taken.suggestions).toEqual(['held_one_1', 'held_one_2', 'held_one_3']);
    expect((await avail(token, 'bad-name!')).status).toBe(400);
    expect((await avail(null, 'fresh_one')).status).toBe(401);
  });
  it('PATCH success sets username atomically and returns it', async () => {
    const { token }: any = await (await loginAs('patch-1', 'patch@test.com')).json();
    const res = await me(token, 'PATCH', { username: 'my_handle', name: 'My Name' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user).toMatchObject({ username: 'my_handle', name: 'My Name' });
    expect(fake().rows[0]).toMatchObject({ username: 'my_handle', displayName: 'My Name' });
  });
  it('PATCH clash returns 409 with suggestions and writes nothing', async () => {
    await loginAs('holder-3', 'holder3@test.com', { username: 'claimed' });
    const { token }: any = await (await loginAs('patch-2', 'patch2@test.com')).json();
    const res = await me(token, 'PATCH', { username: 'claimed', name: 'Hacked Name' });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe('username_taken');
    expect(body.suggestions).toEqual(['claimed_1', 'claimed_2', 'claimed_3']);
    expect(fake().rows.find((r) => r.email === 'patch2@test.com')).toMatchObject({ username: null, displayName: 'patch2' });
  });
  it('PATCH race backstop maps a lost unique race to username_taken, not identity conflict', async () => {
    await loginAs('holder-4', 'holder4@test.com', { username: 'race_handle' });
    const { token }: any = await (await loginAs('patch-3', 'patch3@test.com')).json();
    const selectMock = fake().db.select as any;
    const realSelect = selectMock.getMockImplementation().bind(fake().db);
    let selectCalls = 0;
    selectMock.mockImplementation((...args: unknown[]) => {
      selectCalls += 1;
      if (selectCalls === 2) {
        return { from: (_t: unknown) => ({ where: (_c: unknown) => ({ limit: async () => [] }) }) };
      }
      return realSelect(...args);
    });
    const res = await me(token, 'PATCH', { username: 'race_handle' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('username_taken');
  });
  it('toPublic null contract holds on google, get me, and patch me', async () => {
    const created: any = await (await loginAs('null-1', 'nullone@test.com')).json();
    expect(created.user.username).toBeNull();
    expect(((await (await me(created.token)).json()) as any).user.username).toBeNull();
    const patched: any = await (await me(created.token, 'PATCH', { name: 'Still No Handle' })).json();
    expect(patched.user.username).toBeNull();
    expect(patched.user.name).toBe('Still No Handle');
  });
  it('grandfathered mixed-case rows survive login and non-username patches byte-identical', async () => {
    fake().rows.push({ id: crypto.randomUUID(), externalId: 'google_grand-1', googleSubject: 'grand-1',
      email: 'grand@test.com', username: 'Legacy_Name', displayName: 'Legacy', passwordHash: null,
      avatarUrl: null, bannerUrl: null, role: 'reader', isAuthor: false, isTranslator: false,
      createdAt: new Date(), updatedAt: new Date() } as any);
    const body: any = await (await loginAs('grand-1', 'grand@test.com')).json();
    expect(body.user.username).toBe('Legacy_Name');
    const { token }: any = body;
    await me(token, 'PATCH', { name: 'Legacy Renamed' });
    expect(fake().rows[0].username).toBe('Legacy_Name');
  });
  it('ADMIN_EMAILS bootstrap still applies on a username-less creation', async () => {
    const body: any = await (await loginAs('admin-1', 'admin@test.com')).json();
    expect(body.user).toMatchObject({ role: 'admin', username: null });
  });
});
