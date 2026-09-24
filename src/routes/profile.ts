import { Hono } from 'hono';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { comments, readingHistory, readingSessions, userLibrary, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import { findMemoryUser } from './auth.js';

export const profileRouter = new Hono();

// Mirror of Fan Novel app src/features/stats/readingLevels.ts (same table,
// same tier names after T3/T4 swap). Server never invents its own formula:
// input is active minutes = floor(totalSeconds / 60).
export const MAX_LEVEL = 50;
export const LEVELS_PER_TIER = 10;
export const TIER_STEPS_HOURS = [1, 2, 4, 8, 15] as const;

export interface TierMeta {
  tier: number;
  nameKey: `levels.tier${1 | 2 | 3 | 4 | 5}`;
  nameAr: string;
  nameEn: string;
  color: string;
  soft: string;
}

export const TIER_META: TierMeta[] = [
  { tier: 1, nameKey: 'levels.tier1', nameAr: 'مبتدئ', nameEn: 'Beginner', color: '#4CAF50', soft: '#81A684' },
  { tier: 2, nameKey: 'levels.tier2', nameAr: 'قارئ', nameEn: 'Reader', color: '#5B8DEF', soft: '#7E9CCB' },
  { tier: 3, nameKey: 'levels.tier3', nameAr: 'خبير', nameEn: 'Expert', color: '#FF7043', soft: '#CC8B6C' },
  { tier: 4, nameKey: 'levels.tier4', nameAr: 'مهووس', nameEn: 'Devourer', color: '#9B72CF', soft: '#A493C4' },
  { tier: 5, nameKey: 'levels.tier5', nameAr: 'أسطورة', nameEn: 'Legend', color: '#FFB300', soft: '#C7A24B' },
];

export interface LevelRow {
  level: number;
  tier: number;
  positionInTier: number;
  stepHours: number;
  deltaHours: number;
  deltaMinutes: number;
  cumulativeHours: number;
  cumulativeMinutes: number;
}

function buildLevelTable(): LevelRow[] {
  const rows: LevelRow[] = [];
  let cumulative = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const tier = Math.ceil(level / LEVELS_PER_TIER);
    const positionInTier = ((level - 1) % LEVELS_PER_TIER) + 1;
    const stepHours = TIER_STEPS_HOURS[tier - 1];
    const deltaHours = stepHours * positionInTier;
    cumulative += deltaHours;
    rows.push({ level, tier, positionInTier, stepHours, deltaHours,
      deltaMinutes: deltaHours * 60, cumulativeHours: cumulative, cumulativeMinutes: cumulative * 60 });
  }
  return rows;
}

export const LEVEL_TABLE: LevelRow[] = buildLevelTable();

export function minutesToReach(level: number): number {
  if (level <= 1) return 0;
  if (level > MAX_LEVEL) return LEVEL_TABLE[MAX_LEVEL - 1].cumulativeMinutes;
  return LEVEL_TABLE[level - 2].cumulativeMinutes;
}

export function tierOfLevel(level: number): number {
  const clamped = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level)));
  return Math.ceil(clamped / LEVELS_PER_TIER);
}

export function isTierEntryLevel(level: number): boolean {
  return level > 1 && level <= MAX_LEVEL && (level - 1) % LEVELS_PER_TIER === 0;
}

export interface LevelInfo {
  level: number;
  tier: number;
  tierMeta: TierMeta;
  isTierEntry: boolean;
  isMax: boolean;
  progress: number;
  totalMinutes: number;
  currentRequiredHours: number;
  nextRequiredHours: number | null;
  minutesIntoLevel: number;
  minutesToNext: number;
}

export function getLevelFromMinutes(totalActiveMinutes: number): LevelInfo {
  const total = Number.isFinite(totalActiveMinutes) ? Math.max(0, Math.floor(totalActiveMinutes)) : 0;
  let level = 1;
  for (let t = 1; t < MAX_LEVEL; t++) {
    if (total >= LEVEL_TABLE[t - 1].cumulativeMinutes) level = t + 1;
    else break;
  }
  const tier = tierOfLevel(level);
  const currentRequired = minutesToReach(level);
  const isMax = level >= MAX_LEVEL;
  const nextRequired = isMax ? null : minutesToReach(level + 1);
  const span = (nextRequired ?? LEVEL_TABLE[MAX_LEVEL - 1].cumulativeMinutes) - currentRequired;
  const progress = isMax && total >= LEVEL_TABLE[MAX_LEVEL - 1].cumulativeMinutes ? 1
    : span > 0 ? Math.min(1, Math.max(0, (total - currentRequired) / span)) : 1;
  return { level, tier, tierMeta: TIER_META[tier - 1], isTierEntry: isTierEntryLevel(level), isMax,
    progress, totalMinutes: total, currentRequiredHours: currentRequired / 60,
    nextRequiredHours: nextRequired === null ? null : nextRequired / 60,
    minutesIntoLevel: total - currentRequired,
    minutesToNext: nextRequired === null ? 0 : Math.max(0, nextRequired - total) };
}

