import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../database/db.js';
import { readingSessions } from '../../database/schema.js';
import {
  calculateFreeStatsFromTotals,
  type FreeCalculationSession,
} from './calculations.js';
import { COMPLETION_THRESHOLD, type FreeSession, type FreeStats, type ReadingPlan } from './contracts.js';

// ==========================================
// Free-plan persistence for reading statistics.
//
// Sessions are append-only evidence. A Free event stores only the seven
// contract fields plus two storage markers:
//   * completionSignalPresent = true — the client emitted the in-app completion
//     signal, so the row may count toward uniqueInAppCompletedChapters.
//   * proFieldsPresent = false — the Pro dimension columns below are inert
//     safe defaults, never client data.
//
// The unique (user_id, client_session_id) index is the idempotency boundary.
// Nothing here ever UPDATEs a stored event, so the first accepted payload for
// an id stays authoritative forever.
// ==========================================

/**
 * Pro-only columns are NOT NULL, so a Free row must still supply values.
 * These defaults are deliberately empty/zero: they keep the row insertable
 * without inventing evidence a Free client never sent.
 *
 * Cross-reference: the legacy v1 session write in routes/sync.ts is still
 * plan-blind and stores whatever those Pro columns are sent. Pro push must
 * plan-gate that write (and keep these defaults for Free) so a Free account
 * cannot back-fill Pro aggregates.
 */
export const FREE_SESSION_SAFE_DEFAULTS = {
  words: 0,
  minuteOfDay: 0,
  readDay: '',
  genre: '',
} as const;

/**
 * `progress_percent` is a float4, so a round-trip is only float-accurate.
 * Compare with a tolerance wider than float4's worst case at 100.0 to avoid
 * reporting a phantom conflict for a value the client already stored.
 */
const PROGRESS_EPSILON = 1e-4;

interface StoredFreeSession {
  clientSessionId: string;
  novelId: string;
  chapterId: number;
  seconds: number;
  progressPercent: number;
  completed: boolean;
  ts: number;
}

export interface FreeSessionWriteResult {
  /** Rows this request created. */
  applied: number;
  /**
   * Ids acknowledged by this push, duplicates included, in payload order.
   *
   * A 409 can carry ids here: when the batch loses an insert race, the rows it
   * created before that point are immutable valid events that a retry would
   * only re-acknowledge, so they are reported instead of being hidden.
   */
  acceptedSessionIds: string[];
  /** Ids whose stored event differs from the pushed one. */
  conflictingSessionIds: string[];
}

/**
 * Only the stored column is ever trusted as the plan, and an absent or
 * unrecognised value degrades to Free. The DB check constraint already limits
 * the column to 'free' | 'pro'; this keeps a null/undefined row (legacy
 * fixture, in-memory fallback) from widening any projection.
 */
export function normalizeReadingPlan(value: unknown): ReadingPlan {
  return value === 'pro' ? 'pro' : 'free';
}

/** Read the authoritative plan from a resolved user row. */
export function authoritativePlan(user: { readingStatsPlan?: unknown } | null | undefined): ReadingPlan {
  return normalizeReadingPlan(user?.readingStatsPlan);
}

/**
 * Derive the effective plan from a resolved user row and server time.
 *
 * Single authority for push, pull, and profile. `plan` is the granted tier,
 * `planExpiresAt` is the entitlement clock (exclusive: nowMs >= expiresAt is
 * Free). Fail closed: a Pro flag without a safe-integer expiry grants nothing.
 * `graceUntil` / trial columns are reserved and never consulted here;
 * `planStatus`, counters, and durations are display/audit only.
 */
export function effectiveReadingPlan(
  user: { readingStatsPlan?: unknown; readingStatsPlanExpiresAt?: unknown } | null | undefined,
  nowMs: number,
): ReadingPlan {
  if (normalizeReadingPlan(user?.readingStatsPlan) !== 'pro') return 'free';
  const expiresAt = (user as { readingStatsPlanExpiresAt?: unknown } | null | undefined)?.readingStatsPlanExpiresAt;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return 'free';
  return nowMs < expiresAt ? 'pro' : 'free';
}

/**
 * The entitlement clock that GOVERNS the plan currently in force, or null.
 *
 * Published alongside `plan` so a client can retire an expired Pro locally
 * instead of waiting for its next round trip. Two properties are deliberate:
 *
 *  - It is derived from `effectiveReadingPlan`, so it can never disagree with
 *    the tier in the same response. A lapsed row still holding a stale
 *    `readingStatsPlanExpiresAt` publishes `null`, not a past timestamp, because
 *    the plan it governed is already Free.
 *  - It is non-null ONLY while the plan is `pro`. A client therefore can never
 *    use the presence of an expiry to infer Pro — the value can only ever
 *    REVOKE, never grant. That keeps the client's local check fail-closed no
 *    matter how wrong the device clock is.
 */
export function effectivePlanExpiry(
  user: { readingStatsPlan?: unknown; readingStatsPlanExpiresAt?: unknown } | null | undefined,
  nowMs: number,
): number | null {
  if (effectiveReadingPlan(user, nowMs) !== 'pro') return null;
  const expiresAt = (user as { readingStatsPlanExpiresAt?: unknown } | null | undefined)?.readingStatsPlanExpiresAt;
  return typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) ? expiresAt : null;
}

