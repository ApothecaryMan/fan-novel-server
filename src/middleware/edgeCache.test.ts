import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { edgeCacheComments } from './edgeCache.js';
import { setWorkerEnv } from '../config/env.js';

interface StoredEntry { key: string; headers: Headers }

/** Minimal in-memory stand-in for caches.default. */
function fakeCache() {
  const store = new Map<string, { body: string; status: number; headers: Headers }>();
  const puts: StoredEntry[] = [];
  return {
    puts,
    get size() { return store.size; },
    default: {
      async match(req: Request) {
        const hit = store.get(req.url);
        return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
      },
      async put(req: Request, res: Response) {
        const headers = new Headers(res.headers);
        const body = await res.text();
        store.set(req.url, { body, status: res.status, headers });
        puts.push({ key: req.url, headers });
      },
    } as unknown as Cache,
  };
}

const PROD = {
  NODE_ENV: 'production',
  SYNC_OPEN: 'false',
  DATABASE_URL: 'postgresql://local:local@localhost/fixture',
  JWT_SECRET: 'fixture-production-signing-key-32-bytes-minimum',
  GOOGLE_WEB_CLIENT_ID: 'web-client',
};

function build(cache: ReturnType<typeof fakeCache>, body = '{"ok":true}', cacheControl = 'public, max-age=60') {
  const app = new Hono();
  app.use('*', edgeCacheComments());
  app.get('*', (c) => c.json(JSON.parse(body), 200, { 'Cache-Control': cacheControl }));
  app.post('*', (c) => c.json({ ok: true }, 201));
  return app;
}

let cache: ReturnType<typeof fakeCache>;
let app: ReturnType<typeof build>;

