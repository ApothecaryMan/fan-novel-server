import type { MiddlewareHandler } from 'hono';

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

export function rateLimit(max = 60, windowMs = 60_000): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now > cur.reset) {
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