const sessionColumns = {
  clientSessionId: readingSessions.clientSessionId,
  novelId: readingSessions.novelId,
  chapterId: readingSessions.chapterId,
  seconds: readingSessions.seconds,
  progressPercent: readingSessions.progressPercent,
  completed: readingSessions.completed,
  ts: readingSessions.ts,
};

async function readStoredSessions(
  userId: string,
  clientSessionIds: readonly string[],
): Promise<StoredFreeSession[]> {
  if (clientSessionIds.length === 0) return [];
  const rows = await db
    .select(sessionColumns)
    .from(readingSessions)
    .where(and(
      eq(readingSessions.userId, userId),
      inArray(readingSessions.clientSessionId, [...clientSessionIds]),
    ));
  return rows.map((row) => ({
    clientSessionId: row.clientSessionId,
    novelId: row.novelId,
    chapterId: Number(row.chapterId),
    seconds: Number(row.seconds),
    progressPercent: Number(row.progressPercent),
    completed: row.completed,
    ts: Number(row.ts),
  }));
}

/** An identical retry is a duplicate; any changed field is a conflict. */
function isSameEvent(session: FreeSession, row: StoredFreeSession): boolean {
  return row.novelId === session.novelId
    && row.chapterId === session.chapterId
    && row.seconds === session.seconds
    && Math.abs(row.progressPercent - session.progressPercent) <= PROGRESS_EPSILON
    && row.completed === session.completed
    && row.ts === session.ts;
}

/**
 * Collapse a payload to one candidate per clientSessionId.
 *
 * A client may legitimately repeat an identical id inside one batch (a queued
 * outbox flushed twice), but two *different* events under one id make the
 * payload self-contradictory: storing either one would make the other a
 * permanent conflict. Such ids are reported instead of being resolved by
 * ordering, so the caller sees 409 and the first copy stays authoritative.
 */
function collapseByClientSessionId(sessions: readonly FreeSession[]): {
  unique: FreeSession[];
  inconsistentSessionIds: string[];
} {
  const firstById = new Map<string, FreeSession>();
  const inconsistentSessionIds = new Set<string>();

  for (const session of sessions) {
    const first = firstById.get(session.clientSessionId);
    if (first === undefined) {
      firstById.set(session.clientSessionId, session);
      continue;
    }
    if (!isSameEvent(first, session)) inconsistentSessionIds.add(session.clientSessionId);
  }

  return {
    unique: [...firstById.values()],
    inconsistentSessionIds: [...inconsistentSessionIds],
  };
}

/** Map one contract session onto the storage row a Free event is made of. */
function toFreeSessionRow(userId: string, session: FreeSession) {
  return {
    userId,
    clientSessionId: session.clientSessionId,
    novelId: session.novelId,
    chapterId: session.chapterId,
    progressPercent: session.progressPercent,
    completed: session.completed,
    completionSignalPresent: true,
    proFieldsPresent: false,
    ...FREE_SESSION_SAFE_DEFAULTS,
    seconds: session.seconds,
    ts: session.ts,
  };
}

/**
 * Store Free sessions idempotently.
 *
 * A conflict is reported before the first write whenever it is knowable
 * up-front (a self-contradictory batch, or an id already stored with different
 * values), so a rejected push leaves both the stored event and the rest of the
 * batch untouched.
 *
 * The pending rows go out as ONE multi-row insert guarded by the
 * (user_id, client_session_id) unique index, so a 500-row push costs one
 * statement instead of 500 round trips and a concurrent push of the same id
 * cannot interleave a half batch. Rows the database refused are exactly the ids
 * a concurrent push won; they are classified in a single follow-up read, which
 * is bounded by the batch (MAX_SESSIONS_PER_PUSH) and keeps the retry a
 * duplicate acknowledgement or a 409 — never an overwrite.
 */
