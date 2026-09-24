import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { imageResizeRouter } from './imageResize.js';
import { setWorkerEnv } from '../config/env.js';

import { Hono } from 'hono';

// The endpoint fetches a client-supplied URL. These tests are the security
// boundary: anything that lets a caller reach a host we did not approve, or
// relay a non-image body, is a vulnerability.
//
// Mounted at the same prefix app.ts uses (/api/v1/image) so these exercise the
// real path.
function makeApp() {
  return new Hono().route('/api/v1/image', imageResizeRouter);
}

function img(bytes = new Uint8Array([0xff, 0xd8, 0xff]), type = 'image/jpeg') {
  return new Response(bytes, { status: 200, headers: { 'content-type': type } });
}

const ALLOWED = 'https://truthnovel.top/wp-content/uploads/2026/09/a.jpg';

let app: Hono;
const get = (q: string) => app.request(`/api/v1/image/resize?${q}`);

beforeEach(() => {
  vi.stubGlobal('__WORKER_ENV__', undefined);
  setWorkerEnv({ NODE_ENV: 'test', SYNC_OPEN: 'true' });
  app = makeApp();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('image resize: happy path', () => {
  it('proxies an allowed host image and marks it publicly cacheable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => img()));
    const res = await get(`url=${encodeURIComponent(ALLOWED)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('public');
    expect(res.headers.get('cache-control')).toContain('immutable');
    // Must not be sniffable into script by a browser.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('accepts a subdomain of an allowed host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => img()));
    const res = await get(`url=${encodeURIComponent('https://img.truthnovel.top/x.jpg')}`);
    expect(res.status).toBe(200);
  });

  // Cloudflare does not cache Worker responses merely because they carry
  // Cache-Control, so the Cache API must be used explicitly or every view
  // re-downloads a multi-MB original from the source site.
  describe('edge caching', () => {
    function fakeCache() {
      const store = new Map<string, { body: ArrayBuffer; headers: Headers }>();
      return {
        default: {
          async match(r: Request) {
            const e = store.get(r.url);
            return e ? new Response(e.body, { status: 200, headers: e.headers }) : undefined;
          },
          async put(r: Request, res: Response) {
            store.set(r.url, { body: await res.arrayBuffer(), headers: new Headers(res.headers) });
          },
        } as unknown as Cache,
      };
    }

    afterEach(() => { delete (globalThis as unknown as { caches?: unknown }).caches; });

    it('serves the second identical request from the edge', async () => {
      (globalThis as unknown as { caches?: unknown }).caches = fakeCache();
      const origin = vi.fn(async () => img());
      vi.stubGlobal('fetch', origin);
      const q = `url=${encodeURIComponent(ALLOWED)}&w=1080`;

      const first = await get(q);
      expect(first.headers.get('X-Image-Cache')).toBe('MISS');
      const second = await get(q);
      expect(second.headers.get('X-Image-Cache')).toBe('HIT');
      // The whole point: the origin was hit exactly once.
      expect(origin).toHaveBeenCalledTimes(1);
    });

    it('still serves the image when the edge cache is unavailable', async () => {
      (globalThis as unknown as { caches?: unknown }).caches = {
        default: {
          match: async () => { throw new Error('cache down'); },
          put: async () => { throw new Error('cache down'); },
        } as unknown as Cache,
      };
      vi.stubGlobal('fetch', vi.fn(async () => img()));
      // Must not 500 just because the cache is broken.
      const res = await get(`url=${encodeURIComponent(ALLOWED)}`);
      expect(res.status).toBe(200);
    });
  });
});

// ---- SSRF boundary ----
describe('image resize: rejects hosts we did not approve', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:5432/',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'https://evil.example.com/x.jpg',
    'https://truthnovel.top.evil.com/x.jpg',   // suffix trick
    'https://nottruthnovel.top/x.jpg',          // prefix trick
    'https://xtruthnovel.top/x.jpg',
  ])('refuses %s without fetching it', async (url) => {
    const spy = vi.fn(async () => img());
    vi.stubGlobal('fetch', spy);
    const res = await get(`url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('host_not_allowed');
    // The whole point: no network call was made at all.
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses non-http schemes', async () => {
    const spy = vi.fn(async () => img());
    vi.stubGlobal('fetch', spy);
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://truthnovel.top/x.jpg']) {
      const res = await get(`url=${encodeURIComponent(url)}`);
      expect(res.status).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires a url', async () => {
    const res = await get('w=800');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('invalid_url');
  });

  it('re-validates every redirect hop', async () => {
    // Allowed host redirects to an internal address: must NOT be followed.
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const u = String(input);
      if (u.includes('truthnovel.top')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      }
      return img();
    }));
    const res = await get(`url=${encodeURIComponent(ALLOWED)}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('host_not_allowed');
  });

  it('stops redirect loops', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: ALLOWED } })));
    const res = await get(`url=${encodeURIComponent(ALLOWED)}`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).code).toBe('too_many_redirects');
  });
});

// ---- content-type safety ----
describe('image resize: will not relay non-images', () => {
  it('refuses HTML from the origin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>x</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })));
    const res = await get(`url=${encodeURIComponent(ALLOWED)}`);
    expect(res.status).toBe(415);
    expect(((await res.json()) as any).code).toBe('unsupported_type');
  });

  it('refuses SVG (script-capable) from the origin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg onload="alert(1)"/>', {
      status: 200, headers: { 'content-type': 'image/svg+xml' },
    })));
    const res = await get(`url=${encodeURIComponent(ALLOWED)}`);
    expect(res.status).toBe(415);
  });

  it('surfaces an origin error as 502, not as a passthrough', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const res = await get(`url=${encodeURIComponent(ALLOWED)}`);
    expect(res.status).toBe(502);
  });

  it('refuses a body larger than the cap even without content-length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(new Uint8Array(13 * 1024 * 1024), { status: 200, headers: { 'content-type': 'image/png' } })));
    const res = await get(`url=${encodeURIComponent(ALLOWED)}`);
    expect(res.status).toBe(413);
  });
});
