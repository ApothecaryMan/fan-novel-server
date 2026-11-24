import type { MiddlewareHandler } from 'hono';
import { getWorkerBinding } from '../config/env.js';
import { verifySubject } from './auth.js';

/** Cloudflare's Workers rate-limiting binding, when one is configured. */
interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

const hits = new Map<string, { count: number; reset: number }>();

/** Paths whose 429 body carries the v2 sync failure shape ({success, code, error})
 *  so a plan-aware client can branch on `code` like it does for every other
 *  sync rejection. Everything else keeps the original `{ error }` body. */
const codedPaths = ['/comments', '/api/v1/sync/'];

function limitedBody(c: { req: { path: string } }) {
  const coded = codedPaths.some((fragment) => c.req.path.includes(fragment));
  return coded
    ? { success: false as const, code: 'rate_limited' as const, error: 'too many requests' }
    : { error: 'too many requests' };
}

/** Drop expired entries so a long-lived isolate cannot grow this without bound. */
function prune(now: number): void {
  if (hits.size < 1024) return;
  for (const [key, entry] of hits) {
    if (now > entry.reset) hits.delete(key);
  }
}

/**
 * Best-effort caller address for the limiter key.
 *
 * `cf-connecting-ip` is written by Cloudflare and cannot be spoofed by the
 * client, so it wins. Behind another proxy the LAST `x-forwarded-for` hop is
 * the one our edge appended; the first hop is whatever the caller claimed and
 * was trivially spoofable for a fresh key (and therefore a fresh budget).
 */
function clientAddress(c: { req: { header: (name: string) => string | undefined } }): string {
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return 'local';
}

export function rateLimit(max = 60, windowMs = 60_000, keyFn?: (c: any) => string): MiddlewareHandler {
  return async (c, next) => {
    const ip = clientAddress(c);
    // Sync routes do their own auth and never populate `authUser`, so their
    // keys used to collapse to the caller-supplied IP alone. Verify the Bearer
    // token here (the same helper authedSubject uses) and key a signed-in
    // caller by its verified subject. Verification is one JWT decode, already
    // spent on this request; an invalid/absent token falls back to IP.
    let sub = (c.get as any)?.('authUser')?.sub;
    if (typeof sub !== 'string' && c.req.path.startsWith('/api/v1/sync')) {
      const verified = await verifySubject(c.req.header('Authorization'));
      if (verified) sub = verified;
    }
    const base = typeof keyFn === 'function' ? keyFn(c) : (typeof sub === 'string' && sub ? `user:${sub}` : `ip:${ip}`);
    const key = `${base}:${c.req.path}`;

    // Cloudflare's binding counts across every isolate, which the map below
    // cannot. It is preferred when bound; the map stays as the fallback for
    // local development and for a deployment with no limiter configured.
    const binding = getWorkerBinding<RateLimitBinding>('RATE_LIMITER');
    if (binding) {
      try {
        const { success } = await binding.limit({ key });
        if (!success) return c.json(limitedBody(c), 429);
        await next();
        return;
      } catch {
        // A limiter outage must not reject traffic; fall through to the map.
      }
    }

    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now > cur.reset) {
      prune(now);
      hits.set(key, { count: 1, reset: now + windowMs });
      await next();
      return;
    }
    cur.count += 1;
    if (cur.count > max) {
      return c.json(limitedBody(c), 429);
    }
    await next();
  };
}
