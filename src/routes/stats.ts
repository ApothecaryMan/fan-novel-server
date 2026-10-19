import { Hono } from 'hono';
import { z } from 'zod';
import { isDbAvailable } from '../database/db.js';
import { loadLeaderboard } from '../features/readingSync/leaderboardStore.js';

export const statsRouter = new Hono();

const querySchema = z.object({
  period: z.enum(['week', 'month', 'all']).default('week'),
  limit: z.coerce.number().int().default(10),
});

// GET /api/v1/stats/leaderboard?period=week|month|all&limit=10
// Public global readers board. No auth guard (like GET /users/:id/profile):
// every field served is already public via toPublic. Cached for a minute.
statsRouter.get('/leaderboard', async (c) => {
  const parsed = querySchema.safeParse({ period: c.req.query('period') ?? undefined, limit: c.req.query('limit') ?? undefined });
  if (!parsed.success) return c.json({ success: false, error: 'period must be week | month | all, limit an integer' }, 400);
  const limit = Math.min(50, Math.max(1, parsed.data.limit));
  const period = parsed.data.period;
  if (!isDbAvailable()) {
    return c.json({ success: true, data: [], period, limit });
  }
  const data = await loadLeaderboard(period, limit);
  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
  return c.json({ success: true, data, period, limit });
});
