import { z } from 'zod';

// ==========================================
// Achievement unlock deltas (client-evaluated, cosmetic v1).
//
// The client evaluates thresholds locally and pushes tiny deltas; the server
// only stores them. Conflicts merge MIN(firstSeenAt) / MAX(level), and the
// higher catalogVersion wins on mismatch. No server-side evaluation here.
// ==========================================

export const MAX_UNLOCKS_PER_PUSH = 500;
export const MAX_ACHIEVEMENT_ID_LENGTH = 100;

export const unlockDeltaSchema = z.object({
  achievementId: z.string().trim().min(1).max(MAX_ACHIEVEMENT_ID_LENGTH),
  level: z.number().int().min(2).max(6),
  firstSeenAt: z.number().int().safe().nonnegative(),
  catalogVersion: z.number().int().safe().nonnegative(),
});

export type UnlockDelta = z.infer<typeof unlockDeltaSchema>;

export const unlockPushSchema = z.object({
  user: z.object({ externalId: z.string().trim().min(1).max(255) }),
  unlocks: z.array(unlockDeltaSchema).max(MAX_UNLOCKS_PER_PUSH),
});

export const unlockPullSchema = z.object({
  user: z.object({ externalId: z.string().trim().min(1).max(255) }),
});

export type UnlockPush = z.infer<typeof unlockPushSchema>;
export type UnlockPull = z.infer<typeof unlockPullSchema>;

export function parseUnlockPush(input: unknown): UnlockPush {
  return unlockPushSchema.parse(input);
}

export function parseUnlockPull(input: unknown): UnlockPull {
  return unlockPullSchema.parse(input);
}

/**
 * Merge one incoming delta into a stored row: earliest firstSeen wins,
 * highest level wins, highest catalog wins.
 */
export function mergeUnlockDelta(existing: UnlockDelta, incoming: UnlockDelta): UnlockDelta {
  return {
    achievementId: existing.achievementId,
    level: Math.max(existing.level, incoming.level),
    firstSeenAt: Math.min(existing.firstSeenAt, incoming.firstSeenAt),
    catalogVersion: Math.max(existing.catalogVersion, incoming.catalogVersion),
  };
}

/** Merge two unlock lists by achievementId with MIN/MAX semantics. */
export function mergeUnlockLists(local: UnlockDelta[], remote: UnlockDelta[]): UnlockDelta[] {
  const byId = new Map<string, UnlockDelta>();
  for (const delta of [...local, ...remote]) {
    const prior = byId.get(delta.achievementId);
    byId.set(delta.achievementId, prior ? mergeUnlockDelta(prior, delta) : { ...delta });
  }
  return [...byId.values()];
}

/** Collapse a push batch to one delta per id (same MIN/MAX rule). */
export function collapseUnlockBatch(deltas: UnlockDelta[]): UnlockDelta[] {
  return mergeUnlockLists([], deltas);
}
