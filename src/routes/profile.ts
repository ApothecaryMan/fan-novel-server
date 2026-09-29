import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { db, isDbAvailable } from '../database/db.js';
import { comments, novels, subscriptionEvents, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import { findMemoryUser } from './auth.js';
import { encodeCursor, decodeCursor, toApi, type RootsCursor, type ApiAuthor } from './comments.js';
import { effectiveReadingPlan, loadFreeStatsForUser } from '../features/readingSync/freeStore.js';
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
  readingStatsPlanExpiresAt: users.readingStatsPlanExpiresAt,
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
      const plan = effectiveReadingPlan(row, Date.now());
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
      const freeStats = await loadFreeStatsForUser(row.id);
      // Natural-expiry audit: best-effort, never fails the request, never
      // trips the breaker. Null/corrupt expiries skip (fail-closed already).
      if (row.readingStatsPlan === 'pro'
        && typeof row.readingStatsPlanExpiresAt === 'number'
        && Number.isSafeInteger(row.readingStatsPlanExpiresAt)
        && Date.now() >= row.readingStatsPlanExpiresAt) {
        try {
          await db.insert(subscriptionEvents).values({
            userId: row.id,
            type: 'expired',
            actorId: null,
            previousExpiresAt: row.readingStatsPlanExpiresAt,
            newExpiresAt: null,
            durationDays: null,
            reason: 'system: natural expiry',
            occurredAt: Date.now(),
          }).onConflictDoNothing();
        } catch {
          console.warn(JSON.stringify({ event: 'profile.plan_expired_log', outcome: 'unavailable' }));
        }
      }
      return c.json({
        success: true,
        user: toPublic(row),
        plan,
        readingStatsVersion: version.version,
        readingStats: freeProjection(freeStats),
      });
    }

    // ---- Legacy aggregates: ONE round trip, not four.
    //
    // Scalar subqueries over the resolved users row, so neon-http pays one
    // HTTPS request instead of four and node-postgres pays one pool checkout.
    // Every subquery is scoped by user_id and served by an existing leading-
    // column index (user_library_idx, history_user_read_at_id_idx,
    // sessions_user_read_day_idx), so this stays index scans, not seq scans.
    // The days subquery returns DISTINCT days newest-first (capped at 60):
    // the old `LIMIT 60` without ORDER BY read an arbitrary slice and could
    // miss the recent days the streak is computed from.
    //
    // Identifiers inside these fragments are hand-qualified ("user_library"."user_id",
    // not ${userLibrary.userId}): drizzle's sql`` renders BARE column names in the
    // select list, which here would bind to the wrong table or fail the query
    // (e.g. "user_id" = "id" compares a uuid to the integer PK). Verified
    // against the generated SQL; if a table/column is renamed, Postgres fails
    // loudly here instead of returning wrong numbers.
    const [agg] = await db.select({
      library: sql<number>`(SELECT COUNT(*) FROM "user_library" WHERE "user_library"."user_id" = "users"."id" AND "user_library"."deleted_at" IS NULL)`,
      history: sql<number>`(SELECT COUNT(*) FROM "reading_history" WHERE "reading_history"."user_id" = "users"."id")`,
      sessions: sql<number>`(SELECT COUNT(*) FROM "reading_sessions" WHERE "reading_sessions"."user_id" = "users"."id")`,
      // GREATEST mirrors the per-row clamp the canonical engine applies
      // (calculations.ts sumSeconds/sumWords both use addNonNegative): a
      // legacy v1 row with negative `seconds` or `words` contributes nothing.
      // Without the clamp the same reader could see two different totalWords —
      // here versus the Pro readingStats projection — which is exactly the
      // drift this route is not allowed to have.
      seconds: sql<number>`(SELECT COALESCE(SUM(GREATEST("reading_sessions"."seconds", 0)), 0) FROM "reading_sessions" WHERE "reading_sessions"."user_id" = "users"."id")`,
      words: sql<number>`(SELECT COALESCE(SUM(GREATEST("reading_sessions"."words", 0)), 0) FROM "reading_sessions" WHERE "reading_sessions"."user_id" = "users"."id")`,
      readDays: sql<string[]>`(SELECT COALESCE(ARRAY_AGG(t.day), '{}') FROM (SELECT DISTINCT "reading_sessions"."read_day" AS day FROM "reading_sessions" WHERE "reading_sessions"."user_id" = "users"."id" ORDER BY day DESC LIMIT 60) t)`,
    }).from(users).where(eq(users.id, row.id));

    const library = Number(agg?.library ?? 0);
    const history = Number(agg?.history ?? 0);
    const sessions = Number(agg?.sessions ?? 0);
    const totalSeconds = Number(agg?.seconds ?? 0);
    const totalWords = Number(agg?.words ?? 0);
    const levelInfo = legacyLevelInfo(getLevelFromSeconds(totalSeconds));
    // node-postgres parses text[] to string[]; neon-http returns the array as
    // well. Anything else (driver drift) degrades to "no streak", never a crash.
    const days = Array.isArray(agg?.readDays) ? agg.readDays.filter((d): d is string => typeof d === 'string' && d.length > 0) : [];
    const streakDays = streakFromReadDays(days);

    // ---- PLAN GATE (legacy aggregates) ------------------------------------
    // Derived per § Legacy v1 gating: keys stay byte-identical, Pro values are
    // zeroed for Free-derived callers. totalSeconds + level ladder stay live.
    const legacyFree = effectiveReadingPlan(row, Date.now()) !== 'pro';
    const legacyPayload = {
      success: true,
      user: toPublic(row),
      stats: {
        library,
        history,
        sessions,
        totalSeconds,
        totalWords: legacyFree ? 0 : totalWords,
        streakDays: legacyFree ? 0 : streakDays,
      },
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

/**
 * Resolve a public `:id` (users.id UUID or users.externalId) to the users row.
 * UUID-shaped input hits BOTH key spaces in one round trip; the ORDER BY keeps
 * the documented precedence (id match sorts above an externalId-only match),
 * which is why comment author chips carrying the UUID stay on the fast path.
 * A UUID-shaped externalId still resolves — it just never shadows the real row.
 *
 * Shared by /:id/profile and /:id/comments so the two public routes can never
 * disagree about who an id refers to.
 */
async function resolvePublicUser(raw: string) {
  if (UUID_RE.test(raw)) {
    const rows = await db.select(PROFILE_USER_COLUMNS).from(users)
      .where(or(eq(users.id, raw), eq(users.externalId, raw)))
      .orderBy(sql`${users.id} = ${raw} DESC`)
      .limit(1);
    return rows[0] ?? null;
  }
  const [row] = await db.select(PROFILE_USER_COLUMNS).from(users).where(eq(users.externalId, raw)).limit(1);
  return row ?? null;
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
    return c.json({ success: true, user: toPublicSafe(mem), stats: { commentsCount: 0, likesReceived: 0 }, level: 1, isPro: false });
  }
  try {
    // UUID-first: comment author chips carry the users.id UUID (dominant tap path).
    // A UUID-shaped externalId still resolves via the externalId fallthrough.
    const row = await resolvePublicUser(raw);
    if (!row) return c.json({ success: false, code: 'user_not_found', error: 'user not found' }, 404);
    // ONE round trip for both aggregates, correlated over the resolved row:
    // the comments aggregate reads visible rows only (replies included,
    // pending/hidden/deleted excluded; orphaned user_id IS NULL rows never
    // match) and the level SUM runs through the SAME canonical ladder as
    // /me/profile. Only the level number is exposed — never minutes,
    // progress, or remaining time, which stay behind the readingStats contract.
    // GREATEST mirrors the per-row clamp in freeStore: a legacy v1 row with a
    // negative `seconds` contributes time in no projection.
    // Identifiers are hand-qualified (see the note on the /me/profile
    // aggregate): drizzle renders bare column names in select-list sql``.
    const [pub] = await db.select({
      commentsCount: sql<number>`(SELECT COUNT(*) FROM "comments" WHERE "comments"."user_id" = "users"."id" AND "comments"."status" = 'visible')`,
      likesReceived: sql<number>`(SELECT COALESCE(SUM("comments"."likes_count"), 0) FROM "comments" WHERE "comments"."user_id" = "users"."id" AND "comments"."status" = 'visible')`,
      seconds: sql<number>`(SELECT COALESCE(SUM(GREATEST("reading_sessions"."seconds", 0)), 0) FROM "reading_sessions" WHERE "reading_sessions"."user_id" = "users"."id")`,
    }).from(users).where(eq(users.id, row.id));
    const commentsCount = Number(pub?.commentsCount ?? 0);
    const likesReceived = Number(pub?.likesReceived ?? 0);
    const level = getLevelFromSeconds(Number(pub?.seconds ?? 0)).level;
    // Pro seal: the effective plan off the already-resolved row (fail-closed:
    // a lapsed expiry reads free). Boolean only — no clocks leave the server.
    const isPro = effectiveReadingPlan(row, Date.now()) === 'pro';
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, user: toPublicSafe(row), stats: { commentsCount, likesReceived }, level, isPro });
  } catch (error) {
    // Read-only route: see the note on /me/profile — a failed read must not
    // trip the write-side breaker.
    console.warn(JSON.stringify({ event: 'profile.storage', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
    return c.json({ success: false, code: 'account_unavailable', error: 'account storage unavailable' }, 503);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/:id/comments — a user's own comments inside ONE novel.
//
// Backs the commenter-profile list on server novels. Served from the same
// public router as /:id/profile and deliberately scoped by `novelId` so the
// list can never contradict the reader's current context.
//
// Visibility rules are pinned to match /:id/profile exactly — visible only,
// replies included — because the hero shows that aggregate. If the two ever
// disagreed, the screen would claim a count its own list does not support.
// ---------------------------------------------------------------------------

const authorCommentsQuerySchema = z.object({
  novelId: z.string().trim().min(1).max(100),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Registered AFTER /:id/profile. Both are `/:id/...`; Hono matches on the full
// path shape, and this one carries a second segment.
profileRouter.get('/:id/comments', async (c) => {
  const raw = String(c.req.param('id') ?? '').trim();
  if (!raw) return c.json({ success: false, code: 'invalid_id', error: 'invalid user id' }, 400);

  const parsed = authorCommentsQuerySchema.safeParse({
    novelId: c.req.query('novelId'),
    cursor: c.req.query('cursor'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    return c.json({ success: false, code: 'invalid_query', error: 'استعلام غير صالح', issues: parsed.error.issues }, 400);
  }
  const { novelId, cursor: cursorRaw, limit } = parsed.data;

  let cursor: RootsCursor | undefined;
  if (cursorRaw) {
    const d = decodeCursor(cursorRaw);
    if (!d) return c.json({ success: false, code: 'invalid_cursor', error: 'مؤشر ترقيم غير صالح' }, 400);
    cursor = d;
  }

  if (!isDbAvailable()) {
    if (getEnv().isProd) {
      return c.json({ success: false, code: 'account_unavailable', error: 'account storage unavailable' }, 503);
    }
    return c.json({ success: true, total: 0, data: [], pagination: { limit, nextCursor: null, hasMore: false } });
  }

  try {
    const row = await resolvePublicUser(raw);
    if (!row) return c.json({ success: false, code: 'user_not_found', error: 'user not found' }, 404);

    // Keyset pagination on (created_at DESC, id DESC) — the same ordering the
    // `comments_user (user_id, created_at DESC, id DESC)` index provides, so
    // this stays an index scan rather than a sort as the table grows.
    const cursorCond = cursor
      ? or(
          lt(comments.createdAt, new Date(cursor.t)),
          and(eq(comments.createdAt, new Date(cursor.t)), lt(comments.id, cursor.i)),
        )
      : undefined;

    const where = and(
      eq(comments.userId, row.id),
      eq(comments.novelId, novelId),
      eq(comments.status, 'visible'),
      cursorCond,
    );

    // One extra row is the hasMore probe; no second COUNT query on page 2+.
    const rows = await db
      .select({ row: comments, novelTitle: novels.title })
      .from(comments)
      .innerJoin(novels, eq(novels.id, comments.novelId))
      .where(where)
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1]?.row;

    // One author for the whole page, so it is projected once. Fallback chain
    // mirrors buildAuthorLookup in comments.ts exactly (falsy chain, not
    // nullish): an empty-string displayName falls through to username there,
    // so it must fall through here too — ApiAuthor.name is a string, never null.
    const author: ApiAuthor = { id: String(row.id), name: row.displayName || row.username || 'مستخدم', avatarUrl: row.avatarUrl ?? undefined };

    const data = page.map(({ row: r, novelTitle }) => ({
      ...toApi(r, author, 0),
      // The host already holds the author's identity and avatar; the novel
      // title is included because the list is novel-scoped and the client
      // renders a chapter label, not a novel one.
      novelTitle,
    }));

    const nextCursor =
      hasMore && last
        ? encodeCursor({ t: new Date(last.createdAt as unknown as string).getTime(), i: last.id })
        : null;

    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({
      success: true,
      // Null on cursor pages, matching /novels/:id/comments: the badge/count
      // comes from /:id/profile, so a COUNT per page would be wasted work.
      total: cursor ? null : rows.length,
      data,
      pagination: { limit, nextCursor, hasMore },
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'profile.comments', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
    return c.json({ success: false, code: 'account_unavailable', error: 'account storage unavailable' }, 503);
  }
});
