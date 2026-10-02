import { Hono, type Context } from 'hono';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { users, userLibrary, readingHistory, readingSessions, subscriptionEvents } from '../database/schema.js';
import { verifySubject } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import {
  effectiveReadingPlan,
  FREE_SESSION_SAFE_DEFAULTS,
  loadFreeStatsForUser,
  storeFreeSessions,
} from '../features/readingSync/freeStore.js';
import { pullProData, storeProPush } from '../features/readingSync/proStore.js';
import { buildProPushResponse, parseProV2Pull, parseProV2Push } from '../features/readingSync/proProtocol.js';
import type { ReadingPlan, ProReadingSyncPush, ProReadingSyncPull } from '../features/readingSync/contracts.js';
import {
  accountNotFoundResponse,
  buildFreePullResponse,
  buildFreePushResponse,
  capReportedIssues,
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

export const CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

// ---- Input validation (zod). Malformed outbox payloads must fail as 400
// (client drops the op) — never 500 (client would retry forever).
const userSchema = z.object({
  externalId: z.string().min(1).max(255),
  email: z.string().max(255).optional(),
  name: z.string().max(100).optional()
});
const libraryRowSchema = z.object({
  novelId: z.union([z.string(), z.number()]),
  sourceId: z.string().max(100).nullable().optional(),
  categoryIds: z.array(z.string()).optional(),
  lastReadChapterId: z.number().nullable().optional(),
  lastReadChapterNumber: z.number().nullable().optional(),
  lastReadChapterTitle: z.string().max(255).nullable().optional(),
  progressPercent: z.number().optional(),
  lastReadAt: z.string().nullable().optional(),
  addedAt: z.string().nullable().optional(),
  updatedAt: z.number().optional(),
  deletedAt: z.number().nullable().optional()
});
const historyRowSchema = z.object({
  novelId: z.union([z.string(), z.number()]),
  novelTitle: z.string().max(255).optional(),
  novelCover: z.string().optional(),
  novelAuthor: z.string().max(150).optional(),
  category: z.string().max(100).optional(),
  sourceId: z.string().max(100).nullable().optional(),
  chapterId: z.number(),
  chapterNumber: z.number().optional(),
  chapterTitle: z.string().max(255).optional(),
  progressPercent: z.number().optional(),
  readDay: z.string().max(10).optional(),
  readAt: z.number().optional(),
  updatedAt: z.number().optional()
});
const sessionRowSchema = z.object({
  clientSessionId: z.string().min(1).max(64),
  novelId: z.union([z.string(), z.number()]).optional(),
  chapterId: z.number().optional(),
  seconds: z.number().optional(),
  words: z.number().optional(),
  minuteOfDay: z.number().optional(),
  readDay: z.string().max(10).optional(),
  ts: z.number().optional()
});
const pushSchema = z.object({
  user: userSchema,
  deviceId: z.string().max(100).optional(),
  library: z.array(libraryRowSchema).max(5000).optional(),
  history: z.array(historyRowSchema).max(5000).optional(),
  sessions: z.array(sessionRowSchema).max(5000).optional()
});
const pullSchema = z.object({
  user: userSchema,
  since: z.number().optional()
});

const clampTs = (ts: number, now: number): number =>
  ts > now + CLIENT_CLOCK_SKEW_MS ? now : ts;

const unionStrings = (a: string[], b: string[]): string[] => {
  const seen = new Set<string>();
  return [...a, ...b].map(String).filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
};

/** The only user columns any sync path needs. Sync never reads the auth
 *  anchors (password hash, google subject) or the write-side profile fields. */
const SYNC_USER_COLUMNS = {
  id: users.id,
  externalId: users.externalId,
  readingStatsPlan: users.readingStatsPlan,
  readingStatsPlanExpiresAt: users.readingStatsPlanExpiresAt,
} as const;

type SyncUser = { id: string; externalId: string | null; readingStatsPlan: string | null; readingStatsPlanExpiresAt: number | null };

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
 * Legacy v1 keeps its original bodies for account-resolution failures, so the
 * resolution result is rendered per channel rather than normalized here.
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

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strDef = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const dateOrNull = (v: unknown): Date | null => {
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

/**
 * Legacy v1 400 body: `{ error, issues }` as before, with the issue list
 * capped. A 5000-row outbox flush produces one zod issue per field, so an
 * uncapped list let a client choose the size of its own error response. The cap
 * reuses the v2 budget (MAX_REPORTED_ISSUES) and only adds `issuesTruncated`
 * when something was actually dropped, so a small failure stays byte-identical.
 */
function legacyIssues(c: Context, error: string, issues: readonly unknown[]) {
  const { issues: capped, issuesTruncated } = capReportedIssues(issues);
  return c.json({ error, issues: capped, ...(issuesTruncated ? { issuesTruncated: true } : {}) }, 400);
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
    if (plan === 'pro' && 'readingStats' in payload) {
      return c.json(await pullProData(user.id, (payload as ProReadingSyncPull).readingStats));
    }
    if (plan === 'pro') return fail(c, syncFailure(400, 'invalid_sync_payload', 'pro pull requires readingStats cursors'));
    const response = buildFreePullResponse(await loadFreeStatsForUser(user.id));
    if (plan === 'free') await logExpiredObservation(user);
    return c.json(response);
  } catch {
    console.warn(JSON.stringify({ event: 'sync.pro_read', outcome: 'unavailable' }));
    return fail(c, storageUnavailableResponse());
  }
}

/**
 * Shared prelude for both legacy channels: read the body once, classify the
 * declared protocol, then apply the storage/auth gates.
 *
 * The body is buffered BEFORE the gates purely so the declared channel is known
 * when a gate rejects: a v2 caller must receive the typed v2 failure body while
 * a v1 caller keeps the legacy one. Precedence is unchanged — neither gate runs
 * before the other, and both still precede every storage access and every
 * schema parse. A body too broken to read declares no version, so it is treated
 * as legacy and gets the legacy body, exactly as before.
 */
async function syncRequestPreamble(c: Context, legacyUnavailable: () => Response, legacyUnauthenticated: () => Response) {
  const body = await c.req.json().catch(() => null);
  const channel = classifySyncRequest(body);
  if (!isDbAvailable()) {
    if (channel === 'v2') return fail(c, syncDatabaseUnavailableResponse());
    return legacyUnavailable();
  }
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) {
    if (channel === 'v2') return fail(c, unauthorizedResponse('unauthorized: valid Bearer token required'));
    return legacyUnauthenticated();
  }
  return { body, channel, authedSub };
}

