import { Hono, type Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { users, userAchievementUnlocks, userLibrary, readingSessions, subscriptionEvents } from '../database/schema.js';
import { verifySubject } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import {
  effectiveReadingPlan,
  expireLapsedProPlan,
  loadFreeStatsForUser,
  normalizeResetAt,
  READING_CLOCK_SKEW_MS,
  storeFreeSessions,
} from '../features/readingSync/freeStore.js';
import { loadProStats, pullProData, storeProPush } from '../features/readingSync/proStore.js';
import { buildProPushResponse, parseProV2Pull, parseProV2Push } from '../features/readingSync/proProtocol.js';
import type { ReadingPlan, ProReadingSyncPush, ProReadingSyncPull } from '../features/readingSync/contracts.js';
import {
  calculateFreeStatsFromTotals,
  calculateProStats,
} from '../features/readingSync/calculations.js';
import {
  freeProjection,
  proProjection,
  readingSyncDeleteNovelRequestSchema,
  readingSyncResetRequestSchema,
} from '../features/readingSync/contracts.js';
import { deleteNovelReadingData, resetUserReadingData } from '../features/readingSync/readingDelete.js';
import { parseFreeStreaksBody, parseFreeStreaksQuery, parseReadingTzBody, parseReadingTzQuery } from '../features/readingSync/readingTzQuery.js';
import {
  collapseUnlockBatch,
  parseUnlockPull,
  parseUnlockPush,
} from '../features/readingSync/unlocks.js';
import {
  accountNotFoundResponse,
  buildFreePullResponse,
  buildFreePushResponse,
  claimedExternalId,
  classifySyncRequest,
  contractFailureResponse,
  ownerMismatchResponse,
  parseFreeV2Pull,
  parseFreeV2Push,
  sessionConflictResponse,
  storageUnavailableResponse,
  syncDatabaseUnavailableResponse,
  syncFailure,
  unauthorizedResponse,
  unsupportedSyncVersionResponse,
  type SyncFailure,
} from '../features/readingSync/freeProtocol.js';

export const syncRouter = new Hono();

// ==========================================
// Delta sync for offline-first clients.
// Ordering authority = CLIENT edit-time clocks (updated_at/read_at/deleted_at,
// UTC epoch ms). received_at is audit/GC only and is never compared.
// Tombstone beats live regardless of clock; else larger updatedAt wins;
// ties union category_ids. Sessions are append-only + idempotent.
// Production: closed sync, existing authenticated accounts only.
// Explicit development/test mode may provision fixtures without auth email.
// ==========================================

// Tolerance for a reader's clock running behind the server's when its session
// ts is compared against a reset/tombstone marker. Single definition lives in
// freeStore (READING_CLOCK_SKEW_MS); this alias keeps the route-level name.
export const CLIENT_CLOCK_SKEW_MS = READING_CLOCK_SKEW_MS;

const clampTs = (ts: number, now: number): number =>
  ts > now + CLIENT_CLOCK_SKEW_MS ? now : ts;

/** The only user columns any sync path needs. Sync never reads the auth
 *  anchors (password hash, google subject) or the write-side profile fields. */
const SYNC_USER_COLUMNS = {
  id: users.id,
  externalId: users.externalId,
  readingStatsPlan: users.readingStatsPlan,
  readingStatsPlanExpiresAt: users.readingStatsPlanExpiresAt,
  statsResetAt: users.statsResetAt,
} as const;

type SyncUser = { id: string; externalId: string | null; readingStatsPlan: string | null; readingStatsPlanExpiresAt: number | null; statsResetAt: number | null };

async function provisionUser(externalId: string): Promise<SyncUser | undefined> {
  const [existing] = await db.select(SYNC_USER_COLUMNS).from(users).where(eq(users.externalId, externalId)).limit(1);
  if (existing || getEnv().isProd) return existing;
  await db.insert(users).values({
    externalId, email: null, googleSubject: null,
    username: null,
    avatarUrl: null,
  }).onConflictDoNothing({ target: users.externalId });
  return (await db.select(SYNC_USER_COLUMNS).from(users).where(eq(users.externalId, externalId)).limit(1))[0];
}

type SyncUserResolution =
  | { ok: true; user: SyncUser }
  | { ok: false; reason: 'not_found' | 'unavailable' };

/**
 * Resolve (and, in explicit dev mode, provision) the account behind a sync
 * request.
 *
 * The breaker is reserved for this path because it is the only sync storage
 * touch that can WRITE: a provisioning insert failing is a real storage
 * failure, so `noteDbFailure()` is correct here. Read-only probes (the v2 plan
 * probe, the aggregate reads) deliberately do not trip it.
 */
async function resolveSyncUser(externalId: string): Promise<SyncUserResolution> {
  try {
    const user = await provisionUser(externalId);
    return user ? { ok: true, user } : { ok: false, reason: 'not_found' };
  } catch {
    noteDbFailure();
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Account-resolution failures for the remaining non-v2 sync surfaces (unlocks,
 * stats) keep their original `{ error }` bodies.
 */
async function resolveLegacySyncUser(c: Context, externalId: string) {
  const resolved = await resolveSyncUser(externalId);
  if (resolved.ok) return resolved.user;
  return resolved.reason === 'not_found'
    ? c.json({ error: 'account not found' }, 401)
    : c.json({ error: 'account storage unavailable' }, 503);
}

/** v2 renders the same two outcomes through the typed failure helper. */
function v2UserFailure(reason: 'not_found' | 'unavailable'): SyncFailure {
  return reason === 'not_found' ? accountNotFoundResponse() : storageUnavailableResponse();
}

// ---- Reading statistics v2 (plan-aware). The plan is read from
// users.reading_stats_plan and never from the request; the Free channel is
// validated against the strict v2 contract before a single row is written.
// Pro push/collections are a later task: they fail closed with 501
// (proPlanNotImplementedResponse) instead of silently serving Free data.

function fail(c: Context, failure: SyncFailure) {
  return c.json(failure.body, failure.status);
}

/** Owner policy for the v2 channel: identical to the legacy rule, checked
 *  before parsing so a mismatched caller learns nothing about payload shape. */
function ownerMismatch(c: Context, authedSub: string | null, body: unknown) {
  const claimed = claimedExternalId(body);
  if (authedSub && claimed !== null && authedSub !== claimed) return fail(c, ownerMismatchResponse());
  return null;
}

/**
 * Read-only plan probe for the v2 channel.
 *
 * Pro push/collections are not implemented, so every plan-aware surface has to
 * answer a Pro account with the same 501 — including a push whose Pro fields
 * (`words`, `readDay`, `library`, …) would otherwise trip the strict Free
 * contract and come back as 403/400. Resolving the plan BEFORE parsing is what
 * makes that uniform.
 *
 * The probe is a single SELECT and is deliberately non-provisioning: a push
 * from an unknown identity, or a malformed payload of any kind, must never
 * create a users row. Row creation stays in resolveSyncUser() and is therefore
 * still gated on a payload that has already passed the Free contract, and the
 * authoritative plan is re-read from that row before anything is written.
 *
 * `null` means "no stored plan yet" (unknown or unclaimed identity) and lets the
 * request continue to the normal parse → resolve → plan-gate sequence.
 */
async function v2PlanProbe(body: unknown): Promise<{ plan: ReadingPlan | null } | { failure: SyncFailure }> {
  const externalId = claimedExternalId(body);
  if (externalId === null) return { plan: null };
  try {
    const [row] = await db
      .select({ readingStatsPlan: users.readingStatsPlan, readingStatsPlanExpiresAt: users.readingStatsPlanExpiresAt })
      .from(users)
      .where(eq(users.externalId, externalId))
      .limit(1);
    return { plan: row ? effectiveReadingPlan(row, Date.now()) : null };
  } catch {
    console.warn(JSON.stringify({ event: 'sync.plan_probe', outcome: 'unavailable' }));
    return { failure: storageUnavailableResponse() };
  }
}

/**
 * Best-effort natural-expiry audit trace. Fires when a request derives Free
 * from a lapsed Pro window. Never fails the request, never trips the storage
 * breaker, never calls noteDbFailure(). Null/corrupt expiries skip silently
 * (derivation already fails closed). No-target ON CONFLICT DO NOTHING keeps
 * concurrent first-observers to one row without needing a partial-index
 * arbiter in the query.
 */
async function logExpiredObservation(user: SyncUser): Promise<void> {
  if (user.readingStatsPlan !== 'pro') return;
  const prev = user.readingStatsPlanExpiresAt;
  if (typeof prev !== 'number' || !Number.isSafeInteger(prev)) return;
  if (Date.now() < prev) return;
  try {
    // Guarded transition: only the request that actually flips the stored row
    // (pro -> free, expiry cleared) writes the audit event. Concurrent
    // observers of the same lapse write nothing more, so a lapsed account no
    // longer inserts on every request.
    if (!(await expireLapsedProPlan(user.id, Date.now()))) return;
    await db.insert(subscriptionEvents).values({
      userId: user.id,
      type: 'expired',
      actorId: null,
      previousExpiresAt: prev,
      newExpiresAt: null,
      durationDays: null,
      reason: 'system: natural expiry',
      occurredAt: Date.now(),
    }).onConflictDoNothing();
  } catch {
    console.warn(JSON.stringify({ event: 'sync.plan_expired_log', outcome: 'unavailable' }));
  }
}
/**
 * Resolve the v2 account and fail closed on its two failure modes. Shared by
 * push and pull so both surfaces answer the same normalized 401/503.
 */
async function v2SyncUser(c: Context, externalId: string) {
  const resolved = await resolveSyncUser(externalId);
  if (resolved.ok) return resolved.user;
  return fail(c, v2UserFailure(resolved.reason));
}

async function pushV2(c: Context, body: unknown, authedSub: string | null) {
  const mismatch = ownerMismatch(c, authedSub, body);
  if (mismatch) return mismatch;
  const probe = await v2PlanProbe(body);
  if ('failure' in probe) return fail(c, probe.failure);

  const proPayload = probe.plan === 'pro';
  let payload;
  try {
    payload = proPayload ? parseProV2Push(body) : parseFreeV2Push(body);
  } catch (error) {
    return fail(c, contractFailureResponse(error));
  }

  const user = await v2SyncUser(c, payload.user.externalId);
  if (user instanceof Response) return user;
  const plan = effectiveReadingPlan(user, Date.now());
  if ((plan === 'pro') !== proPayload) {
    return fail(c, syncFailure(409, 'plan_changed', 'reading plan changed; refresh and retry'));
  }

  try {
    if (plan === 'pro') {
      const now = Date.now();
      const write = await storeProPush(user.id, payload as ProReadingSyncPush, now, CLIENT_CLOCK_SKEW_MS);
      if (write.conflictingSessionIds.length > 0) {
        return fail(c, sessionConflictResponse(write.conflictingSessionIds, write.acceptedSessionIds));
      }
      return c.json(buildProPushResponse({
        serverNow: now,
        applied: { sessions: write.applied, ...write.collections },
        acceptedSessionIds: write.acceptedSessionIds,
      }));
    }

    const write = await storeFreeSessions(user.id, payload.sessions);
    if (write.conflictingSessionIds.length > 0) {
      return fail(c, sessionConflictResponse(write.conflictingSessionIds, write.acceptedSessionIds));
    }
    const response = buildFreePushResponse({
      serverNow: Date.now(),
      appliedSessions: write.applied,
      acceptedSessionIds: write.acceptedSessionIds,
    });
    if (plan === 'free') await logExpiredObservation(user);
    return c.json(response);
  } catch {
    noteDbFailure();
    return fail(c, storageUnavailableResponse());
  }
}

async function pullV2(c: Context, body: unknown, authedSub: string | null) {
  const mismatch = ownerMismatch(c, authedSub, body);
  if (mismatch) return mismatch;
  const probe = await v2PlanProbe(body);
  if ('failure' in probe) return fail(c, probe.failure);

  const proPayload = probe.plan === 'pro';
  let payload;
  try {
    payload = proPayload ? parseProV2Pull(body) : parseFreeV2Pull(body);
  } catch (error) {
    return fail(c, contractFailureResponse(error));
  }

  const user = await v2SyncUser(c, payload.user.externalId);
  if (user instanceof Response) return user;
  const plan = effectiveReadingPlan(user, Date.now());
  if ((plan === 'pro') !== proPayload) {
    return fail(c, syncFailure(409, 'plan_changed', 'reading plan changed; refresh and retry'));
  }

  try {
    const queryTz = parseReadingTzQuery({
      readingStatsTz: c.req.query('readingStatsTz'),
      readingStatsTzOffset: c.req.query('readingStatsTzOffset'),
    });
    const bodyTz = parseReadingTzBody(body);
    const tz = queryTz.tz ?? bodyTz.tz;
    const tzOffsetMinutes = queryTz.tzOffsetMinutes ?? bodyTz.tzOffsetMinutes;
    // Free streak opt-in: explicit `readingStatsFreeStreaks=1` only. Without it
    // the Free aggregate stays byte-for-byte the old 4-key shape for shipped
    // clients that validate with an exact allowlist.
    const includeFreeStreaks = parseFreeStreaksQuery({
      readingStatsFreeStreaks: c.req.query('readingStatsFreeStreaks'),
    }) || parseFreeStreaksBody(body);
    if (plan === 'pro' && 'readingStats' in payload) {
      const readingStats = (payload as ProReadingSyncPull).readingStats as {
        libraryCursor: string | null;
        sessionCursor: string | null;
        year: number;
        readingStatsTz?: string;
        readingStatsTzOffset?: number;
        omitStats?: boolean;
      };
      return c.json(await pullProData(user.id, {
        ...readingStats,
        readingStatsTz: tz ?? readingStats.readingStatsTz,
        readingStatsTzOffset: tzOffsetMinutes ?? readingStats.readingStatsTzOffset,
      }));
    }
    if (plan === 'pro') return fail(c, syncFailure(400, 'invalid_sync_payload', 'pro pull requires readingStats cursors'));
    const response = buildFreePullResponse(await loadFreeStatsForUser(user.id, { tz, tzOffsetMinutes, includeStreaks: includeFreeStreaks }));
    if (plan === 'free') await logExpiredObservation(user);
    return c.json(response);
  } catch {
    console.warn(JSON.stringify({ event: 'sync.pro_read', outcome: 'unavailable' }));
    return fail(c, storageUnavailableResponse());
  }
}

/**
 * The legacy v1 channel is retired. 410 (Gone) so an old client stops
 * retrying a protocol the server will never accept again. The body is the
 * documented client-facing shape: a code plus a human-readable message.
 */
function retiredSyncResponse(c: Context) {
  return c.json({
    error: 'sync_version_unsupported',
    message: 'Update the app to keep syncing.',
  }, 410);
}

/**
 * Shared prelude for the v2 channel: read the body once, classify the declared
 * protocol, retire the legacy channel, then apply the storage/auth gates.
 *
 * The body is buffered FIRST so a v1 caller is answered 410 before any storage
 * or auth access. Only v2 (or an unsupported declared version, which the route
 * rejects next) reaches the gates.
 */
async function syncRequestPreamble(c: Context) {
  const body = await c.req.json().catch(() => null);
  const channel = classifySyncRequest(body);
  // Legacy v1 (no syncVersion, or syncVersion: 1) is retired permanently.
  if (channel === 'legacy') return retiredSyncResponse(c);
  if (!isDbAvailable()) return fail(c, syncDatabaseUnavailableResponse());
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) {
    return fail(c, unauthorizedResponse('unauthorized: valid Bearer token required'));
  }
  return { body, channel, authedSub };
}

// POST /api/v1/sync/push
syncRouter.post('/push', async (c) => {
  const preamble = await syncRequestPreamble(c);
  if (preamble instanceof Response) return preamble;
  const { body, channel, authedSub } = preamble;
  if (channel === 'v2') return pushV2(c, body, authedSub);
  return fail(c, unsupportedSyncVersionResponse());
});

// POST /api/v1/sync/pull
syncRouter.post('/pull', async (c) => {
  const preamble = await syncRequestPreamble(c);
  if (preamble instanceof Response) return preamble;
  const { body, channel, authedSub } = preamble;
  if (channel === 'v2') return pullV2(c, body, authedSub);
  return fail(c, unsupportedSyncVersionResponse());
});

// POST /api/v1/sync/reading/reset — delete ALL reading sessions + derived rows,
// clear unlocks, record stats_reset_at. Idempotent. Responds with the fresh
// plan-scoped aggregate (same shape the client parses on pull/profile) plus
// resetAt, so the client can apply it immediately.
syncRouter.post('/reading/reset', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'sync database not configured' }, 503);
  const body = await c.req.json().catch(() => null);
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) {
    return fail(c, unauthorizedResponse('unauthorized: valid Bearer token required'));
  }
  let payload;
  try {
    payload = readingSyncResetRequestSchema.parse(body);
  } catch {
    return fail(c, syncFailure(400, 'invalid_sync_payload', 'invalid sync payload'));
  }
  const externalId = payload.user.externalId;
  if (authedSub && authedSub !== externalId) return fail(c, ownerMismatchResponse());
  const user = await v2SyncUser(c, externalId);
  if (user instanceof Response) return user;
  const plan = effectiveReadingPlan(user, Date.now());
  try {
    const resetAt = await resetUserReadingData(user.id, Date.now());
    if (plan === 'pro') {
      // The table is now empty by construction, so the aggregate is the
      // zeroed projection — no point re-scanning it (Workers CPU).
      const stats = proProjection(calculateProStats({ sessions: [], novels: [] }));
      return c.json({ success: true, plan, stats, resetAt, serverNow: resetAt });
    }
    // Free streaks only on explicit opt-in (`readingStatsFreeStreaks` body
    // field); without it the stats stay the old 4-key shape.
    const includeStreaks = parseFreeStreaksBody(body);
    const stats = freeProjection(calculateFreeStatsFromTotals(
      includeStreaks
        ? { totalSeconds: 0, uniqueInAppCompletedChapters: 0, currentStreakDays: 0, longestStreakDays: 0 }
        : { totalSeconds: 0, uniqueInAppCompletedChapters: 0 },
    ));
    if (plan === 'free') await logExpiredObservation(user);
    return c.json({ success: true, plan, stats, resetAt, serverNow: resetAt });
  } catch {
    noteDbFailure();
    return fail(c, storageUnavailableResponse());
  }
});