export function getLevelFromSeconds(totalSeconds: number): LevelInfo {
  const s = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  return getLevelFromMinutes(Math.floor(s / 60));
}

export function streakFromReadDays(readDays: string[], today = new Date()): number {
  const set = new Set(readDays.filter(Boolean));
  let streak = 0;
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const key = (d: Date) => d.toISOString().slice(0, 10);
  if (!set.has(key(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (set.has(key(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function toPublic(u: any) {
  const joined = toIso(u.createdAt);
  return {
    id: u.externalId ?? u.id, externalId: u.externalId ?? u.id, email: u.email,
    name: u.displayName ?? null, username: u.username ?? null,
    avatarUrl: u.avatarUrl, bannerUrl: u.bannerUrl ?? null,
    bio: u.bio ?? null, status: u.bio ?? null,
    role: u.role ?? 'reader', isAuthor: Boolean(u.isAuthor), isTranslator: Boolean(u.isTranslator),
    provider: 'google',
    createdAt: joined, memberSince: joined,
  };
}

// GET /api/v1/users/me/profile — single-request account screen payload.
// Level uses the exact app table (active minutes); full lists stay in sync/pull.
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
    const levelInfo = getLevelFromSeconds(totalSeconds);
    const streakDays = streakFromReadDays(dayRows.map((r) => r.readDay).filter(Boolean));

    return c.json({
      success: true,
      user: toPublic(row),
      stats: { library, history, sessions, totalSeconds, totalWords, streakDays },
      ...levelInfo,
    });
  } catch (error) {
    noteDbFailure();
    console.warn(JSON.stringify({ event: 'profile.storage', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
    return c.json({ error: 'account storage unavailable' }, 503);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public projection: identical to toPublic() except the `email` key is ABSENT
// (destructured away, never null) so publicly cacheable bodies cannot leak PII.
function toPublicSafe(u: any) {
  const { email: _email, ...rest } = toPublic(u);
  return rest;
}

// GET /api/v1/users/:id/profile — public author card for comment avatar taps.
// No auth. :id accepts users.id (UUID) or users.externalId (google_<sub>, dev_<email>).
// Registered AFTER /me/profile so Hono never routes the literal `me` here.
profileRouter.get('/:id/profile', async (c) => {
  const raw = String(c.req.param('id') ?? '').trim();
  if (!raw) return c.json({ success: false, code: 'invalid_id', error: 'invalid user id' }, 400);
  // Memory fallback (no DB): non-prod resolves dev fixtures with zeroed stats;
  // production without storage fails closed.
  if (!isDbAvailable()) {
    if (getEnv().isProd) {
      return c.json({ success: false, code: 'account_unavailable', error: 'account storage unavailable' }, 503);
    }
    const mem = findMemoryUser(raw);
    if (!mem) return c.json({ success: false, code: 'user_not_found', error: 'user not found' }, 404);
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, user: toPublicSafe(mem), stats: { commentsCount: 0, likesReceived: 0 } });
  }
  try {
    let row: any = null;
    // UUID-first: comment author chips carry the users.id UUID (dominant tap path).
    // A UUID-shaped externalId still resolves via the externalId fallthrough below.
    if (UUID_RE.test(raw)) {
      [row] = await db.select().from(users).where(eq(users.id, raw)).limit(1);
    }
    if (!row) {
      [row] = await db.select().from(users).where(eq(users.externalId, raw)).limit(1);
    }
    if (!row) return c.json({ success: false, code: 'user_not_found', error: 'user not found' }, 404);
    // Single aggregate over the RESOLVED uuid; visible rows only (replies included,
    // pending/hidden/deleted excluded; orphaned user_id IS NULL rows never match).
    const [statsRow] = await db.select({
      commentsCount: count(),
      likesReceived: sql<number>`COALESCE(SUM(${comments.likesCount}), 0)`,
    }).from(comments).where(and(eq(comments.userId, row.id), eq(comments.status, 'visible')));
    const commentsCount = Number(statsRow?.commentsCount ?? 0);
    const likesReceived = Number(statsRow?.likesReceived ?? 0);
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, user: toPublicSafe(row), stats: { commentsCount, likesReceived } });
  } catch (error) {
    noteDbFailure();
    console.warn(JSON.stringify({ event: 'profile.storage', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
    return c.json({ success: false, code: 'account_unavailable', error: 'account storage unavailable' }, 503);
  }
});
