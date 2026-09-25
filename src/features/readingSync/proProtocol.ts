import {
  parseProReadingSyncPull,
  parseProReadingSyncPush,
  proProjection,
  type ProReadingSyncPull,
  type ProReadingSyncPullResponse,
  type ProReadingSyncPush,
  type ProReadingSyncPushResponse,
  type ProStats,
} from './contracts.js';

export function parseProV2Push(body: unknown): ProReadingSyncPush {
  return parseProReadingSyncPush(body);
}

export function parseProV2Pull(body: unknown): ProReadingSyncPull {
  return parseProReadingSyncPull(body);
}

export function buildProPushResponse(input: {
  stats: ProStats;
  serverNow: number;
  applied: {
    sessions: number;
    library: number;
    history: number;
    chapterStates: number;
    novels: number;
  };
  acceptedSessionIds: readonly string[];
}): ProReadingSyncPushResponse {
  return {
    success: true,
    plan: 'pro',
    serverNow: input.serverNow,
    applied: { ...input.applied },
    acceptedSessionIds: [...input.acceptedSessionIds],
    stats: proProjection(input.stats),
  };
}

export function projectProPullResponse(response: ProReadingSyncPullResponse): ProReadingSyncPullResponse {
  return {
    ...response,
    stats: proProjection(response.stats),
  };
}