// POST /api/v1/sync/reading/delete-novel — delete sessions + derived rows for
// one novel, record a per-user novel tombstone. Unlocks untouched (novel delete
// is partial, not deliberate forget). Idempotent. Responds with the fresh
// aggregate plus deletedAt/novelId.
syncRouter.post('/reading/delete-novel', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'sync database not configured' }, 503);
  const body = await c.req.json().catch(() => null);
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) {
    return fail(c, unauthorizedResponse('unauthorized: valid Bearer token required'));
  }
  let payload;
  try {
    payload = readingSyncDeleteNovelRequestSchema.parse(body);
  } catch {
    return fail(c, syncFailure(400, 'invalid_sync_payload', 'invalid sync payload'));
  }
  const externalId = payload.user.externalId;
  if (authedSub && authedSub !== externalId) return fail(c, ownerMismatchResponse());
  const user = await v2SyncUser(c, externalId);
  if (user instanceof Response) return user;
  const plan = effectiveReadingPlan(user, Date.now());
  try {
    const novelId = String(payload.novelId);
    const deletedAt = await deleteNovelReadingData(user.id, novelId, Date.now());
    if (plan === 'pro') {
      const stats = proProjection(await loadProStats(user.id));
      return c.json({ success: true, plan, stats, deletedAt, novelId, serverNow: deletedAt });
    }
    // Free streaks only on explicit opt-in (see reset above).
    const includeStreaks = parseFreeStreaksBody(body);
    const stats = freeProjection(await loadFreeStatsForUser(user.id, { includeStreaks }));
    if (plan === 'free') await logExpiredObservation(user);
    return c.json({ success: true, plan, stats, deletedAt, novelId, serverNow: deletedAt });
  } catch {
    noteDbFailure();
    return fail(c, storageUnavailableResponse());
  }
});

