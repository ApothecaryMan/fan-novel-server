import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { signToken } from '../middleware/auth.js';
import { users } from '../database/schema.js';
const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_target, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
}));
let app: Hono;
let token: string;
const fake = () => holder.fake!;
async function sync(path: string, externalId = 'google_subject-1', email = 'ADMIN@test.com', bearer: string | null = token) {
  return app.request(`/sync/${path}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  }, body: JSON.stringify({ user: { externalId, email, name: 'Untrusted' } }) });
}
beforeEach(async () => {
  holder.fake = identityDb(); vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings);
  token = await signToken({ id: 'google_subject-1', email: 'reader@test.com', role: 'reader' });
  const { syncRouter } = await import('./sync.js'); app = new Hono().route('/sync', syncRouter);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('sync cannot write authentication identity', () => {
  it.each(['push', 'pull', 'stats'])('%s rejects unknown production subjects without insertion', async (path) => {
    expect((await sync(path)).status).toBe(401); expect(fake().db.insert).not.toHaveBeenCalled();
  });
  it.each(['push', 'pull', 'stats'])('%s preserves body/token matching and requires a token', async (path) => {
    expect((await sync(path, 'google_other')).status).toBe(403);
    expect((await sync(path, 'google_subject-1', 'reader@test.com', null)).status).toBe(401);
    expect(fake().db.insert).not.toHaveBeenCalled();
  });
  it.each(['push', 'pull', 'stats'])('%s leaves existing email/name/identity untouched', async (path) => {
    await fake().db.insert(users).values({ externalId: 'google_subject-1', googleSubject: 'subject-1',
      email: 'reader@test.com', username: 'Reader', displayName: 'Reader' }).returning();
    const original = { ...fake().rows[0] }; fake().db.insert.mockClear();
    for (const email of ['admin@test.com', 'ADMIN@TEST.COM', ' reader@test.com ']) {
      expect((await sync(path, 'google_subject-1', email)).status).toBe(200);
    }
    expect(fake().rows[0]).toEqual(original);
    expect(fake().db.insert).not.toHaveBeenCalled(); expect(fake().db.update).not.toHaveBeenCalled();
  });
  it.each(['push', 'pull'])('%s dev first insert has null authentication anchors', async (path) => {
    setWorkerEnv({ NODE_ENV: 'test', SYNC_OPEN: 'true' });
    expect((await sync(path, 'dev_fixture', 'ADMIN@TEST.COM', null)).status).toBe(200);
    expect(fake().rows[0]).toMatchObject({ externalId: 'dev_fixture', email: null, googleSubject: null, role: 'reader' });
  });
  it.each(['push', 'pull', 'stats'])('%s returns controlled 503 for account lookup failures', async (path) => {
    fake().fail(new Error('private-db-password'));
    const response = await sync(path); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-db-password');
  });
});