export async function storeFreeSessions(
  userId: string,
  sessions: readonly FreeSession[],
): Promise<FreeSessionWriteResult> {
  const { unique, inconsistentSessionIds } = collapseByClientSessionId(sessions);
  if (inconsistentSessionIds.length > 0) {
    return { applied: 0, acceptedSessionIds: [], conflictingSessionIds: inconsistentSessionIds };
  }
  if (unique.length === 0) {
    return { applied: 0, acceptedSessionIds: [], conflictingSessionIds: [] };
  }

  const stored = await readStoredSessions(userId, unique.map((session) => session.clientSessionId));
  const storedById = new Map(stored.map((row) => [row.clientSessionId, row]));

  const pending: FreeSession[] = [];
  const outcome = new Map<string, 'accepted' | 'conflict'>();
  for (const session of unique) {
    const row = storedById.get(session.clientSessionId);
    if (!row) {
      pending.push(session);
      continue;
    }
    outcome.set(session.clientSessionId, isSameEvent(session, row) ? 'accepted' : 'conflict');
  }

  const conflictsIn = (kind: 'accepted' | 'conflict') => unique
    .map((session) => session.clientSessionId)
    .filter((id) => outcome.get(id) === kind);
  if (conflictsIn('conflict').length > 0) {
    return { applied: 0, acceptedSessionIds: [], conflictingSessionIds: conflictsIn('conflict') };
  }

  if (pending.length === 0) {
    return { applied: 0, acceptedSessionIds: conflictsIn('accepted'), conflictingSessionIds: [] };
  }

  const inserted = await db
    .insert(readingSessions)
    .values(pending.map((session) => toFreeSessionRow(userId, session)))
    .onConflictDoNothing({ target: [readingSessions.userId, readingSessions.clientSessionId] })
    .returning();

  const insertedIds = new Set(inserted.map((row) => row.clientSessionId));
  for (const id of insertedIds) outcome.set(id, 'accepted');

  // One bounded read for the ids the database refused. A committed winner is
  // always visible to the statement that follows the insert, so a single read
  // is enough — and an id the read cannot resolve is reported as a conflict
  // rather than acknowledged, because nothing may be acked that was not verified.
  const racedIds = pending
    .map((session) => session.clientSessionId)
    .filter((id) => !insertedIds.has(id));
  if (racedIds.length > 0) {
    const winners = await readStoredSessions(userId, racedIds);
    const winnersById = new Map(winners.map((row) => [row.clientSessionId, row]));
    const byId = new Map(pending.map((session) => [session.clientSessionId, session]));
    for (const id of racedIds) {
      const winner = winnersById.get(id);
      const pushed = byId.get(id);
      outcome.set(
        id,
        winner && pushed && isSameEvent(pushed, winner) ? 'accepted' : 'conflict',
      );
    }
  }

  return {
    applied: insertedIds.size,
    acceptedSessionIds: conflictsIn('accepted'),
    conflictingSessionIds: conflictsIn('conflict'),
  };
}

/**
 * Row-by-row projection input, the shape the full-scan calculation consumes.
 *
 * The production read path aggregates in SQL (see loadFreeStatsForUser); this
 * mapping is exported for the equivalence test that proves the aggregated
 * totals are exactly what a full scan of the same rows would produce.
 */
export function toFreeScanSession(row: {
  seconds: number;
  novelId: string;
  chapterId: number;
  progressPercent: number;
  completionSignalPresent: boolean;
}): FreeCalculationSession {
  return {
    seconds: Number(row.seconds),
    novelId: row.novelId,
    chapterId: Number(row.chapterId),
    progressPercent: Number(row.progressPercent),
    // Only an explicit marker can prove an in-app completion. Legacy v1 rows
    // have no marker: they contribute time, never a completed chapter.
    completionSignalPresent: row.completionSignalPresent === true,
  };
}

/**
 * Derive the Free projection for one user without streaming their session rows.
 *
 * A v2 push/pull used to read every stored session of the user into memory on
 * each request, so one reader's history set the cost of every read. The
 * projection only needs two numbers, so the database computes them:
 *   * totalSecondsRead — the sum of non-negative `seconds`;
 *   * uniqueInAppCompletedChapters — distinct (novel_id, chapter_id) pairs
 *     carrying an explicit in-app completion signal at or above the boundary.
 *
 * The predicates deliberately repeat the calculation boundary so the SQL and
 * calculations.ts cannot drift:
 *   * `GREATEST(seconds, 0)` mirrors the per-row non-negative credit. The
 *     plan-blind legacy v1 writer can store a negative `seconds`, and clamping
 *     here keeps the SQL total from being smaller than the scanned one.
 *   * a novel id must be a non-blank string and a chapter id a positive
 *     integer, exactly what normalizeNovelId/normalizeChapterId accept;
 *   * a completion needs `completion_signal_present` AND
 *     `progress_percent >= COMPLETION_THRESHOLD`, so a legacy v1 row contributes
 *     time, never a completed chapter.
 *
 * The level ladder is NOT re-derived here: the two totals go to
 * calculateFreeStatsFromTotals(), which keeps calculations.ts the single
 * authority for level and progress.
 */
export async function loadFreeStatsForUser(userId: string): Promise<FreeStats> {
  const [row] = await db
    .select({
      totalSeconds: sql<number>`COALESCE(SUM(GREATEST(${readingSessions.seconds}, 0)), 0)`,
      completedChapters: sql<number>`COUNT(DISTINCT (${readingSessions.novelId}, ${readingSessions.chapterId})) FILTER (WHERE ${readingSessions.completionSignalPresent} AND ${readingSessions.progressPercent} >= ${COMPLETION_THRESHOLD} AND BTRIM(${readingSessions.novelId}) <> '' AND ${readingSessions.chapterId} > 0)`,
    })
    .from(readingSessions)
    .where(eq(readingSessions.userId, userId));
  return calculateFreeStatsFromTotals({
    // int8 aggregates arrive as strings on node-postgres, and a non-numeric or
    // negative value is normalized by the calculation boundary.
    totalSeconds: Number(row?.totalSeconds ?? 0),
    uniqueInAppCompletedChapters: Number(row?.completedChapters ?? 0),
  });
}