// POST /api/v1/sync/push
syncRouter.post('/push', async (c) => {
  const preamble = await syncRequestPreamble(
    c,
    () => c.json({ error: 'sync database not configured' }, 503),
    () => c.json({ error: 'unauthorized: valid Bearer token required' }, 401),
  );
  if (preamble instanceof Response) return preamble;
  const { body, channel, authedSub } = preamble;
  if (channel === 'v2') return pushV2(c, body, authedSub);
  if (channel === 'unsupported') return fail(c, unsupportedSyncVersionResponse());
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) return legacyIssues(c, 'invalid push payload', parsed.error.issues);
  // The legacy channel keeps working from the parsed body exactly as before the
  // v2 branch existed: classification only needs the raw body, the writer only
  // ever sees validated fields.
  const legacyBody = parsed.data;
  const externalId = legacyBody.user.externalId;
  // Owner policy: an authenticated caller may only sync its own identity.
  if (authedSub && authedSub !== externalId) {
    return c.json({ error: 'forbidden: token identity does not match user.externalId' }, 403);
  }
  const now = Date.now();
  const user = await resolveLegacySyncUser(c, externalId);
  if (user instanceof Response) return user;
  // Derived-plan gate (§ Legacy v1 gating): owner check ran before resolve;
  // derivation runs on the freshly resolved row. Free-derived callers store
  // safe defaults for Pro dimensions instead of client-sent values.
  const legacyPlan = effectiveReadingPlan(user, now);
  const legacyFree = legacyPlan !== 'pro';

  let appliedLibrary = 0;
  for (const e of legacyBody.library ?? []) {
    const novelId = String(e.novelId ?? '');
    if (!novelId) continue;
    const updatedAt = clampTs(num(e.updatedAt, now), now);
    const deletedAt = e.deletedAt == null ? null : clampTs(num(e.deletedAt), now);
    const existing = await db
      .select()
      .from(userLibrary)
      .where(and(eq(userLibrary.userId, user.id), eq(userLibrary.novelId, novelId)))
      .then((r) => r[0]);
    const values = {
      userId: user.id,
      novelId,
      sourceId: str(e.sourceId),
      categoryIds: Array.isArray(e.categoryIds) ? e.categoryIds.map(String) : [],
      lastReadChapterId: e.lastReadChapterId == null ? null : num(e.lastReadChapterId),
      lastReadChapterNumber: e.lastReadChapterNumber == null ? null : num(e.lastReadChapterNumber),
      lastReadChapterTitle: str(e.lastReadChapterTitle),
      progressPercent: num(e.progressPercent),
      lastReadAt: dateOrNull(e.lastReadAt),
      addedAt: dateOrNull(e.addedAt) ?? new Date(),
      updatedAt,
      deletedAt
    };
    if (!existing) {
      await db.insert(userLibrary).values(values);
      appliedLibrary++;
      continue;
    }
    const oldTomb = existing.deletedAt != null;
    const newTomb = deletedAt != null;
    if (oldTomb !== newTomb) {
      if (!newTomb) continue; // tombstone wins: live incoming loses to stored delete
      await db.update(userLibrary).set(values).where(eq(userLibrary.id, existing.id));
      appliedLibrary++;
    } else if (updatedAt > (existing.updatedAt ?? 0)) {
      await db.update(userLibrary).set(values).where(eq(userLibrary.id, existing.id));
      appliedLibrary++;
    } else if (updatedAt === (existing.updatedAt ?? 0) && !newTomb) {
      const merged = unionStrings(existing.categoryIds ?? [], values.categoryIds);
      if (merged.length !== (existing.categoryIds ?? []).length) {
        await db.update(userLibrary).set({ categoryIds: merged }).where(eq(userLibrary.id, existing.id));
        appliedLibrary++;
      }
    }
  }

  let appliedHistory = 0;
  for (const e of legacyBody.history ?? []) {
    const novelId = String(e.novelId ?? '');
    const chapterId = num(e.chapterId, -1);
    if (!novelId || chapterId < 0) continue;
    const readAt = clampTs(num(e.readAt, now), now);
    const updatedAt = clampTs(num(e.updatedAt, readAt), now);
    const existing = await db
      .select()
      .from(readingHistory)
      .where(
        and(
          eq(readingHistory.userId, user.id),
          eq(readingHistory.novelId, novelId),
          eq(readingHistory.chapterId, chapterId)
        )
      )
      .then((r) => r[0]);
    if (!existing || readAt > (existing.readAt ?? 0) || (readAt === (existing.readAt ?? 0) && updatedAt > (existing.updatedAt ?? 0))) {
      const values = {
        userId: user.id,
        novelId,
        novelTitle: strDef(e.novelTitle),
        novelCover: strDef(e.novelCover),
        novelAuthor: strDef(e.novelAuthor),
        category: strDef(e.category),
        sourceId: str(e.sourceId),
        chapterId,
        chapterNumber: num(e.chapterNumber),
        chapterTitle: strDef(e.chapterTitle),
        progressPercent: num(e.progressPercent),
        readDay: legacyFree ? '' : strDef(e.readDay),
        readAt,
        updatedAt
      };
      if (!existing) await db.insert(readingHistory).values(values);
      else await db.update(readingHistory).set(values).where(eq(readingHistory.id, existing.id));
      appliedHistory++;
    }
  }

  // ---- PLAN GATE (legacy v1 sessions) -------------------------------------
  // Derived above: a Free-derived caller stores FREE_SESSION_SAFE_DEFAULTS
  // for the Pro dimensions (words, minuteOfDay, readDay), matching what
  // features/readingSync/freeStore.ts writes on the v2 Free channel.
  let appliedSessions = 0;
  for (const e of legacyBody.sessions ?? []) {
    const key = typeof e.clientSessionId === 'string' ? e.clientSessionId : '';
    if (!key) continue;
    const r = await db
      .insert(readingSessions)
      .values({
        userId: user.id,
        clientSessionId: key,
        novelId: String(e.novelId ?? ''),
        chapterId: num(e.chapterId),
        seconds: num(e.seconds),
        ...(legacyFree ? FREE_SESSION_SAFE_DEFAULTS : {
          words: num(e.words),
          minuteOfDay: num(e.minuteOfDay),
          readDay: strDef(e.readDay),
        }),
        ts: num(e.ts, now)
      })
      .onConflictDoNothing({ target: [readingSessions.userId, readingSessions.clientSessionId] })
      .returning();
    if ((r as unknown[]).length > 0) appliedSessions++;
  }

  if (legacyFree) await logExpiredObservation(user);
  return c.json({ success: true, applied: { library: appliedLibrary, history: appliedHistory, sessions: appliedSessions }, serverNow: now });
});