// POST /api/v1/sync/unlocks/push — idempotent unlock deltas.
// Merge is MIN(first_seen_at) / MAX(level) / MAX(catalog_version); the server
// never evaluates thresholds. Malformed rows fail as 400 (client drops the op),
// never 500 (client would retry forever). Plan-agnostic: no plan gate.
syncRouter.post('/unlocks/push', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'sync database not configured' }, 503);
  const body = await c.req.json().catch(() => null);
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) return c.json({ error: 'unauthorized: valid Bearer token required' }, 401);
  let payload;
  try {
    payload = parseUnlockPush(body);
  } catch {
    return c.json({ error: 'invalid unlocks payload' }, 400);
  }
  const externalId = payload.user.externalId;
  if (authedSub && authedSub !== externalId) {
    return c.json({ error: 'forbidden: token identity does not match user.externalId' }, 403);
  }
  const user = await resolveLegacySyncUser(c, externalId);
  if (user instanceof Response) return user;
  const now = Date.now();
  const collapsed = collapseUnlockBatch(payload.unlocks);
  // A stats reset deliberately forgets achievements too (readingDelete clears
  // user_achievement_unlocks). An outbox flush that survived the reset must not
  // resurrect them: same clock-skew tolerance as the session deletion gate.
  const resetAt = normalizeResetAt(user.statsResetAt);
  const deltas = resetAt === null
    ? collapsed
    : collapsed.filter((d) => d.firstSeenAt + READING_CLOCK_SKEW_MS >= resetAt);
  if (deltas.length > 0) {
    try {
      await db
        .insert(userAchievementUnlocks)
        .values(deltas.map((d) => ({
          userId: user.id,
          achievementId: d.achievementId,
          level: d.level,
          firstSeenAt: clampTs(d.firstSeenAt, now),
          catalogVersion: d.catalogVersion,
          updatedAt: now,
        })))
        .onConflictDoUpdate({
          target: [userAchievementUnlocks.userId, userAchievementUnlocks.achievementId],
          set: {
            level: sql`GREATEST(${userAchievementUnlocks.level}, excluded."level")`,
            firstSeenAt: sql`LEAST(${userAchievementUnlocks.firstSeenAt}, excluded."first_seen_at")`,
            catalogVersion: sql`GREATEST(${userAchievementUnlocks.catalogVersion}, excluded."catalog_version")`,
            updatedAt: sql`excluded."updated_at"`,
          },
        });
    } catch {
      noteDbFailure();
      return c.json({ error: 'account storage unavailable' }, 503);
    }
  }
  return c.json({ success: true, applied: deltas.length, serverNow: now });
});

