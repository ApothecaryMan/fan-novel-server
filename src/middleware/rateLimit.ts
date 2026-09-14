import type { MiddlewareHandler } from 'hono';

const hits = new Map<string, { count: number; reset: number }>();

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
    if (cur.count > max) return c.json({ error: 'too many requests' }, 429);
    await next();
  };
}
