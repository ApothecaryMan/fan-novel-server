import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
import { signToken } from '../middleware/auth.js';

function app(overrides: Record<string, string> = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setWorkerEnv({
    ...productionBindings,
    NODE_ENV: 'development',
    SYNC_OPEN: 'true',
    DATABASE_URL: undefined,
    ...overrides,
  });
  return createApp();
}

function appWithBucket() {
  const BYTES = new TextEncoder().encode('PNGDATA');
  const fake = {
    get: async (key: string) => {
      if (key !== 'fan_avatar/water_frame_slow.png') return null;
      return { body: new Response(BYTES).body, httpMetadata: { contentType: 'image/png' } };
    },
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', SYNC_OPEN: 'true', DATABASE_URL: undefined });
  (globalThis as any).__WORKER_BINDINGS__ = { DECORATIONS: fake };
  return createApp();
}

describe('decorations signer', () => {
  afterEach(() => {
    delete (globalThis as any).__WORKER_BINDINGS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects unsigned file access', async () => {
    const res = await appWithBucket().request('/api/v1/decorations/file?key=fan_avatar%2Fwater_frame_slow.png&exp=1&sig=bad');
    expect([401, 403]).toContain(res.status);
  });

  it('sign requires auth and caps TTL', async () => {
    const anon = await app().request('/api/v1/decorations/sign?key=fan_avatar%2Fwater_frame_slow.png');
    expect(anon.status).toBe(401);
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', SYNC_OPEN: 'true', DATABASE_URL: undefined });
    const token = await signToken({ id: 'google_test', email: 't@test.com', role: 'reader' });
    const ok = await app().request('/api/v1/decorations/sign?key=fan_avatar%2Fwater_frame_slow.png', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    const json = await ok.json();
    expect(json.success).toBe(true);
    expect(json.expiresIn).toBeLessThanOrEqual(300);
    expect(typeof json.url).toBe('string');
  });

  it('rejects path traversal keys', async () => {
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', SYNC_OPEN: 'true', DATABASE_URL: undefined });
    const token = await signToken({ id: 'google_test', email: 't@test.com', role: 'reader' });
    const res = await app().request('/api/v1/decorations/sign?key=fan_avatar%2F..%2Fsecret.png', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('streams file with valid signature', async () => {
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', SYNC_OPEN: 'true', DATABASE_URL: undefined });
    const token = await signToken({ id: 'google_test', email: 't@test.com', role: 'reader' });
    const signRes = await appWithBucket().request('/api/v1/decorations/sign?key=fan_avatar%2Fwater_frame_slow.png', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(signRes.status).toBe(200);
    const { url } = await signRes.json();
    const fileRes = await appWithBucket().request(url);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-type')).toContain('image/png');
    expect(await fileRes.text()).toBe('PNGDATA');
  });
});