// POST /api/v1/sync/pull
syncRouter.post('/pull', async (c) => {
  const preamble = await syncRequestPreamble(
    c,
    () => c.json({ error: 'sync database not configured' }, 503),
    () => c.json({ error: 'unauthorized: valid Bearer token required' }, 401),
  );
  if (preamble instanceof Response) return preamble;
  const { body, channel, authedSub } = preamble;
  if (channel === 'v2') return pullV2(c, body, authedSub);
  if (channel === 'unsupported') return fail(c, unsupportedSyncVersionResponse());
  const parsed = pullSchema.safeParse(body);
  if (!parsed.success) return legacyIssues(c, 'invalid pull payload', parsed.error.issues);
  const legacyBody = parsed.data;
  const externalId = legacyBody.user.externalId;
  // Owner policy: an authenticated caller may only sync its own identity.
  if (authedSub && authedSub !== externalId) {
    return c.json({ error: 'forbidden: token identity does not match user.externalId' }, 403);
  }
  const since = num(legacyBody.since, 0);
  const user = await resolveLegacySyncUser(c, externalId);
  if (user instanceof Response) return user;
  // Derived-plan gate (§ Legacy v1 gating): values gated, shapes unchanged.
  const pullFree = effectiveReadingPlan(user, Date.now()) !== 'pro';

  // ---- PLAN GATE (v1 pull projection) ---------------------------------------
  // Session/history rows stay stored as-is; only the Pro-dimension values in
  // this projection are gated for Free-derived callers.
  const library = await db
    .select()
    .from(userLibrary)
    .where(and(eq(userLibrary.userId, user.id), gt(userLibrary.updatedAt, since)))
    .orderBy(userLibrary.updatedAt)
    .limit(5000);
  const history = await db
    .select()
    .from(readingHistory)
    .where(and(eq(readingHistory.userId, user.id), gt(readingHistory.updatedAt, since)))
    .orderBy(readingHistory.updatedAt)
    .limit(5000);
  const sessions = await db
    .select()
    .from(readingSessions)
    .where(and(eq(readingSessions.userId, user.id), gt(readingSessions.ts, since)))
    .orderBy(readingSessions.ts)
    .limit(5000);

  if (pullFree) await logExpiredObservation(user);

  return c.json({
    success: true,
    serverNow: Date.now(),
    library: library.map((r) => ({
      novelId: r.novelId,
      sourceId: r.sourceId,
      categoryIds: r.categoryIds,
      lastReadChapterId: r.lastReadChapterId,
      lastReadChapterNumber: r.lastReadChapterNumber,
      lastReadChapterTitle: r.lastReadChapterTitle,
      progressPercent: r.progressPercent,
      lastReadAt: r.lastReadAt?.toISOString() ?? null,
      addedAt: r.addedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt
    })),
    history: history.map((r) => ({
      novelId: r.novelId,
      novelTitle: r.novelTitle,
      novelCover: r.novelCover,
      novelAuthor: r.novelAuthor,
      category: r.category,
      sourceId: r.sourceId,
      chapterId: r.chapterId,
      chapterNumber: r.chapterNumber,
      chapterTitle: r.chapterTitle,
      progressPercent: r.progressPercent,
      readDay: pullFree ? '' : r.readDay,
      readAt: r.readAt,
      updatedAt: r.updatedAt
    })),
    sessions: sessions.map((r) => ({
      clientSessionId: r.clientSessionId,
      novelId: r.novelId,
      chapterId: r.chapterId,
      seconds: r.seconds,
      ...(pullFree ? FREE_SESSION_SAFE_DEFAULTS : {
        words: r.words,
        minuteOfDay: r.minuteOfDay,
        readDay: r.readDay,
      }),
      ts: r.ts
    }))
  });
});

