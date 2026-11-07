import { describe, expect, it } from 'vitest';
import {
  isLateSession,
  normalizeResetAt,
  partitionLateSessions,
  READING_CLOCK_SKEW_MS,
  type DeletionGate,
} from './freeStore.js';

const gate = (resetAt: number | null, tombstones: Array<[string, number]> = []): DeletionGate => ({
  resetAt,
  tombstones: new Map(tombstones),
});

describe('deletion gate (reset/tombstone late-upload filter)', () => {
  it('normalizes the reset marker', () => {
    expect(normalizeResetAt(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(normalizeResetAt(null)).toBeNull();
    expect(normalizeResetAt(-1)).toBeNull();
    expect(normalizeResetAt(Number.NaN)).toBeNull();
    expect(normalizeResetAt('x')).toBeNull();
  });

  it('drops only sessions strictly earlier than resetAt minus the clock skew', () => {
    const resetAt = 1_800_000_000_000;
    const g = gate(resetAt);
    // Exactly on the skew boundary counts as concurrent, not late.
    expect(isLateSession({ ts: resetAt - READING_CLOCK_SKEW_MS, novelId: '10' }, g)).toBe(false);
    expect(isLateSession({ ts: resetAt - READING_CLOCK_SKEW_MS - 1, novelId: '10' }, g)).toBe(true);
    expect(isLateSession({ ts: resetAt, novelId: '10' }, g)).toBe(false);
    expect(isLateSession({ ts: resetAt + 10_000, novelId: '10' }, g)).toBe(false);
    // Zero skew restores the exact comparison.
    expect(isLateSession({ ts: resetAt - 1, novelId: '10' }, g, 0)).toBe(true);
    expect(isLateSession({ ts: resetAt, novelId: '10' }, g, 0)).toBe(false);
  });

  it('applies the same skew rule to novel tombstones', () => {
    const deletedAt = 1_800_000_000_000;
    const g = gate(null, [['99', deletedAt]]);
    expect(isLateSession({ ts: deletedAt - READING_CLOCK_SKEW_MS, novelId: '99' }, g)).toBe(false);
    expect(isLateSession({ ts: deletedAt - READING_CLOCK_SKEW_MS - 1, novelId: '99' }, g)).toBe(true);
    // Other novels are unaffected by this tombstone.
    expect(isLateSession({ ts: deletedAt - READING_CLOCK_SKEW_MS - 1, novelId: '100' }, g)).toBe(false);
  });

  it('ignores malformed ts instead of dropping', () => {
    const g = gate(1_800_000_000_000);
    for (const ts of [Number.NaN, 1.5, 'x' as unknown as number]) {
      expect(isLateSession({ ts: ts as number, novelId: '10' }, g)).toBe(false);
    }
    // A negative safe-integer ts is not storable evidence either, but it is
    // certainly older than any reset marker, so it drains as late.
    expect(isLateSession({ ts: -5, novelId: '10' }, g)).toBe(true);
  });

  it('partitions a batch and lets a kept copy rescue a late duplicate id', () => {
    const g = gate(1_800_000_000_000);
    const sessions = [
      { clientSessionId: 'late-1', novelId: '10', ts: 1_000 },
      { clientSessionId: 'fresh-1', novelId: '10', ts: 1_900_000_000_000 },
      // Same id twice, one late copy one fresh copy: the fresh copy wins.
      { clientSessionId: 'both', novelId: '10', ts: 1_000 },
      { clientSessionId: 'both', novelId: '10', ts: 1_900_000_000_000 },
    ];
    const { kept, droppedIds } = partitionLateSessions(sessions, g);
    expect(kept.map((s) => s.clientSessionId).sort()).toEqual(['both', 'fresh-1']);
    expect(droppedIds).toEqual(['late-1']);
  });

  it('keeps everything when no gate is installed', () => {
    const sessions = [{ clientSessionId: 'a', novelId: '10', ts: 1 }];
    const { kept, droppedIds } = partitionLateSessions(sessions, gate(null));
    expect(kept).toHaveLength(1);
    expect(droppedIds).toHaveLength(0);
  });
});
