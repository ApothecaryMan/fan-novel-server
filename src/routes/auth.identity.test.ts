import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { signToken } from '../middleware/auth.js';

const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_target, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
}));
let app: Hono;
let claims: Record<string, unknown>;
const fake = () => holder.fake!;
async function login(body: Record<string, unknown> = {}) {
  return app.request('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reader@test.com', idToken: 'private-google-token', name: 'Reader', ...body }) });
}
async function me(token: string, method = 'GET', body?: Record<string, unknown>) {
  return app.request('/auth/me', { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
}
beforeEach(async () => {
  holder.fake = identityDb();
  vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings);
  claims = { sub: 'subject-1', email: 'reader@test.com', aud: 'web-client', iss: 'accounts.google.com',
    email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(claims)));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { authRouter } = await import('./auth.js');
  app = new Hono().use('*', requestId()).route('/auth', authRouter);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('verified identity and failure semantics', () => {
  it('creates a canonical reader and returns a usable session with the old wire shape', async () => {
    const response = await login({ googleId: 'ignored-client-id' });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body).toMatchObject({ success: true, user: { id: 'google_subject-1', externalId: 'google_subject-1',
      email: 'reader@test.com', role: 'reader', provider: 'google' }, token: expect.any(String) });
    expect(fake().rows[0]).toMatchObject({ googleSubject: 'subject-1', externalId: 'google_subject-1', email: 'reader@test.com' });
    expect((await me(body.token)).status).toBe(200);
  });
  it('ignores different client IDs and repeats without writes or duplicate events', async () => {
    await login({ googleId: 'one' }); const uuid = fake().rows[0].id;
    await login({ googleId: 'two' });
    expect(fake().rows).toHaveLength(1); expect(fake().rows[0].id).toBe(uuid);
    expect(fake().db.insert).toHaveBeenCalledTimes(1); expect(fake().db.update).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledTimes(1);
    const event = JSON.parse(vi.mocked(console.info).mock.calls[0][0]);
    expect(event).toEqual({ event: 'account.provisioned', requestId: expect.any(String), accountId: uuid, outcome: 'created' });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/reader@test|private-google-token|signing-key/);
  });
  it('bootstraps only the verified email and rejects body mismatch', async () => {
    expect((await login({ email: 'admin@test.com' })).status).toBe(400);
    expect(fake().rows).toHaveLength(0);
    claims.email = 'ADMIN@test.com';
    expect((await login({ email: 'admin@test.com' })).status).toBe(200);
    expect(fake().rows[0].role).toBe('admin');
  });
  it('updates email and bootstrap only on a sub-matched verified login', async () => {
    await login(); const uuid = fake().rows[0].id;
    claims.email = 'admin@test.com'; await login({ email: 'ADMIN@test.com' });
    expect(fake().rows[0]).toMatchObject({ id: uuid, email: 'admin@test.com', role: 'admin' });
  });
  it('strips protected PATCH fields while allowing display edits', async () => {
    const { token }: any = await (await login()).json();
    const response = await me(token, 'PATCH', { name: 'New Name', email: 'admin@test.com',
      externalId: 'google_other', googleSubject: 'other', role: 'admin' });
    expect(response.status).toBe(200);
    expect(fake().rows[0]).toMatchObject({ displayName: 'New Name', email: 'reader@test.com',
      externalId: 'google_subject-1', googleSubject: 'subject-1', role: 'reader' });
  });
  it('does not link by email or repair a canonical-ID disagreement', async () => {
    await login(); const original = { ...fake().rows[0] };
    claims.sub = 'other';
    expect((await login()).status).toBe(409); expect(fake().rows[0]).toEqual(original);
    claims.sub = 'subject-1'; fake().rows[0].externalId = 'google_wrong';
    expect((await login()).status).toBe(409); expect(fake().db.update).not.toHaveBeenCalled();
  });
  it('rejects an external-ID collision without assigning a subject', async () => {
    await login(); fake().rows[0].googleSubject = null;
    expect((await login()).status).toBe(409); expect(fake().rows[0].googleSubject).toBeNull();
  });
  it('email-update collisions do not partially promote or mutate', async () => {
    await login(); claims.sub = 'subject-2'; claims.email = 'admin@test.com';
    await login({ email: 'admin@test.com', name: 'Admin' });
    const original = { ...fake().rows[0] }; claims.sub = 'subject-1';
    expect((await login({ email: 'admin@test.com' })).status).toBe(409);
    expect(fake().rows[0]).toEqual(original);
  });
  it('rereads an identical concurrent insert winner without mutation', async () => {
    // Force the first SELECT to see no row; the insert sees the committed winner.
    await login(); const winner = fake().rows[0];
    fake().db.select.mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) as any);
    expect((await login()).status).toBe(200);
    expect(fake().rows).toEqual([winner]); expect(fake().db.update).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledTimes(1);
  });
  it.each(['unavailable', 'query-error'])('all account routes fail 503 on %s without tokens', async (mode) => {
    const { token }: any = await (await login()).json();
    if (mode === 'unavailable') fake().unavailable(true); else fake().fail(new Error('private-db-password'));
    for (const response of [await login(), await me(token), await me(token, 'PATCH', { name: 'Changed' })]) {
      expect(response.status).toBe(503);
      const text = await response.text(); expect(text).not.toMatch(/token|private-db-password|reader@test/);
    }
    expect(fake().rows[0].displayName).toBe('Reader');
  });
  it('does not consult populated memory after switching to production', async () => {
    setWorkerEnv({ NODE_ENV: 'test', ADMIN_EMAILS: 'reader@test.com' }); fake().unavailable(true);
    const dev: any = await (await login({ idToken: undefined, googleId: 'ignored' })).json();
    expect(dev.user.externalId).toBe('dev_reader@test.com');
    setWorkerEnv(productionBindings);
    const token = await signToken({ id: dev.user.externalId, email: 'reader@test.com', role: 'admin' });
    for (const response of [await login(), await me(token), await me(token, 'PATCH', { name: 'Changed' })]) {
      expect(response.status).toBe(503); expect(await response.text()).not.toContain('token');
    }
  });
  it('missing subjects return 401, not a memory or anonymous account', async () => {
    const token = await signToken({ id: 'google_missing', email: 'reader@test.com', role: 'reader' });
    expect((await me(token)).status).toBe(401);
    expect((await me(token, 'PATCH', { name: 'Changed' })).status).toBe(401);
    expect(fake().db.insert).not.toHaveBeenCalled();
  });
  it('absent-token development fixtures never touch a configured database', async () => {
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'test' });
    const response = await login({ idToken: undefined }); expect(response.status).toBe(200);
    expect(fake().db.select).not.toHaveBeenCalled(); expect(fake().db.insert).not.toHaveBeenCalled();
  });
  it('rejects invalid supplied tokens in development without memory fallback', async () => {
    setWorkerEnv({ NODE_ENV: 'test', GOOGLE_WEB_CLIENT_ID: 'web-client' }); fake().unavailable(true);
    claims.email_verified = false;
    expect((await login()).status).toBe(401);
    expect((await login({ idToken: '' })).status).toBe(401);
  });
  it('requires production tokens', async () => { expect((await login({ idToken: undefined })).status).toBe(401); });
});
