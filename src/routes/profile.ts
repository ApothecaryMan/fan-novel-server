import { Hono } from 'hono';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { db, isDbAvailable } from '../database/db.js';
import { comments, readingHistory, readingSessions, userLibrary, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import { findMemoryUser } from './auth.js';
import { authoritativePlan, loadFreeStatsForUser } from '../features/readingSync/freeStore.js';
import { freeProjection } from '../features/readingSync/freeProtocol.js';
import { proProjection } from '../features/readingSync/contracts.js';
import { loadProStats } from '../features/readingSync/proStore.js';
import { getLevelFromSeconds, type LevelInfo as CanonicalLevelInfo } from '../features/readingSync/calculations.js';

export const profileRouter = new Hono();

// The level ladder is NOT defined here. features/readingSync/calculations.ts
// owns the canonical five-tier/50-level table (same table, same tier names after
// the T3/T4 swap) and this route only projects its result into the legacy
// response shape, so a second copy of the table here could only ever drift.
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

/** The legacy /me/profile level payload, derived from the canonical engine. */
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

/**
 * Adapt the canonical level state onto the legacy response keys. Input is
 * active minutes in the calculation module (floor(totalSeconds / 60)) and the
 * legacy payload reports the thresholds in hours, so every value here is a
 * rename — never a second formula.
 */
export function legacyLevelInfo(level: CanonicalLevelInfo): LevelInfo {
  const currentRequiredMinutes = level.currentRequiredMinutes;
  return {
    level: level.level,
    tier: level.tier,
    tierMeta: TIER_META[level.tier - 1],
    isTierEntry: level.isTierEntry,
    isMax: level.isMax,
    progress: level.progress,
    totalMinutes: level.totalMinutes,
    currentRequiredHours: currentRequiredMinutes / 60,
    nextRequiredHours: level.nextRequiredMinutes === null ? null : level.nextRequiredMinutes / 60,
    minutesIntoLevel: level.totalMinutes - currentRequiredMinutes,
    minutesToNext: level.nextRequiredMinutes === null
      ? 0
      : Math.max(0, level.nextRequiredMinutes - level.totalMinutes),
  };
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

/**
 * Every column a profile payload can name, and nothing else. Both profile
 * routes read through this list so a `users` row can never drag an auth anchor
 * (password hash, google subject) or a write-side field into a request that
 * does not project it.
 */
const PROFILE_USER_COLUMNS = {
  id: users.id,
  externalId: users.externalId,
  email: users.email,
  displayName: users.displayName,
  username: users.username,
  avatarUrl: users.avatarUrl,
  bannerUrl: users.bannerUrl,
  bio: users.bio,
  role: users.role,
  isAuthor: users.isAuthor,
  isTranslator: users.isTranslator,
  createdAt: users.createdAt,
  // Plan gate for the versioned body; never projected to a client.
  readingStatsPlan: users.readingStatsPlan,
} as const;

// Opt-in query for the plan-scoped reading statistics projection. Absent keeps
// the legacy payload byte-for-byte identical; an unrecognised value is an
// explicit 400 so a Pro client is never quietly downgraded to Free stats.
export const READING_STATS_VERSION_PARAM = 'readingStatsVersion';
const SUPPORTED_READING_STATS_VERSION = '2';

type ReadingStatsVersionRequest =
  | { requested: false; version: null }
  | { requested: true; version: number | null };

function requestedReadingStatsVersion(c: {
  req: { query: (key: string) => string | undefined };
}): ReadingStatsVersionRequest {
  const raw = c.req.query(READING_STATS_VERSION_PARAM);
  if (raw === undefined) return { requested: false, version: null };
  if (raw === SUPPORTED_READING_STATS_VERSION) {
    return { requested: true, version: Number(SUPPORTED_READING_STATS_VERSION) };
  }
  return { requested: true, version: null };
}

// GET /api/v1/users/me/profile — single-request account screen payload.
// Level uses the exact app table (active minutes); full lists stay in sync/pull.
// The cache header is set BEFORE requireAuth so even the unauthenticated 401 is
// marked uncacheable: the body carries the caller's own email, and the public
// sibling route below keeps its own `public` header on the same path prefix.
profileRouter.get('/me/profile', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
}, requireAuth, async (c) => {
  const sub = String(c.get('authUser')?.sub ?? '');
  if (!sub) return c.json({ error: 'account not found' }, 401);
  if (!isDbAvailable()) return c.json({ error: 'account storage unavailable' }, 503);
  const version = requestedReadingStatsVersion(c);
  if (version.requested && version.version === null) {
    return c.json({ error: 'unsupported readingStatsVersion', supported: [2] }, 400);
  }
  try {
    const [row] = await db.select(PROFILE_USER_COLUMNS).from(users).where(eq(users.externalId, sub)).limit(1);
    if (!row) return c.json({ error: 'account not found' }, 401);

    // ---- Plan-scoped branch, resolved BEFORE the legacy aggregates.
    //
    // The v2 body is assembled from an allowlist and therefore never reuses the
    // legacy payload: `stats` (words/streaks) and the levelInfo spread (tier,
    // progress, minutesToNext) are Pro dimensions, and spreading them here
    // would hand a Free client exactly the aggregates the v2 contracts reserve
    // for Pro. Not running the aggregate queries at all is also cheaper than
    // building the payload and dropping keys afterwards.
    if (version.requested) {
      const plan = authoritativePlan(row);
      if (plan === 'pro') {
        const yearRaw = Number(c.req.query('readingStatsYear'));
        const asOfDay = c.req.query('readingStatsAsOf');
        return c.json({
          success: true,
          user: toPublic(row),
          plan,
          readingStatsVersion: version.version,
          readingStats: proProjection(await loadProStats(row.id, {
            year: Number.isSafeInteger(yearRaw) && yearRaw >= 1 && yearRaw <= 9999 ? yearRaw : undefined,
            asOfDay: asOfDay ?? undefined,
          })),
        });
      }
      return c.json({
        success: true,
        user: toPublic(row),
        plan,
        readingStatsVersion: version.version,
        readingStats: freeProjection(await loadFreeStatsForUser(row.id)),
      });
    }

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
    const levelInfo = legacyLevelInfo(getLevelFromSeconds(totalSeconds));
    const streakDays = streakFromReadDays(dayRows.map((r) => r.readDay).filter(Boolean));

    // ---- PLAN GATE (legacy aggregates — not implemented yet) ---------------
    // `totalWords` and `streakDays` (with `streakDays` needing the per-row
    // `readDay` read above) are Pro reading dimensions, and this legacy payload
    // is plan-blind: it serves them to a Free account exactly as it always has.
    // When Pro push lands, these aggregates must be plan-gated on the
    // authoritative `users.reading_stats_plan` — a Free account has no words,
    // streaks or WPM to report, and the two day/session aggregate reads should
    // not run for it at all. The versioned body above is the plan-scoped
    // reference implementation; do not let this branch drift from it silently.
    const legacyPayload = {
      success: true,
      user: toPublic(row),
      stats: { library, history, sessions, totalSeconds, totalWords, streakDays },
      ...levelInfo,
    };
    return c.json(legacyPayload);
  } catch (error) {
    // Read-only route: it never writes, so a failed lookup must NOT trip the
    // global storage breaker and take every write surface offline with it.
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
      [row] = await db.select(PROFILE_USER_COLUMNS).from(users).where(eq(users.id, raw)).limit(1);
    }
    if (!row) {
      [row] = await db.select(PROFILE_USER_COLUMNS).from(users).where(eq(users.externalId, raw)).limit(1);
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
    // Read-only route: see the note on /me/profile — a failed read must not
    // trip the write-side breaker.
    console.warn(JSON.stringify({ event: 'profile.storage', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
    return c.json({ success: false, code: 'account_unavailable', error: 'account storage unavailable' }, 503);
  }
});
