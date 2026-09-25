import { Hono, type Context } from 'hono';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { users, userLibrary, readingHistory, readingSessions } from '../database/schema.js';
import { verifySubject } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import {
  authoritativePlan,
  loadFreeStatsForUser,
  storeFreeSessions,
} from '../features/readingSync/freeStore.js';
import {
  buildFreePullResponse,
  buildFreePushResponse,
  claimedExternalId,
  classifySyncRequest,
  contractFailureResponse,
  parseFreeV2Pull,
  parseFreeV2Push,
  proPlanNotImplementedResponse,
  sessionConflictResponse,
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
  genre: z.string().max(100).optional(),
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

async function provisionUser(externalId: string) {
  const [existing] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  if (existing || getEnv().isProd) return existing;
  await db.insert(users).values({
    externalId, email: null, googleSubject: null,
    username: null,
    avatarUrl: null,
  }).onConflictDoNothing({ target: users.externalId });
  return (await db.select().from(users).where(eq(users.externalId, externalId)).limit(1))[0];
}

// Catch account-resolution failures locally; never expose driver diagnostics.
async function resolveSyncUser(c: Context, externalId: string) {
  try {
    const user = await provisionUser(externalId);
    return user ?? c.json({ error: 'account not found' }, 401);
  } catch {
    noteDbFailure();
    return c.json({ error: 'account storage unavailable' }, 503);
  }
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

// ---- Reading statistics v2 (plan-aware). The plan is read from
// users.reading_stats_plan and never from the request; the Free channel is
// validated against the strict v2 contract before a single row is written.
// Pro push/collections are a later task: they fail closed with 501
// (proPlanNotImplementedResponse) instead of silently serving Free data.

const OWNER_MISMATCH = { error: 'forbidden: token identity does not match user.externalId' } as const;
const STORAGE_UNAVAILABLE = { error: 'sync database unavailable' } as const;

function fail(c: Context, failure: SyncFailure) {
  return c.json(failure.body as never, failure.status as never);
}

/** Owner policy for the v2 channel: identical to the legacy rule, checked
 *  before parsing so a mismatched caller learns nothing about payload shape. */
function ownerMismatch(c: Context, authedSub: string | null, body: unknown) {
  const claimed = claimedExternalId(body);
  if (authedSub && claimed !== null && authedSub !== claimed) return c.json(OWNER_MISMATCH, 403);
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
async function v2PlanProbe(c: Context, body: unknown): Promise<Response | null> {
  const externalId = claimedExternalId(body);
  if (externalId === null) return null;
  try {
    const [row] = await db
      .select({ readingStatsPlan: users.readingStatsPlan })
      .from(users)
      .where(eq(users.externalId, externalId))
      .limit(1);
    if (!row) return null;
    const plan = authoritativePlan(row);
    if (plan !== 'free') return fail(c, proPlanNotImplementedResponse(plan));
    return null;
  } catch {
    // A failed probe must not fall through to the permissive path; fail closed.
    noteDbFailure();
    return c.json(STORAGE_UNAVAILABLE, 503);
  }
}

async function pushFreeV2(c: Context, body: unknown, authedSub: string | null) {
  const mismatch = ownerMismatch(c, authedSub, body);
  if (mismatch) return mismatch;
  const planGate = await v2PlanProbe(c, body);
  if (planGate) return planGate;

  let payload;
  try {
    payload = parseFreeV2Push(body);
  } catch (error) {
    return fail(c, contractFailureResponse(error));
  }

  const user = await resolveSyncUser(c, payload.user.externalId);
  if (user instanceof Response) return user;
  // Re-read the plan from the resolved row: the probe cannot see a row that is
  // created by this very request, and the probe may have raced an update.
  const plan = authoritativePlan(user);
  if (plan !== 'free') return fail(c, proPlanNotImplementedResponse(plan));

  let write;
  let stats;
  try {
    write = await storeFreeSessions(user.id, payload.sessions);
    if (write.conflictingSessionIds.length > 0) {
      return fail(c, sessionConflictResponse(write.conflictingSessionIds));
    }
    stats = await loadFreeStatsForUser(user.id);
  } catch {
    // Never surface driver diagnostics, and never leave a half-applied push
    // looking like a success.
    noteDbFailure();
    return c.json(STORAGE_UNAVAILABLE, 503);
  }

  return c.json(buildFreePushResponse({
    stats,
    serverNow: Date.now(),
    appliedSessions: write.applied,
    acceptedSessionIds: write.acceptedSessionIds,
  }));
}

async function pullFreeV2(c: Context, body: unknown, authedSub: string | null) {
  const mismatch = ownerMismatch(c, authedSub, body);
  if (mismatch) return mismatch;
  const planGate = await v2PlanProbe(c, body);
  if (planGate) return planGate;

  let payload;
  try {
    payload = parseFreeV2Pull(body);
  } catch (error) {
    return fail(c, contractFailureResponse(error));
  }

  const user = await resolveSyncUser(c, payload.user.externalId);
  if (user instanceof Response) return user;
  const plan = authoritativePlan(user);
  if (plan !== 'free') return fail(c, proPlanNotImplementedResponse(plan));

  let stats;
  try {
    stats = await loadFreeStatsForUser(user.id);
  } catch {
    noteDbFailure();
    return c.json(STORAGE_UNAVAILABLE, 503);
  }
  return c.json(buildFreePullResponse(stats));
}

// POST /api/v1/sync/push
syncRouter.post('/push', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'sync database not configured' }, 503);
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) {
    return c.json({ error: 'unauthorized: valid Bearer token required' }, 401);
  }
  const body = await c.req.json().catch(() => null);
  const channel = classifySyncRequest(body);
  if (channel === 'v2') return pushFreeV2(c, body, authedSub);
  if (channel === 'unsupported') return fail(c, unsupportedSyncVersionResponse());
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid push payload', issues: parsed.error.issues }, 400);
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
  const user = await resolveSyncUser(c, externalId);
  if (user instanceof Response) return user;

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
        readDay: strDef(e.readDay),
        readAt,
        updatedAt
      };
      if (!existing) await db.insert(readingHistory).values(values);
      else await db.update(readingHistory).set(values).where(eq(readingHistory.id, existing.id));
      appliedHistory++;
    }
  }

  // ---- PLAN GATE (Pro push — not implemented yet) --------------------------
  // `words`, `minuteOfDay`, `readDay` and `genre` are the Pro reading
  // dimensions, and the legacy v1 channel above is plan-blind: it stores exactly
  // what the client sent. When Pro push lands, THIS write must be plan-gated on
  // the authoritative `users.reading_stats_plan === 'pro'`, and a Free row must
  // keep the inert defaults plus `proFieldsPresent = false` that
  // features/readingSync/freeStore.ts writes. Until then a Free account can
  // keep back-filling Pro aggregates (words, WPM, streaks, hourly/genre
  // distribution) through the permissive v1 schema — precisely the evidence the
  // v2 contract refuses to store — so the future Pro projections would read a
  // history that a Free client wrote. The v2 Free channel above is the
  // plan-gated reference implementation; do not let the legacy loop diverge
  // from it unnoticed when Pro lands.
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
        words: num(e.words),
        minuteOfDay: num(e.minuteOfDay),
        readDay: strDef(e.readDay),
        genre: strDef(e.genre),
        ts: num(e.ts, now)
      })
      .onConflictDoNothing({ target: [readingSessions.userId, readingSessions.clientSessionId] })
      .returning();
    if ((r as unknown[]).length > 0) appliedSessions++;
  }

  return c.json({ success: true, applied: { library: appliedLibrary, history: appliedHistory, sessions: appliedSessions }, serverNow: now });
});

