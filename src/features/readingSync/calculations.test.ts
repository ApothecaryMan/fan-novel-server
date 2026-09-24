import { describe, expect, it } from 'vitest';
import {
  FREE_STATS_KEYS,
  ReadingSyncContractError,
  freeProjection,
  freePushSchema,
  freeSessionSchema,
  parseFreeSession,
  proProjection,
  proSessionSchema,
} from './contracts.js';

const validFreeSession = {
  clientSessionId: 'm-abc123-7',
  novelId: '42',
  chapterId: 7,
  seconds: 83,
  progressPercent: 91,
  completed: true,
  ts: 1782470400000,
};

const validProSession = {
  ...validFreeSession,
  words: 168,
  minuteOfDay: 1380,
  readDay: '2026-09-25',
  genre: 'Fantasy',
};

const validProStats = {
  asOfDay: '2026-09-25',
  level: 2,
  tier: 1,
  levelProgress: 0.54,
  remainingTime: { seconds: 3255, minutes: 55 },
  totalSecondsRead: 7545,
  currentStreakDays: 1,
  longestStreakDays: 1,
  totalWords: 15120,
  averageWPM: 120,
  uniqueInAppCompletedChapters: 12,
  combinedTotalChaptersCompleted: 14,
  last7DaysActivity: Array.from({ length: 7 }, (_, index) => ({
    date: `2026-09-${String(19 + index).padStart(2, '0')}`,
    activeSeconds: index === 6 ? 7545 : 0,
  })),
  yearlyActivity: { '2026-09-25': 7545 },
  hourlyDistribution: Array.from({ length: 24 }, (_, index) => (index === 23 ? 7545 : 0)),
  genreDistribution: { Fantasy: 100 },
  mostReadNovels: [{ novelId: '42', title: 'Example Novel', activeSeconds: 7545, words: 15120, chapters: 12 }],
  mostReadNovelsTruncated: false,
  completedNovels: [{ novelId: '42', title: 'Example Novel' }],
};

describe('reading sync v2 contracts', () => {
  it('projects Free stats to exactly the four allowlisted keys', () => {
    const projection = freeProjection({
      ...validProStats,
      level: 3,
      levelProgress: 0.4,
      totalSecondsRead: 100,
      uniqueInAppCompletedChapters: 2,
    });

    expect(projection).toEqual({
      level: 3,
      levelProgress: 0.4,
      totalSecondsRead: 100,
      uniqueInAppCompletedChapters: 2,
    });
    expect(Object.keys(projection).sort()).toEqual([...FREE_STATS_KEYS].sort());
    expect(projection).not.toHaveProperty('tier');
    expect(projection).not.toHaveProperty('totalWords');
    expect(projection).not.toHaveProperty('combinedTotalChaptersCompleted');
  });

  it('normalizes numeric novel IDs and accepts a Free session', () => {
    const parsed = parseFreeSession({ ...validFreeSession, novelId: 42 });
    expect(parsed.novelId).toBe('42');
  });

  it.each([
    'words',
    'minuteOfDay',
    'readDay',
    'genre',
    'fullWords',
    'scrollY',
    'content',
    'cover',
    'filePath',
    'level',
  ])('rejects the Free-only forbidden field %s', (field) => {
    expect(() => parseFreeSession({ ...validFreeSession, [field]: field === 'words' ? 10 : 'x' }))
      .toThrow('pro_fields_not_allowed');
  });

  it('rejects unknown Free envelope collections instead of stripping them', () => {
    expect(freeSessionSchema.safeParse({ ...validFreeSession, unexpected: true }).success).toBe(false);
    expect(() => parseFreeSession({ ...validFreeSession, unexpected: true })).toThrow('unknown_key');
    const envelope = { syncVersion: 2 as const, user: { externalId: 'subject-1' }, sessions: [] };
    for (const collection of ['library', 'history', 'chapterStates', 'novels']) {
      const result = freePushSchema.safeParse({ ...envelope, [collection]: [] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toBe('pro_fields_not_allowed');
    }
  });

  it.each([
    { progressPercent: 80, completed: true },
    { progressPercent: 85, completed: false },
  ])('rejects a completion/progress mismatch: %o', (override) => {
    expect(() => parseFreeSession({ ...validFreeSession, ...override })).toThrow('completion_mismatch');
  });

  it('enforces the core ID, range, finite-number, and v2 version boundaries', () => {
    const invalidSessions = [
      { clientSessionId: '_starts-with-punctuation' },
      { novelId: 'x'.repeat(101) },
      { chapterId: 0 },
      { seconds: 86_401 },
      { progressPercent: 101 },
      { completed: 'true' },
      { ts: Number.POSITIVE_INFINITY },
      { ts: 1.5 },
    ];
    for (const override of invalidSessions) {
      expect(() => parseFreeSession({ ...validFreeSession, ...override })).toThrow();
    }
    const envelope = { syncVersion: 2 as const, user: { externalId: 'subject-1' }, sessions: [] };
    expect(freePushSchema.safeParse(envelope).success).toBe(true);
    expect(freePushSchema.safeParse({ ...envelope, plan: 'pro' }).success).toBe(false);
    expect(freePushSchema.safeParse({ ...envelope, syncVersion: 1 }).success).toBe(false);
  });

  it('rejects Pro fields in a Free session and accepts a complete Pro session', () => {
    expect(() => parseFreeSession({ ...validFreeSession, words: 10 })).toThrow('pro_fields_not_allowed');
    expect(proSessionSchema.safeParse({ ...validProSession, content: 'secret' }).success).toBe(false);
    expect(proSessionSchema.parse(validProSession)).toMatchObject(validProSession);
  });

  it('omits every Pro aggregate key from a Free projection', () => {
    const projected = freeProjection(validProStats);
    for (const key of ['tier', 'remainingTime', 'currentStreakDays', 'totalWords', 'averageWPM',
      'combinedTotalChaptersCompleted', 'last7DaysActivity', 'yearlyActivity',
      'hourlyDistribution', 'genreDistribution', 'mostReadNovels', 'completedNovels']) {
      expect(projected).not.toHaveProperty(key);
    }
  });

  it('projects Pro stats to the complete allowlist', () => {
    expect(proProjection({ ...validProStats, unexpected: 'must-not-leak' } as any))
      .toEqual(validProStats);
  });

  it('exposes a structured contract error for callers', () => {
    try {
      parseFreeSession({ ...validFreeSession, words: 1 });
      throw new Error('expected parser to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ReadingSyncContractError);
      expect((error as ReadingSyncContractError).code).toBe('pro_fields_not_allowed');
      expect((error as ReadingSyncContractError).issues[0]?.message).toBe('pro_fields_not_allowed');
    }
  });
});