beforeEach(() => {
  vi.stubGlobal('__WORKER_ENV__', undefined);
  setWorkerEnv(PROD);
  cache = fakeCache();
  app = build(cache);
});
afterEach(() => {
  delete (globalThis as unknown as { caches?: unknown }).caches;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const LIST = '/api/v1/novels/n1/comments?chapter=70';
const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {} as Record<string, unknown>,
};
// The Workers runtime exposes `caches` as a GLOBAL, not as an env binding, so
// the fake must be installed on globalThis. Mocking it on `env` would pass
// while production silently bypasses the cache entirely.
const get = (p: string, init?: RequestInit) => {
  (globalThis as unknown as { caches?: unknown }).caches = cache.default ? cache : undefined;
  return app.fetch(new Request(`https://x.dev${p}`, init), {}, executionCtx);
};
const authed = (p: string) => get(p, { headers: { Authorization: 'Bearer secret' } });

describe('edgeCacheComments: runtime contract', () => {
  // Regression: the first implementation read `c.env.caches`. In Workers,
  // `caches` is a global, so that was always undefined and the cache silently
  // never engaged in production — while the old test still passed, because it
  // had mocked `caches` on env and therefore encoded the same mistake.
  it('reads the cache from the GLOBAL caches, not from env', async () => {
    const res = await get(LIST);
    expect(res.headers.get('X-Comments-Cache')).toBe('MISS');
    expect(cache.size).toBe(1);
  });

  it('falls through cleanly when the runtime provides no global caches', async () => {
    delete (globalThis as unknown as { caches?: unknown }).caches;
    const res = await app.request(LIST);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Comments-Cache')).toBeNull();
  });
});

describe('edgeCacheComments: caching the public anonymous read', () => {
  it('serves a second identical read from the edge without re-running the route', async () => {
    const first = await get(LIST);
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Comments-Cache')).toBe('MISS');
    expect(cache.size).toBe(1);

    const second = await get(LIST);
    const firstBody = await first.text();
    const secondBody = await second.text();
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Comments-Cache')).toBe('HIT');
    expect(secondBody).toBe(firstBody);
  });

  it('keys on the full path + query, so different chapters never share an entry', async () => {
    await get('/api/v1/novels/n1/comments?chapter=70');
    await get('/api/v1/novels/n1/comments?chapter=71');
    await get('/api/v1/novels/n2/comments?chapter=70');
    expect(cache.size).toBe(3);
    expect(new Set(cache.puts.map((p) => p.key)).size).toBe(3);
  });
});

// These are the privacy rules. Each one, if broken, leaks data between users.
describe('edgeCacheComments: never serves or stores personalised data', () => {
  it('bypasses the cache entirely when Authorization is present', async () => {
    const res = await authed(LIST);
    expect(res.headers.get('X-Comments-Cache')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('never stores an authenticated response, even if a route marked it public', async () => {
    // Defence in depth: a route bug that labels a signed-in response `public`
    // must still not poison the shared cache.
    const app2 = build(cache, '{"ok":true}', 'public, max-age=60');
    await app2.fetch(new Request(`https://x.dev${LIST}`, { headers: { Authorization: 'Bearer s' } }), {}, executionCtx);
    expect(cache.size).toBe(0);
  });

  it('never stores or serves a moderator status view', async () => {
    const a = await get('/api/v1/novels/n1/comments?status=hidden');
    const b = await get('/api/v1/novels/n1/comments?status=hidden');
    expect(a.headers.get('X-Comments-Cache')).toBeNull();
    expect(b.headers.get('X-Comments-Cache')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('refuses to store a response the route marked private or no-store', async () => {
    await build(cache, '{"ok":true}', 'private, max-age=30').fetch(new Request(`https://x.dev${LIST}`), {}, executionCtx);
    expect(cache.size).toBe(0);
    await build(cache, '{"ok":true}', 'no-store').fetch(new Request(`https://x.dev${LIST}`), {}, executionCtx);
    expect(cache.size).toBe(0);
  });

  it('refuses to store a response that Varies on Authorization', async () => {
    const app3 = new Hono();
    app3.use('*', edgeCacheComments());
    app3.get('*', (c) => {
      c.header('Cache-Control', 'public, max-age=60');
      c.header('Vary', 'Authorization');
      return c.json({ ok: true });
    });
    await app3.fetch(new Request(`https://x.dev${LIST}`), {}, executionCtx);
    expect(cache.size).toBe(0);
  });
});

describe('edgeCacheComments: scope and safety limits', () => {
  it('never caches writes', async () => {
    const res = await get(LIST, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Comments-Cache')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('never caches the watermark, which the live-refresh poll depends on', async () => {
    const wm = '/api/v1/novels/n1/comments/watermark?chapter=70';
    const a = await get(wm);
    const b = await get(wm);
    expect(a.headers.get('X-Comments-Cache')).toBeNull();
    expect(b.headers.get('X-Comments-Cache')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('ignores paths outside the public comment reads', async () => {
    for (const p of [
      '/api/v1/novels/n1',
      '/api/v1/novels',
      '/api/v1/admin/users',
      '/api/v1/comments/1/vote',
      '/api/v1/auth/me',
      '/health',
    ]) {
      const res = await get(p);
      expect(res.headers.get('X-Comments-Cache'), p).toBeNull();
    }
    expect(cache.size).toBe(0);
  });

  it('caches the replies read too', async () => {
    const p = '/api/v1/novels/n1/comments/42/replies';
    await get(p);
    const second = await get(p);
    expect(second.headers.get('X-Comments-Cache')).toBe('HIT');
  });

  it('does not cache non-200 responses', async () => {
    const app4 = new Hono();
    app4.use('*', edgeCacheComments());
    app4.get('*', (c) => c.json({ error: 'x' }, 404, { 'Cache-Control': 'public, max-age=60' }));
    const res = await app4.fetch(new Request(`https://x.dev${LIST}`), {}, executionCtx);
    expect(res.status).toBe(404);
    expect(cache.size).toBe(0);
  });

  it('self-disables in LAN/open mode', async () => {
    setWorkerEnv({ ...PROD, SYNC_OPEN: 'true' });
    await get(LIST);
    expect(cache.size).toBe(0);
  });

  it('is a no-op when the runtime has no caches.default (Node)', async () => {
    setWorkerEnv({ ...PROD });
    vi.stubGlobal('__WORKER_ENV__', undefined);
    const nodeApp = new Hono();
    nodeApp.use('*', edgeCacheComments());
    nodeApp.get('*', (c) => c.json({ ok: true }));
    // No env.caches at all (Node runtime).
    const res = await nodeApp.request(`https://x.dev${LIST}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Comments-Cache')).toBeNull();
  });
});