// GET /api/v1/sync/stats — row counts per user (debug/status UI).
syncRouter.post('/stats', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'sync database not configured' }, 503);
  const body = await c.req.json().catch(() => null);
  const externalId = typeof body?.user?.externalId === 'string' ? body.user.externalId : '';
  if (!externalId) return c.json({ error: 'user.externalId is required' }, 400);
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) return c.json({ error: 'unauthorized' }, 401);
  if (authedSub && authedSub !== externalId) return c.json({ error: 'forbidden' }, 403);
  const user = await resolveLegacySyncUser(c, externalId);
  if (user instanceof Response) return user;
  const lib = await db.select({ id: userLibrary.id }).from(userLibrary).where(eq(userLibrary.userId, user.id));
  const hist = await db.select({ id: readingHistory.id }).from(readingHistory).where(eq(readingHistory.userId, user.id));
  const sess = await db.select({ id: readingSessions.id }).from(readingSessions).where(eq(readingSessions.userId, user.id));
  return c.json({ success: true, library: lib.length, history: hist.length, sessions: sess.length, serverNow: Date.now() });
});

// Subject of the caller's token when one is presented (null = anonymous).
// Used for the owner policy without forcing auth on open deployments.
async function authedSubject(c: Context): Promise<string | null> {
  return verifySubject(c.req.header('Authorization'));
}
