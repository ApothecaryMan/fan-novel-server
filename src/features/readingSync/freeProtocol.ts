import type { ContentfulStatusCode } from 'hono/utils/http-status';
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
//
// Every v2 rejection is built by `syncFailure()`, so the wire shape is exactly
// one thing: { success: false, code, error } plus the bounded detail a client
// needs to act (a capped issue list, the conflicting/accepted session ids, or
// the plan). The legacy v1 channel keeps its own historical bodies; these
// helpers are not used for it.
// ==========================================

/** How a push/pull body declared its protocol. */
export type SyncRequestChannel = 'legacy' | 'v2' | 'unsupported';

const LEGACY_SYNC_VERSION = 1;

/** Issue detail is a client aid, not a dump: cap it so a 500-row bad push
 *  cannot turn a 400 into an unbounded response. */
export const MAX_REPORTED_ISSUES = 20;

/** A stable, machine-readable reason. Clients branch on this, not on prose. */
export type SyncFailureCode =
  | ReadingSyncErrorCode
  | 'unsupported_sync_version'
  | 'session_conflict'
  | 'pro_plan_not_implemented'
  | 'plan_changed'
  | 'unauthorized'
  | 'forbidden'
  | 'account_not_found'
  | 'storage_unavailable'
  | 'sync_database_unavailable'
  | 'rate_limited';

export interface SyncIssueDetail {
  readonly path: string[];
  readonly message: string;
}

/**
 * Declared as a type alias on purpose: Hono's JSON responder only accepts
 * object *literal* types, which excludes interfaces (no implicit index
 * signature), so an `interface` here would force a cast at every call site.
 */
export type SyncFailureBody = {
  success: false;
  code: SyncFailureCode;
  error: string;
  issues?: readonly SyncIssueDetail[];
  conflictingSessionIds?: readonly string[];
  acceptedSessionIds?: readonly string[];
  plan?: ReadingPlan;
};

export interface SyncFailure {
  /** Narrowed to Hono's contentful statuses so a route never casts. */
  status: ContentfulStatusCode;
  body: SyncFailureBody;
}

/**
 * The single constructor for a v2 failure body. Optional detail is only
 * attached when it carries information, so the common rejections stay exactly
 * `{ success: false, code, error }`.
 */
export function syncFailure(
  status: ContentfulStatusCode,
  code: SyncFailureCode,
  error: string,
  detail: Omit<SyncFailureBody, 'success' | 'code' | 'error'> = {},
): SyncFailure {
  return { status, body: { success: false, code, error, ...detail } };
}

/**
 * Cap a reported issue list. The count of issues is what a client needs to size
 * its own retry, so it is reported next to the capped sample.
 */
export function capReportedIssues<T>(issues: readonly T[]): {
  issues: T[];
  issuesTruncated: boolean;
} {
  return {
    issues: issues.slice(0, MAX_REPORTED_ISSUES),
    issuesTruncated: issues.length > MAX_REPORTED_ISSUES,
  };
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
  return syncFailure(
    400,
    'unsupported_sync_version',
    `unsupported sync version; expected ${LEGACY_SYNC_VERSION} or ${READING_SYNC_VERSION}`,
  );
}

/** 401: no usable credential for a plan-aware surface. */
export function unauthorizedResponse(error: string): SyncFailure {
  return syncFailure(401, 'unauthorized', error);
}

/** 403: the token is valid but does not own the declared identity. */
export function ownerMismatchResponse(): SyncFailure {
  return syncFailure(403, 'forbidden', 'forbidden: token identity does not match user.externalId');
}

/** 401: the claimed identity has no stored account. */
export function accountNotFoundResponse(): SyncFailure {
  return syncFailure(401, 'account_not_found', 'account not found');
}

/** 503: storage could not answer. Never carries driver diagnostics. */
export function storageUnavailableResponse(): SyncFailure {
  return syncFailure(503, 'storage_unavailable', 'sync database unavailable');
}

/** 503: the deployment has no sync database configured at all. */
export function syncDatabaseUnavailableResponse(): SyncFailure {
  return syncFailure(503, 'sync_database_unavailable', 'sync database not configured');
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
  const { issues, issuesTruncated } = capReportedIssues(contractError.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)),
    message: issue.message,
  })));
  return syncFailure(
    status,
    code,
    status === 403 ? 'free plan does not accept pro reading fields' : 'invalid sync payload',
    {
      ...(issues.length > 0 ? { issues } : {}),
      ...(issuesTruncated ? { issuesTruncated: true } : {}),
    },
  );
}

/**
 * The first stored event for a clientSessionId is immutable. A push that
 * replays an id with different values is rejected whole: half-applying a
 * batch would let a client keep a conflicted id queued forever.
 *
 * `conflictingSessionIds` is bounded by the contract limit
 * (MAX_SESSIONS_PER_PUSH), and `acceptedSessionIds` is reported only when the
 * batch actually created rows before losing an insert race: a conflict that is
 * knowable before the first write applies nothing and therefore reports no
 * accepted id. Reporting the raced rows keeps the semantics consistent — every
 * id either accepted or conflicting, and nothing stored is left unmentioned.
 */
export function sessionConflictResponse(
  conflictingSessionIds: readonly string[],
  acceptedSessionIds: readonly string[] = [],
): SyncFailure {
  return syncFailure(
    409,
    'session_conflict',
    'clientSessionId already stored with different values',
    {
      conflictingSessionIds: [...conflictingSessionIds],
      ...(acceptedSessionIds.length > 0 ? { acceptedSessionIds: [...acceptedSessionIds] } : {}),
    },
  );
}

/**
 * Explicit seam for Pro push/collections (a later task). Every plan-aware
 * surface fails closed here with one shape rather than silently downgrading a
 * Pro account to the Free projection.
 */
export function proPlanNotImplementedResponse(plan: ReadingPlan = 'pro'): SyncFailure {
  return syncFailure(501, 'pro_plan_not_implemented', 'pro reading sync is not implemented yet', { plan });
}

export function buildFreePushResponse(input: {
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
  };
}

/** Free pull carries the derived projection only — never raw rows. */
export function buildFreePullResponse(stats: FreeStats): FreeReadingSyncPullResponse {
  return { success: true, plan: 'free', stats: freeProjection(stats) };
}

export const projectFreeStats = freeProjection;
export { freeProjection };