// POST /api/v1/sync/pull
syncRouter.post('/pull', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'sync database not configured' }, 503);
  const authedSub = await authedSubject(c);
  if (!getEnv().syncOpen && !authedSub) {
    return c.json({ error: 'unauthorized: valid Bearer token required' }, 401);
  }
  const body = await c.req.json().catch(() => null);
  const channel = classifySyncRequest(body);
  if (channel === 'v2') return pullFreeV2(c, body, authedSub);
  if (channel === 'unsupported') return fail(c, unsupportedSyncVersionResponse());
  const parsed = pullSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid pull payload', issues: parsed.error.issues }, 400);
  const legacyBody = parsed.data;
  const externalId = legacyBody.user.externalId;
  // Owner policy: an authenticated caller may only sync its own identity.
  if (authedSub && authedSub !== externalId) {
    return c.json({ error: 'forbidden: token identity does not match user.externalId' }, 403);
  }
  const since = num(legacyBody.since, 0);
  const user = await resolveSyncUser(c, externalId);
  if (user instanceof Response) return user;

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
      readDay: r.readDay,
      readAt: r.readAt,
      updatedAt: r.updatedAt
    })),
    sessions: sessions.map((r) => ({
      clientSessionId: r.clientSessionId,
      novelId: r.novelId,
      chapterId: r.chapterId,
      seconds: r.seconds,
      words: r.words,
      minuteOfDay: r.minuteOfDay,
      readDay: r.readDay,
      genre: r.genre,
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
  const user = await resolveSyncUser(c, externalId);
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
