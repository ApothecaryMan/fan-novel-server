import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../database/db.js';
import { readingSessions } from '../../database/schema.js';
import { calculateFreeStats, type FreeCalculationSession } from './calculations.js';
import type { FreeSession, FreeStats, ReadingPlan } from './contracts.js';

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
  /** Ids acknowledged by this push, duplicates included, in payload order. */
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

/**
 * Store Free sessions idempotently.
 *
 * A conflict is reported before the first write whenever it is knowable
 * up-front (a self-contradictory batch, or an id already stored with different
 * values), so a rejected push leaves both the stored event and the rest of the
 * batch untouched. The only mid-batch conflict is an insert race against a
 * concurrent push, where the rows already written are valid immutable events
 * that a retry would merely re-acknowledge.
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

  let applied = 0;
  for (const session of pending) {
    const inserted = await db
      .insert(readingSessions)
      .values({
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
      })
      .onConflictDoNothing({ target: [readingSessions.userId, readingSessions.clientSessionId] })
      .returning();

    if (inserted.length > 0) {
      applied += 1;
      outcome.set(session.clientSessionId, 'accepted');
      continue;
    }
    // A concurrent push of the same id won the insert race. Nothing was
    // overwritten, so classify the winner instead of failing the request.
    const [winner] = await readStoredSessions(userId, [session.clientSessionId]);
    outcome.set(
      session.clientSessionId,
      winner && isSameEvent(session, winner) ? 'accepted' : 'conflict',
    );
  }

  const conflictingSessionIds = conflictsIn('conflict');
  return {
    applied,
    acceptedSessionIds: conflictsIn('accepted'),
    conflictingSessionIds,
  };
}

function toFreeCalculationSession(row: {
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
 * Derive the Free projection from every stored session of one user.
 *
 * The calculation module is the single source of truth for the level ladder
 * and the 85% completion boundary, so this reads the rows rather than
 * re-deriving them in SQL.
 */
export async function loadFreeStatsForUser(userId: string): Promise<FreeStats> {
  const rows = await db
    .select({
      seconds: readingSessions.seconds,
      novelId: readingSessions.novelId,
      chapterId: readingSessions.chapterId,
      progressPercent: readingSessions.progressPercent,
      completionSignalPresent: readingSessions.completionSignalPresent,
    })
    .from(readingSessions)
    .where(eq(readingSessions.userId, userId));
  return calculateFreeStats(rows.map(toFreeCalculationSession));
}
