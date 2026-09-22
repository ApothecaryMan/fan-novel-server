import { Hono } from 'hono';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { readingHistory, readingSessions, userLibrary, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';

export const profileRouter = new Hono();

export function xpForTotals(totalSeconds: number, totalWords: number): number {
  const s = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const w = Number.isFinite(totalWords) && totalWords > 0 ? Math.floor(totalWords) : 0;
  return s + w;
}

export function levelForXp(xp: number): number {
  const safe = Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0;
  return 1 + Math.floor(Math.sqrt(safe / 1000));
}

export function xpThresholdForLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return 1000 * (l - 1) * (l - 1);
}

export function rankForLevel(level: number): string {
  if (level >= 20) return 'Diamond';
  if (level >= 10) return 'Gold';
  if (level >= 5) return 'Silver';
  return 'Bronze';
}

export function streakFromReadDays(readDays: string[], today = new Date()): number {
  const set = new Set(readDays.filter(Boolean));
  let streak = 0;
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  // Allow streak to start yesterday (today not read yet).
  const key = (d: Date) => d.toISOString().slice(0, 10);
  if (!set.has(key(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (set.has(key(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

function toPublic(u: any) {
  return {
    id: u.externalId ?? u.id, externalId: u.externalId ?? u.id, email: u.email,
    name: u.displayName ?? null, username: u.username ?? null,
    avatarUrl: u.avatarUrl, bannerUrl: u.bannerUrl ?? null,
    bio: u.bio ?? null, status: u.bio ?? null,
    role: u.role ?? 'reader', isAuthor: Boolean(u.isAuthor), isTranslator: Boolean(u.isTranslator),
    provider: 'google',
  };
}

// GET /api/v1/users/me/profile — single-request account screen payload.
// Auth + counts + server-computed level/rank. Full lists stay in sync/pull.
profileRouter.get('/me/profile', requireAuth, async (c) => {
  const sub = String(c.get('authUser')?.sub ?? '');
  if (!sub) return c.json({ error: 'account not found' }, 401);
  if (!isDbAvailable()) return c.json({ error: 'account storage unavailable' }, 503);
  try {
    const [row] = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
    if (!row) return c.json({ error: 'account not found' }, 401);

    const [libRows, histRows, sessRows, dayRows] = await Promise.all([
      db.select({ total: count() }).from(userLibrary)
        .where(and(eq(userLibrary.userId, row.id), isNull(userLibrary.deletedAt))),
      db.select({ total: count() }).from(readingHistory).where(eq(readingHistory.userId, row.id)),
      db.select({
        total: count(),
        seconds: sql<number>`COALESCE(SUM(${readingSessions.seconds}), 0)`,
        words: sql<number>`COALESCE(SUM(${readingSessions.words}), 0)`,
      }).from(readingSessions).where(eq(readingSessions.userId, row.id)),
      db.select({ readDay: readingSessions.readDay }).from(readingSessions)
        .where(eq(readingSessions.userId, row.id)).limit(60),
    ]);

    const library = Number(libRows[0]?.total ?? 0);
    const history = Number(histRows[0]?.total ?? 0);
    const sessions = Number(sessRows[0]?.total ?? 0);
    const totalSeconds = Number(sessRows[0]?.seconds ?? 0);
    const totalWords = Number(sessRows[0]?.words ?? 0);
    const xp = xpForTotals(totalSeconds, totalWords);
    const level = levelForXp(xp);
    const rank = rankForLevel(level);
    const cur = xpThresholdForLevel(level);
    const next = xpThresholdForLevel(level + 1);
    const progressToNext = next > cur ? Math.min(1, Math.max(0, (xp - cur) / (next - cur))) : 1;
    const nextLevelAt = Math.max(0, next - xp);
    const streakDays = streakFromReadDays(dayRows.map((r) => r.readDay).filter(Boolean));

    return c.json({
      success: true,
      user: toPublic(row),
      stats: { library, history, sessions, totalSeconds, totalWords, streakDays },
      xp, level, rank, progressToNext, nextLevelAt,
    });
  } catch (error) {
    noteDbFailure();
    console.warn(JSON.stringify({ event: 'profile.storage', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
    return c.json({ error: 'account storage unavailable' }, 503);
  }
});
