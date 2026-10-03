/**
 * Edge cache for ANONYMOUS comment reads (Cloudflare Workers only).
 *
 * Why: measured on production, the Postgres queries behind these endpoints run
 * in 0.05–0.9 ms, but the full request takes 470–1500 ms because Neon scales to
 * zero and every request pays a cold start. Almost all of the latency is the
 * wake-up, not the query, so serving repeated public reads from the edge removes
 * both the latency and the Neon request.
 *
 * Safety rules, all enforced from the REQUEST (never from route internals):
 *   - GET only; never a write.
 *   - No `Authorization` header. Signed-in responses embed `myVote` and personal
 *     state, and a signed-in reader must never be served another reader's copy.
 *     This alone keeps the route's `private, max-age=30` branch unreachable here.
 *   - No `status` query param. That is the moderator view and can include
 *     `hidden`/`pending` comments; those must never reach anonymous readers
 *     (the route marks those `no-store`).
 *   - Production only. In dev/LAN (`SYNC_OPEN=true`) everything is `local-dev`
 *     and the cache has no business being involved.
 *   - The comments watermark endpoint is deliberately NOT cached. It is the
 *     change-detection token the live-refresh poll depends on; a 60 s cached
 *     watermark would systematically delay every update it exists to deliver.
 *     The chapters watermark IS cacheable (see below): chapters are polled
 *     hourly, so 60 s staleness is invisible, and it collapses the thundering
 *     herd to one Neon query per minute per novel.
 */
import type { MiddlewareHandler } from 'hono';
import { getEnv, isWorkersRuntime } from '../config/env.js';

const CACHE_TTL_SECONDS = 60;

/**
 * Cloudflare exposes the zone cache through the GLOBAL `caches` object
 * (`caches.default`). It is NOT an `env` binding — `env` only carries bindings
 * such as the R2 bucket — so it must be read off globalThis, not c.env.
 * The standard `Cache` type has no `default`, hence the local type.
 */
type EdgeCache = Cache & { default: Cache };

function edgeCaches(): EdgeCache | null {
  // The DOM lib types globalThis.caches as CacheStorage (no `default`), so read
  // it structurally rather than fighting the global declaration.
  const c = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  return c?.default ? ({ default: c.default } as EdgeCache) : null;
}

/** Public, anonymous-safe reads. Anything else falls through untouched. */
function isCacheablePath(pathname: string): boolean {
  if (/^\/api\/v1\/novels\/[^/]+\/comments(?:\/[^/]+\/replies)?$/.test(pathname)) return true;
  return /^\/api\/v1\/novels\/[^/]+\/chapters\/watermark$/.test(pathname);
}

export function edgeCacheComments(): MiddlewareHandler {
  return async (c, next) => {
    // Node/local dev has no caches.default; and we never want a CDN in front of
    // a LAN-mode server.
    if (!isWorkersRuntime()) return next();
    if (getEnv().syncOpen) return next();
    if (c.req.method !== 'GET') return next();

    // Anonymity is decided here, from the request alone, before any auth work.
    if (c.req.header('Authorization')) return next();

    const url = new URL(c.req.url);
    // Moderator status view: never cache, never serve from cache.
    if (url.searchParams.has('status')) return next();
    if (!isCacheablePath(url.pathname)) return next();

    const cache = edgeCaches();
    if (!cache) return next();

    const cacheUrl = new URL(url.toString());
    // Normalise so logically identical requests share one entry.
    cacheUrl.hash = '';
    const key = new Request(cacheUrl.toString(), { method: 'GET' });

    const hit = await cache.default.match(key);
    if (hit) {
      // Make the edge hit observable: this is how you confirm the cache works.
      const headers = new Headers(hit.headers);
      headers.set('X-Comments-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    }

    await next();
    const res = c.res;
    if (res.status !== 200) return;
    // Only store responses the route itself marked publicly cacheable. A
    // `no-store` or `private` response (moderator/authenticated) is left alone.
    const cc = (res.headers.get('Cache-Control') ?? '').toLowerCase();
    if (!cc.includes('public') || cc.includes('no-store')) return;
    if (res.headers.has('Vary') && (res.headers.get('Vary') ?? '').toLowerCase().includes('authorization')) return;

    // Clone BEFORE reading: the body stream can only be consumed once, and the
    // client still needs the original response body.
    const forCache = res.clone();
    const cacheHeaders = new Headers(res.headers);
    cacheHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
    const stored = new Response(forCache.body, {
      status: res.status,
      statusText: res.statusText,
      headers: cacheHeaders,
    });
    res.headers.set('X-Comments-Cache', 'MISS');
    // Awaited deliberately: a MISS costs far more than this write anyway (the
    // cold start we are avoiding is ~500ms), and awaiting keeps the store
    // consistent for the next request instead of racing it.
    await cache.default.put(key, stored);
  };
}
