import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';

const holder = vi.hoisted(() => ({
  rows: [] as Array<{ user: object; chapters: number; trend: number }>,
  dbAvailable: true,
  failQuery: false,
}));

vi.mock('../features/readingSync/leaderboardStore.js', () => ({
  loadLeaderboard: vi.fn(async (period: string, limit: number) => {
    if (holder.failQuery) throw new Error('db down');
    return holder.rows.slice(0, limit).map((r) => ({ ...r, period }));
  }),
}));

vi.mock('../database/db.js', () => ({
  isDbAvailable: () => holder.dbAvailable,
  noteDbFailure: () => {},
}));

let app: Hono;
const originalDbUrl = process.env.DATABASE_URL;

beforeEach(async () => {
  holder.dbAvailable = true;
  holder.failQuery = false;
  process.env.DATABASE_URL = 'postgres://localhost:5432/lb_route_test';
  holder.rows = [
    { user: { id: 'u1', name: 'Reader A' }, chapters: 5, trend: 2 },
    { user: { id: 'u2', name: 'Reader B' }, chapters: 3, trend: -1 },
  ];
  vi.stubGlobal('__WORKER_ENV__', undefined);
  const { statsRouter } = await import('./stats.js');
  app = new Hono().use('*', requestId()).route('/api/v1/stats', statsRouter);
});

afterEach(() => {
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDbUrl;
});

describe('GET /api/v1/stats/leaderboard', () => {
  it('returns 400 for an unknown period', async () => {
    const res = await app.request('/api/v1/stats/leaderboard?period=year');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
  });

  it('returns ranked rows with cache headers', async () => {
    const res = await app.request('/api/v1/stats/leaderboard?period=week&limit=10');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('public, max-age=60');
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ success: true, period: 'week', limit: 10 });
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ chapters: 5, trend: 2 });
  });

  it('clamps an oversized limit', async () => {
    const res = await app.request('/api/v1/stats/leaderboard?period=month&limit=999');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).limit).toBe(50);
  });

  it('falls back to an empty board without a database', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      holder.dbAvailable = false;
      const res = await app.request('/api/v1/stats/leaderboard?period=all');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, data: [] });
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it('returns 503 when the database is in breaker cooldown', async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://localhost:5432/lb_test';
    try {
      holder.dbAvailable = false;
      const res = await app.request('/api/v1/stats/leaderboard?period=week');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ success: false, retryable: true });
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });

  it('returns 503 when the query itself fails', async () => {
    holder.failQuery = true;
    try {
      const res = await app.request('/api/v1/stats/leaderboard?period=week');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ success: false, retryable: true });
    } finally {
      holder.failQuery = false;
    }
  });
});