// POST /api/v1/sync/unlocks/pull — full unlock list for login/new device.
syncRouter.post('/unlocks/pull', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'sync database not configured' }, 503);
  const body = await c.req.json().catch(() => null);
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) return c.json({ error: 'unauthorized: valid Bearer token required' }, 401);
  let payload;
  try {
    payload = parseUnlockPull(body);
  } catch {
    return c.json({ error: 'invalid unlocks payload' }, 400);
  }
  const externalId = payload.user.externalId;
  if (authedSub && authedSub !== externalId) {
    return c.json({ error: 'forbidden: token identity does not match user.externalId' }, 403);
  }
  const user = await resolveLegacySyncUser(c, externalId);
  if (user instanceof Response) return user;
  try {
    const rows = await db
      .select()
      .from(userAchievementUnlocks)
      .where(eq(userAchievementUnlocks.userId, user.id));
    return c.json({
      success: true,
      serverNow: Date.now(),
      // Additive: the shipped client ignores unknown keys. Lets a newer client
      // drop local unlocks from before a deliberate stats reset.
      resetAt: normalizeResetAt(user.statsResetAt),
      unlocks: rows.map((r) => ({
        achievementId: r.achievementId,
        level: Number(r.level),
        firstSeenAt: Number(r.firstSeenAt),
        catalogVersion: Number(r.catalogVersion),
      })),
    });
  } catch {
    noteDbFailure();
    return c.json({ error: 'account storage unavailable' }, 503);
  }
});

