import type { MiddlewareHandler } from 'hono';
import { getWorkerBinding } from '../config/env.js';

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

export function rateLimit(max = 60, windowMs = 60_000): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    const key = `${ip}:${c.req.path}`;

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
