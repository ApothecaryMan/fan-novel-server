import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { productionBindings } from './test/identityDb.js';
import { setWorkerEnv } from './config/env.js';

// The rate limiter keeps module-level state, so these cases share one window
// per (ip, path) and are ordered deliberately: the first test exhausts the sync
// budget, and the later ones only check paths the earlier ones never touched.
describe('rate limiting of the sync surface', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function app() {
    // Memory fallback: no DATABASE_URL, so the sync routes answer 503. The
    // limiter is middleware, so it still runs and is what is under test here.
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', SYNC_OPEN: 'true', DATABASE_URL: undefined });
    return createApp();
  }

  const post = (server: ReturnType<typeof createApp>, path: string) =>
    server.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { externalId: 'rl_subject' } }),
    });

  it('lets a 60-request burst through and answers the 61st with a coded 429', async () => {
    const server = app();
    for (let index = 0; index < 60; index += 1) {
      const res = await post(server, '/api/v1/sync/push');
      expect(res.status).toBe(503);
    }
    const limited = await post(server, '/api/v1/sync/push');
    expect(limited.status).toBe(429);
    // A plan-aware client branches on `code`, so the limiter answers in the same
    // shape as every other sync rejection rather than a bare `error` string.
    expect(await limited.json()).toEqual({ success: false, code: 'rate_limited', error: 'too many requests' });
  });

  it('counts each sync path separately so one chatty route cannot starve the other', async () => {
    const server = app();
    // /push is already exhausted by the test above, on the same key space.
    expect((await post(server, '/api/v1/sync/push')).status).toBe(429);
    expect((await post(server, '/api/v1/sync/pull')).status).toBe(503);
  });

  it('leaves the unlimited surfaces alone', async () => {
    const server = app();
    expect((await server.request('/health')).status).toBe(200);
    expect((await server.request('/health/live')).status).toBe(200);
    expect((await post(server, '/api/v1/auth/google')).status).toBe(400);
  });

  it('answers liveness without a database round trip', async () => {
    const server = app();
    const res = await server.request('/health/live');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body).not.toHaveProperty('db');
  });

  it('prefers the Cloudflare binding when one is bound', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    (globalThis as any).__WORKER_BINDINGS__ = { RATE_LIMITER: { limit } };
    try {
      const server = app();
      // /comments is a coded path the earlier tests never touched, so this
      // cannot disturb their shared map state.
      const res = await post(server, '/api/v1/comments');
      expect(res.status).toBe(429);
      expect(limit).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as any).__WORKER_BINDINGS__;
    }
  });

  it('falls back to the in-memory guard when the binding throws', async () => {
    const limit = vi.fn(async () => { throw new Error('limiter unavailable'); });
    (globalThis as any).__WORKER_BINDINGS__ = { RATE_LIMITER: { limit } };
    try {
      const server = app();
      // /pull has only one hit against its map budget (the second test), so the
      // fallback must let this through to the route's own 503 rather than
      // rejecting it. A limiter outage must not become an outage of the API.
      const res = await post(server, '/api/v1/sync/pull');
      expect(res.status).toBe(503);
      expect(limit).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as any).__WORKER_BINDINGS__;
    }
  });
});
