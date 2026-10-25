import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';

function appWithBucket() {
  const BYTES = new TextEncoder().encode('THUMBDATA');
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

describe('decorations public thumb', () => {
  it('serves known keys without auth and caches publicly', async () => {
    const app = appWithBucket();
    const res = await app.request('/api/v1/decorations/thumb?key=fan_avatar%2Fwater_frame_slow.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/public/);
    expect(await res.text()).toBe('THUMBDATA');
    vi.restoreAllMocks();
    delete (globalThis as any).__WORKER_BINDINGS__;
  });

  it('400s traversal keys without hitting storage', async () => {
    const app = appWithBucket();
    const res = await app.request('/api/v1/decorations/thumb?key=fan_avatar%2F..%2Fx.png');
    expect(res.status).toBe(400);
    vi.restoreAllMocks();
    delete (globalThis as any).__WORKER_BINDINGS__;
  });
});