// GET /api/v1/sync/stats — row counts per user (debug/status UI).
syncRouter.post('/stats', async (c) => {  if (!isDbAvailable()) return c.json({ error: 'sync database not configured' }, 503);
  const body = await c.req.json().catch(() => null);
  const externalId = typeof body?.user?.externalId === 'string' ? body.user.externalId : '';
  if (!externalId) return c.json({ error: 'user.externalId is required' }, 400);
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) return c.json({ error: 'unauthorized' }, 401);
  if (authedSub && authedSub !== externalId) return c.json({ error: 'forbidden' }, 403);
  const user = await resolveLegacySyncUser(c, externalId);
  if (user instanceof Response) return user;
  // COUNT(*) instead of materializing every id just to read its length.
  const [libraryCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(userLibrary)
    .where(eq(userLibrary.userId, user.id));
  const [sessionCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(readingSessions)
    .where(eq(readingSessions.userId, user.id));
  return c.json({
    success: true,
    library: Number(libraryCount?.count ?? 0),
    sessions: Number(sessionCount?.count ?? 0),
    serverNow: Date.now(),
  });
});

// Subject of the caller's token when one is presented (null = anonymous).
// Used for the owner policy without forcing auth on open deployments.
async function authedSubject(c: Context): Promise<string | null> {
  return verifySubject(c.req.header('Authorization'));
}
