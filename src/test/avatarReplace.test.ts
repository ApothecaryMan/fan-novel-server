import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { identityDb, productionBindings } from './identityDb.js';
import { setWorkerEnv } from '../config/env.js';

const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_t, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(),
  noteDbFailure: () => holder.fake!.noteDbFailure(),
}));

let app: Hono;
const created: string[] = [];
const claims = (sub: string, email: string) => ({ sub, email, aud: 'web-client',
  iss: 'accounts.google.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 });

async function loginAs(sub: string, email: string) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(claims(sub, email))));
  return app.request('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, idToken: 'google-token' }) });
}

function avatarBody(kind = 'avatar') {
  const form = new FormData();
  form.append('file', new File(['pixels'], 'a.png', { type: 'image/png' }));
  form.append('kind', kind);
  return form;
}

function keyToLocalPath(url: string): string {
  const m = /^\/uploads\/(covers|avatars|banners)\/(.+)$/.exec(url);
  if (!m) throw new Error(`unexpected url ${url}`);
  return path.join(process.cwd(), 'uploads', m[1], m[2]);
}

beforeEach(async () => {
  holder.fake = identityDb();
  vi.stubGlobal('__WORKER_ENV__', undefined);
  setWorkerEnv(productionBindings);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { authRouter } = await import('../routes/auth.js');
  const { uploadRouter } = await import('../routes/upload.js');
  app = new Hono().use('*', requestId()).route('/auth', authRouter).route('/upload', uploadRouter);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const f of created.splice(0)) {
    await fs.unlink(f).catch(() => undefined);
  }
});

describe('avatar replacement', () => {
  it('names uploads with uuid and deletes the old avatar on replace', async () => {
    const { token }: any = await (await loginAs('replace-1', 'replace1@test.com')).json();
    const auth = { Authorization: `Bearer ${token}` };
    const useLocalDisk = () => vi.stubGlobal('__WORKER_ENV__', undefined);
    const useProdAuth = () => setWorkerEnv(productionBindings);

    useLocalDisk();
    const upRes1 = await app.request('/upload/image', { method: 'POST', body: avatarBody() });
    const up1: any = await upRes1.json();
    expect(up1.success).toBe(true);
    expect(up1.filename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
    created.push(keyToLocalPath(up1.url));

    useProdAuth();
    const p1 = await app.request('/auth/me', { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarUrl: up1.url }) });
    expect(p1.status).toBe(200);

    useLocalDisk();
    const upRes2 = await app.request('/upload/image', { method: 'POST', body: avatarBody() });
    const up2: any = await upRes2.json();
    expect(up2.success).toBe(true);
    expect(up2.filename).not.toBe(up1.filename);
    created.push(keyToLocalPath(up2.url));

    useProdAuth();
    const p2 = await app.request('/auth/me', { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarUrl: up2.url }) });
    expect(p2.status).toBe(200);

    await expect(fs.access(keyToLocalPath(up1.url))).rejects.toThrow();
    await expect(fs.access(keyToLocalPath(up2.url))).resolves.toBeUndefined();
  });
});
