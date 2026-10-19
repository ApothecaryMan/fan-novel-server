import { asc, desc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../database/db.js';
import { readingSessions, users } from '../../database/schema.js';
import { COMPLETION_THRESHOLD } from './contracts.js';
import { toPublic } from '../../domain/accountProjection.js';

export type LeaderboardPeriod = 'week' | 'month' | 'all';

export interface LeaderboardEntry {
  user: ReturnType<typeof toPublic>;
  chapters: number;
  /** Real reading seconds in the current window, clamped per row. */
  seconds: number;
  trend: number;
}

interface Window {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
}

function utcDayLabel(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function leaderboardWindow(period: LeaderboardPeriod, today = utcDayLabel()): Window {
  if (period === 'month') {
    const from = utcDayLabel(-29);
    return { from, to: today, prevFrom: utcDayLabel(-59), prevTo: utcDayLabel(-30) };
  }
  if (period === 'all') {
    // Unbounded lifetime: there is no previous baseline, so the previous
    // range mirrors the current one and the trend is always zero. It must
    // NOT be left open: legacy rows with an empty read_day label pass an
    // open filter but fail the '0000-01-01' lower bound, which would forge
    // a negative trend out of rows the current window never counted.
    return { from: '0000-01-01', to: today, prevFrom: '0000-01-01', prevTo: today };
  }
  const from = utcDayLabel(-6);
  return { from, to: today, prevFrom: utcDayLabel(-13), prevTo: utcDayLabel(-7) };
}

function dayBounds(from: string, to: string) {
  return sql`${readingSessions.readDay} >= ${from} AND ${readingSessions.readDay} <= ${to}`;
}

function completedFilter(from: string, to: string) {
  return sql`${readingSessions.completionSignalPresent} AND ${readingSessions.progressPercent} >= ${COMPLETION_THRESHOLD} AND BTRIM(${readingSessions.novelId}) <> '' AND ${readingSessions.chapterId} > 0 AND ${dayBounds(from, to)}`;
}

export async function loadLeaderboard(
  period: LeaderboardPeriod,
  limit = 10,
): Promise<LeaderboardEntry[]> {
  const bounded = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const window = leaderboardWindow(period);
  // One grouped pass with two FILTER aggregates (current + previous window).
  // Explicit AS aliases: unnamed duplicate aggregates collapse in some row
  // mappings. The outer query filters and orders on the subquery's real
  // output columns — never on a quoted alias inside HAVING, which Postgres
  // reads as a (missing) input column.
  const agg = db
    .select({
      userId: readingSessions.userId,
      chapters: sql<number>`COUNT(DISTINCT (${readingSessions.novelId}, ${readingSessions.chapterId})) FILTER (WHERE ${completedFilter(window.from, window.to)})`.as('chapters'),
      prevChapters: sql<number>`COUNT(DISTINCT (${readingSessions.novelId}, ${readingSessions.chapterId})) FILTER (WHERE ${completedFilter(window.prevFrom, window.prevTo)})`.as('prev_chapters'),
      seconds: sql<number>`COALESCE(SUM(GREATEST(${readingSessions.seconds}, 0)) FILTER (WHERE ${dayBounds(window.from, window.to)}), 0)`.as('seconds'),
    })
    .from(readingSessions)
    .groupBy(readingSessions.userId)
    .as('agg');
  const rows = await db
    .select({ user: users, chapters: agg.chapters, prevChapters: agg.prevChapters, seconds: agg.seconds })
    .from(agg)
    .innerJoin(users, eq(users.id, agg.userId))
    .where(gt(agg.chapters, 0))
    .orderBy(desc(agg.chapters), asc(agg.userId))
    .limit(bounded);
  return rows.map((row) => {
    const current = Number(row.chapters ?? 0);
    const previous = Number(row.prevChapters ?? 0);
    return {
      user: toPublic(row.user, { includeEmail: false }),
      chapters: current,
      seconds: Number(row.seconds ?? 0),
      trend: current - previous,
    };
  });
}
