import {
  READING_SYNC_VERSION,
  ReadingSyncContractError,
  freeProjection,
  parseFreeReadingSyncPull,
  parseFreeReadingSyncPush,
  type FreeReadingSyncPull,
  type FreeReadingSyncPush,
  type FreeReadingSyncPullResponse,
  type FreeReadingSyncPushResponse,
  type FreeStats,
  type ReadingPlan,
  type ReadingSyncErrorCode,
} from './contracts.js';

// ==========================================
// Free-plan v2 request/response plumbing.
//
// This module owns no database and no Hono context: it decides which protocol
// a payload is speaking, parses it, classifies contract failures, and builds
// the two Free response envelopes. The plan itself is never read here — it is
// supplied by the caller from the authoritative `users.reading_stats_plan`
// column, so no client field can ever widen the projection.
// ==========================================

/** How a push/pull body declared its protocol. */
export type SyncRequestChannel = 'legacy' | 'v2' | 'unsupported';

const LEGACY_SYNC_VERSION = 1;

/** Issue detail is a client aid, not a dump: cap it so a 500-row bad push
 *  cannot turn a 400 into an unbounded response. */
const MAX_REPORTED_ISSUES = 20;

export interface SyncFailure {
  status: number;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Classify by the *declared* version, never by shape sniffing.
 *
 * A body that omits `syncVersion` is the legacy v1 protocol and keeps its
 * permissive schema. A body that declares anything other than 1 or 2 is
 * rejected instead of being downgraded onto the legacy path: falling through
 * would let a broken or spoofed v2 client (`"2"`, `2.1`, `3`) push Pro fields
 * through the permissive v1 schemas.
 */
export function classifySyncRequest(body: unknown): SyncRequestChannel {
  if (!isRecord(body) || body.syncVersion === undefined) return 'legacy';
  if (body.syncVersion === READING_SYNC_VERSION) return 'v2';
  if (body.syncVersion === LEGACY_SYNC_VERSION) return 'legacy';
  return 'unsupported';
}

export function unsupportedSyncVersionResponse(): SyncFailure {
  return {
    status: 400,
    body: {
      success: false,
      code: 'unsupported_sync_version',
      error: `unsupported sync version; expected ${LEGACY_SYNC_VERSION} or ${READING_SYNC_VERSION}`,
    },
  };
}

export function parseFreeV2Push(body: unknown): FreeReadingSyncPush {
  return parseFreeReadingSyncPush(body);
}

export function parseFreeV2Pull(body: unknown): FreeReadingSyncPull {
  return parseFreeReadingSyncPull(body);
}

/** The externalId the body claims, or null when it is missing/mistyped. */
export function claimedExternalId(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.user)) return null;
  const value = body.user.externalId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map a contract failure onto HTTP. Entitlement violations answer 403 so a
 * client can tell "this is a Pro feature" apart from "your payload is wrong";
 * every other malformed shape is a plain 400 that the client should drop.
 */
export function contractFailureResponse(error: unknown): SyncFailure {
  const contractError = error instanceof ReadingSyncContractError
    ? error
    : new ReadingSyncContractError(error);
  const code: ReadingSyncErrorCode = contractError.code;
  const status = code === 'pro_fields_not_allowed' ? 403 : 400;
  const issues = contractError.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.map((segment) => String(segment)),
    message: issue.message,
  }));
  return {
    status,
    body: {
      success: false,
      code,
      error: status === 403
        ? 'free plan does not accept pro reading fields'
        : 'invalid sync payload',
      ...(issues.length > 0 ? { issues } : {}),
    },
  };
}

/**
 * The first stored event for a clientSessionId is immutable. A push that
 * replays an id with different values is rejected whole: half-applying a
 * batch would let a client keep a conflicted id queued forever.
 */
export function sessionConflictResponse(conflictingSessionIds: readonly string[]): SyncFailure {
  return {
    status: 409,
    body: {
      success: false,
      code: 'session_conflict',
      error: 'clientSessionId already stored with different values',
      conflictingSessionIds: [...conflictingSessionIds],
    },
  };
}

/**
 * Explicit seam for Pro push/collections (a later task). Every plan-aware
 * surface fails closed here with one shape rather than silently downgrading a
 * Pro account to the Free projection.
 */
export function proPlanNotImplementedResponse(plan: ReadingPlan = 'pro'): SyncFailure {
  return {
    status: 501,
    body: {
      success: false,
      code: 'pro_plan_not_implemented',
      plan,
      error: 'pro reading sync is not implemented yet',
    },
  };
}

export function buildFreePushResponse(input: {
  stats: FreeStats;
  serverNow: number;
  appliedSessions: number;
  acceptedSessionIds: readonly string[];
}): FreeReadingSyncPushResponse {
  return {
    success: true,
    plan: 'free',
    serverNow: input.serverNow,
    applied: { sessions: input.appliedSessions },
    // Acknowledged ids cover both outcomes on purpose: `applied.sessions`
    // counts only the rows this request created, so an identical retry is a
    // success that reports 0 applied instead of double-counting the event.
    acceptedSessionIds: [...input.acceptedSessionIds],
    stats: freeProjection(input.stats),
  };
}

/** Free pull carries the derived projection only — never raw rows. */
export function buildFreePullResponse(stats: FreeStats): FreeReadingSyncPullResponse {
  return { success: true, plan: 'free', stats: freeProjection(stats) };
}

export const projectFreeStats = freeProjection;
export { freeProjection };
