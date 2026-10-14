import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';

const holder = vi.hoisted(() => ({ fake: null as ReturnType<typeof identityDb> | null }));
vi.mock('../database/db.js', () => ({
  db: new Proxy({}, { get: (_t, key) => (holder.fake!.db as any)[key] }),
  isDbAvailable: () => holder.fake!.isDbAvailable(), noteDbFailure: () => holder.fake!.noteDbFailure(),
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

function uploadBody(file?: File, kind = 'cover') {
  const form = new FormData();
  if (file) form.append('file', file);
  form.append('kind', kind);
  return form;
}

beforeEach(async () => {
  holder.fake = identityDb();
  vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { authRouter } = await import('./auth.js');
  const { uploadRouter } = await import('./upload.js');
  app = new Hono().use('*', requestId()).route('/auth', authRouter).route('/upload', uploadRouter);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const f of created.splice(0)) {
    await fs.unlink(path.join(process.cwd(), 'uploads', 'covers', f)).catch(() => undefined);
  }
});

describe('POST /upload/image', () => {
  it('401 without token when SYNC_OPEN=false', async () => {
    const res = await app.request('/upload/image', { method: 'POST',
      body: uploadBody(new File(['x'], 'a.png', { type: 'image/png' })) });
    expect(res.status).toBe(401);
  });

  it('400 for non-image mime', async () => {
    const { token }: any = await (await loginAs('up-1', 'up1@test.com')).json();
    const res = await app.request('/upload/image', { method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: uploadBody(new File(['hello'], 'a.txt', { type: 'text/plain' })) });
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
  });

  it('400 when the file field is missing', async () => {
    const { token }: any = await (await loginAs('up-2', 'up2@test.com')).json();
    const res = await app.request('/upload/image', { method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, body: uploadBody(undefined) });
    expect(res.status).toBe(400);
  });

  it('413 when over UPLOAD_MAX_MB', async () => {
    const { token }: any = await (await loginAs('up-3', 'up3@test.com')).json();
    const big = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const res = await app.request('/upload/image', { method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, body: uploadBody(big) });
    expect(res.status).toBe(413);
  });

  it('200 stores the file locally on Node and returns its url', async () => {
    vi.stubGlobal('__WORKER_ENV__', undefined);
    const res = await app.request('/upload/image', { method: 'POST',
      body: uploadBody(new File(['pixels'], 'tiny.png', { type: 'image/png' })) });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    expect(json.url).toBe(`/uploads/covers/${json.filename}`);
    created.push(json.filename);
  });
});
