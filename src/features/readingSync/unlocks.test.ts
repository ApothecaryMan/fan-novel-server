import { describe, expect, it } from 'vitest';
import {
  collapseUnlockBatch,
  mergeUnlockDelta,
  mergeUnlockLists,
  unlockDeltaSchema,
} from './unlocks.js';

const delta = (overrides: Record<string, number | string> = {}) => ({
  achievementId: 'streak-7',
  level: 2,
  firstSeenAt: 1000,
  catalogVersion: 4,
  ...overrides,
});

describe('mergeUnlockDelta', () => {
  it('keeps the earliest firstSeenAt', () => {
    const merged = mergeUnlockDelta(delta({ firstSeenAt: 500 }), delta({ firstSeenAt: 900 }));
    expect(merged.firstSeenAt).toBe(500);
  });

  it('keeps the highest level', () => {
    const merged = mergeUnlockDelta(delta({ level: 2 }), delta({ level: 5 }));
    expect(merged.level).toBe(5);
  });

  it('keeps the higher catalogVersion on mismatch', () => {
    const merged = mergeUnlockDelta(delta({ catalogVersion: 3 }), delta({ catalogVersion: 4 }));
    expect(merged.catalogVersion).toBe(4);
  });

  it('reinstall merge never resets progress', () => {
    const local = delta({ level: 4, firstSeenAt: 200 });
    const server = delta({ level: 6, firstSeenAt: 800 });
    expect(mergeUnlockDelta(local, server)).toEqual(delta({ level: 6, firstSeenAt: 200 }));
  });
});

describe('mergeUnlockLists', () => {
  it('merges local and server lists by id with MIN/MAX', () => {
    const merged = mergeUnlockLists(
      [delta({ achievementId: 'a', level: 2, firstSeenAt: 300 })],
      [delta({ achievementId: 'a', level: 3, firstSeenAt: 100 }), delta({ achievementId: 'b' })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((u) => u.achievementId === 'a')).toEqual(delta({ achievementId: 'a', level: 3, firstSeenAt: 100 }));
  });
});

describe('collapseUnlockBatch', () => {
  it('collapses duplicate ids in one push with MIN/MAX', () => {
    const collapsed = collapseUnlockBatch([
      delta({ level: 2, firstSeenAt: 900 }),
      delta({ level: 4, firstSeenAt: 100 }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toEqual(delta({ level: 4, firstSeenAt: 100 }));
  });
});

describe('unlockDeltaSchema', () => {
  it('rejects level outside 2..6', () => {
    expect(unlockDeltaSchema.safeParse(delta({ level: 1 })).success).toBe(false);
    expect(unlockDeltaSchema.safeParse(delta({ level: 7 })).success).toBe(false);
    expect(unlockDeltaSchema.safeParse(delta({ level: 6 })).success).toBe(true);
  });

  it('rejects empty achievement ids', () => {
    expect(unlockDeltaSchema.safeParse(delta({ achievementId: '' })).success).toBe(false);
  });
});
