import { describe, expect, it } from 'vitest';
import {
  COMPLETION_THRESHOLD,
  FREE_SESSION_KEYS,
  FREE_STATS_KEYS,
  MAX_COLLECTION_ROWS,
  MAX_SESSIONS_PER_PUSH,
  PRO_SESSION_KEYS,
  PRO_STATS_KEYS,
  ReadingSyncContractError,
  freeProjection,
  freeReadingSyncPullResponseSchema,
  freeReadingSyncPushResponseSchema,
  freeReadingSyncPushSchema,
  freeReadingSyncPullSchema,
  freeSessionSchema,
  parseFreeSession,
  parseProSession,
  proProjection,
  proReadingSyncPullResponseSchema,
  proReadingSyncPushResponseSchema,
  proReadingSyncPushSchema,
  proReadingSyncPullSchema,
  proSessionSchema,
  proStatsSchema,
  projectReadingStats,
  readingSyncPullResponseSchema,
  readingSyncPushResponseSchema,
} from './contracts.js';
import type {
  FreeReadingSyncPull,
  FreeReadingSyncPush,
  ProReadingSyncPull,
  ProReadingSyncPush,
} from './contracts.js';

/**
 * These type aliases mirror the app repository's request declarations. The
 * server test keeps a structural fixture so the two repositories stay
 * independently buildable while still checking the shared wire envelope.
 */
type AppSyncEnvelope = {
  syncVersion: 2;
  user: { externalId: string };
  deviceId?: string;
};
type AppFreeReadingSyncPush = AppSyncEnvelope & Pick<FreeReadingSyncPush, 'sessions'>;
type AppProReadingSyncPush = AppSyncEnvelope & Pick<
  ProReadingSyncPush,
  'sessions' | 'library' | 'history' | 'chapterStates' | 'novels'
>;
type AppFreeReadingSyncPull = AppSyncEnvelope;
type AppProReadingSyncPull = AppSyncEnvelope & Pick<ProReadingSyncPull, 'readingStats'>;

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

const validFreeStats = {
  level: 2,
  levelProgress: 0.25,
  totalSecondsRead: 83,
  uniqueInAppCompletedChapters: 1,
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
  mostReadNovels: [{
    novelId: '42',
    title: 'Example Novel',
    activeSeconds: 7545,
    words: 15120,
    chapters: 12,
  }],
  mostReadNovelsTruncated: false,
  completedNovels: [{ novelId: '42', title: 'Example Novel' }],
};

const validFreePush = {
  syncVersion: 2 as const,
  user: { externalId: 'subject-1' },
  sessions: [validFreeSession],
} satisfies AppFreeReadingSyncPush & FreeReadingSyncPush;

const validProPush = {
  syncVersion: 2 as const,
  user: { externalId: 'subject-1' },
  sessions: [validProSession],
  library: [],
  history: [],
  chapterStates: [],
  novels: [],
} satisfies AppProReadingSyncPush & ProReadingSyncPush;

const validFreePull = {
  syncVersion: 2 as const,
  user: { externalId: 'subject-1' },
} satisfies AppFreeReadingSyncPull & FreeReadingSyncPull;

const validProPull = {
  syncVersion: 2 as const,
  user: { externalId: 'subject-1' },
  readingStats: {
    libraryCursor: null,
    historyCursor: null,
    sessionCursor: null,
    year: 2026,
  },
} satisfies AppProReadingSyncPull & ProReadingSyncPull;

const validLibraryRow = {
  novelId: '42',
  sourceId: 'site:example',
  categoryIds: ['currently_reading'],
  lastReadChapterId: 7,
  lastReadChapterNumber: 7,
  lastReadChapterTitle: 'The Road',
  progressPercent: 91,
  lastReadAt: '2026-09-25T10:00:00.000Z',
  addedAt: '2026-09-20T10:00:00.000Z',
  updatedAt: 1782470400000,
  deletedAt: null,
};

const validHistoryRow = {
  novelId: '42',
  novelTitle: 'Example Novel',
  novelAuthor: 'Author',
  category: 'Fantasy',
  sourceId: 'site:example',
  chapterId: 7,
  chapterNumber: 7,
  chapterTitle: 'The Road',
  progressPercent: 91,
  readDay: '2026-09-25',
  readAt: 1782470400000,
  updatedAt: 1782470400000,
};

const validFreePushResponse = {
  success: true as const,
  plan: 'free' as const,
  serverNow: 1782470501000,
  applied: { sessions: 1 },
  acceptedSessionIds: [validFreeSession.clientSessionId],
  stats: validFreeStats,
};

const validProPushResponse = {
  success: true as const,
  plan: 'pro' as const,
  serverNow: 1782470501000,
  applied: {
    sessions: 1,
    library: 1,
    history: 1,
    chapterStates: 1,
    novels: 1,
  },
  acceptedSessionIds: [validProSession.clientSessionId],
  stats: validProStats,
};

const validFreePullResponse = {
  success: true as const,
  plan: 'free' as const,
  stats: validFreeStats,
};

const validProPullResponse = {
  success: true as const,
  plan: 'pro' as const,
  library: { rows: [validLibraryRow], nextCursor: null },
  history: { rows: [validHistoryRow], nextCursor: 'history-cursor' },
  sessions: { rows: [validProSession], nextCursor: null },
  stats: validProStats,
};

function expectExactKeys(value: object, expected: readonly string[]) {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

describe('reading sync v2 contracts', () => {
  it('pins the exact session and statistics allowlists', () => {
    expect(FREE_SESSION_KEYS).toEqual([
      'clientSessionId',
      'novelId',
      'chapterId',
      'seconds',
      'progressPercent',
      'completed',
      'ts',
    ]);
    expect(PRO_SESSION_KEYS).toEqual([
      'clientSessionId',
      'novelId',
      'chapterId',
      'seconds',
      'progressPercent',
      'completed',
      'ts',
      'words',
      'minuteOfDay',
      'readDay',
      'genre',
    ]);
    expect(FREE_STATS_KEYS).toEqual([
      'level',
      'levelProgress',
      'totalSecondsRead',
      'uniqueInAppCompletedChapters',
    ]);
    expect(PRO_STATS_KEYS).toEqual([
      'asOfDay',
      'level',
      'tier',
      'levelProgress',
      'remainingTime',
      'totalSecondsRead',
      'currentStreakDays',
      'longestStreakDays',
      'totalWords',
      'averageWPM',
      'uniqueInAppCompletedChapters',
      'combinedTotalChaptersCompleted',
      'last7DaysActivity',
      'yearlyActivity',
      'hourlyDistribution',
      'genreDistribution',
      'mostReadNovels',
      'mostReadNovelsTruncated',
      'completedNovels',
    ]);

    expectExactKeys(validFreeSession, FREE_SESSION_KEYS);
    expectExactKeys(validProSession, PRO_SESSION_KEYS);
    expectExactKeys(validFreeStats, FREE_STATS_KEYS);
    expectExactKeys(validProStats, PRO_STATS_KEYS);
  });
  describe('Free and Pro session validation', () => {
    it('normalizes numeric novel IDs and accepts a Free session', () => {
      const parsed = parseFreeSession({ ...validFreeSession, novelId: 42 });
      expect(parsed.novelId).toBe('42');
    });

    it.each([
      { progressPercent: 84, completed: false },
      { progressPercent: COMPLETION_THRESHOLD, completed: true },
      { progressPercent: 100, completed: true },
    ])('accepts the completion boundary %o', (override) => {
      expect(parseFreeSession({ ...validFreeSession, ...override })).toMatchObject(override);
      expect(parseProSession({ ...validProSession, ...override })).toMatchObject(override);
    });

    it.each([
      { progressPercent: 84, completed: true },
      { progressPercent: 85, completed: false },
      { progressPercent: 100, completed: false },
    ])('rejects a completion/progress mismatch: %o', (override) => {
      expect(() => parseFreeSession({ ...validFreeSession, ...override }))
        .toThrow('completion_mismatch');
      expect(() => parseProSession({ ...validProSession, ...override }))
        .toThrow('completion_mismatch');
    });

    it('accepts a zero-second completion only when words are zero', () => {
      const zeroSecondCompletion = {
        seconds: 0,
        words: 0,
        progressPercent: 100,
        completed: true,
      };

      expect(parseProSession({ ...validProSession, ...zeroSecondCompletion }))
        .toMatchObject(zeroSecondCompletion);
      expect(() => parseProSession({
        ...validProSession,
        ...zeroSecondCompletion,
        words: 1,
      })).toThrow('implausible_word_count');
    });

    it('enforces floor(1000 * seconds / 60) on Pro words', () => {
      expect(proSessionSchema.safeParse({ ...validProSession, seconds: 3, words: 50 }).success).toBe(true);
      expect(proSessionSchema.safeParse({ ...validProSession, seconds: 3, words: 51 }).success).toBe(false);
      expect(proSessionSchema.safeParse({ ...validProSession, seconds: 60, words: 1000 }).success).toBe(true);
      expect(proSessionSchema.safeParse({ ...validProSession, seconds: 60, words: 1001 }).success).toBe(false);
    });

    it('reports an implausible Pro word count as a structured contract error', () => {
      try {
        parseProSession({ ...validProSession, seconds: 60, words: 1001 });
        throw new Error('expected parser to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ReadingSyncContractError);
        expect((error as ReadingSyncContractError).code).toBe('implausible_word_count');
      }
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

    it('rejects privacy and unknown fields at their strict object boundary', () => {
      expect(freeSessionSchema.safeParse({ ...validFreeSession, unexpected: true }).success).toBe(false);
      expect(() => parseFreeSession({ ...validFreeSession, unexpected: true })).toThrow('unknown_key');
      for (const field of ['content', 'cover', 'coverUrl', 'filePath', 'scrollY']) {
        expect(proSessionSchema.safeParse({ ...validProSession, [field]: 'private' }).success).toBe(false);
      }
      expect(proStatsSchema.safeParse({ ...validProStats, content: 'private' }).success).toBe(false);
    });
  });

  describe('numeric and batch boundaries', () => {
    it('rejects invalid Free numeric values', () => {
      const invalidSessions: Record<string, unknown>[] = [
        { clientSessionId: '_starts-with-punctuation' },
        { novelId: 'x'.repeat(101) },
        { chapterId: 0 },
        { chapterId: 1.5 },
        { chapterId: Number.MAX_SAFE_INTEGER + 1 },
        { seconds: -1 },
        { seconds: 86_401 },
        { seconds: 1.5 },
        { seconds: Number.NaN },
        { seconds: Number.POSITIVE_INFINITY },
        { progressPercent: -1 },
        { progressPercent: 101 },
        { progressPercent: Number.NaN },
        { progressPercent: Number.NEGATIVE_INFINITY },
        { completed: 'true' },
        { ts: -1 },
        { ts: 1.5 },
        { ts: Number.NaN },
        { ts: Number.POSITIVE_INFINITY },
      ];

      for (const override of invalidSessions) {
        expect(() => parseFreeSession({ ...validFreeSession, ...override })).toThrow();
      }
    });

    it('rejects invalid Pro numeric and date values', () => {
      const invalidSessions: Record<string, unknown>[] = [
        { words: -1 },
        { words: 1_000_001 },
        { words: 1.5 },
        { words: Number.NaN },
        { words: Number.POSITIVE_INFINITY },
        { minuteOfDay: -1 },
        { minuteOfDay: 1440 },
        { minuteOfDay: 1.5 },
        { readDay: '2026-02-30' },
        { genre: 'x'.repeat(101) },
      ];

      for (const override of invalidSessions) {
        expect(() => parseProSession({ ...validProSession, ...override })).toThrow();
      }
    });

    it('accepts 500 and rejects 501 session rows', () => {
      const sessionsAtLimit = Array.from({ length: MAX_SESSIONS_PER_PUSH }, (_, index) => ({
        ...validFreeSession,
        clientSessionId: `session-${index}`,
      }));
      const sessionsOverLimit = [...sessionsAtLimit, {
        ...validFreeSession,
        clientSessionId: `session-${MAX_SESSIONS_PER_PUSH}`,
      }];

      expect(freeReadingSyncPushSchema.safeParse({ ...validFreePush, sessions: sessionsAtLimit }).success).toBe(true);
      expect(freeReadingSyncPushSchema.safeParse({ ...validFreePush, sessions: sessionsOverLimit }).success).toBe(false);
      expect(proReadingSyncPushSchema.safeParse({
        ...validProPush,
        sessions: sessionsAtLimit.map((session) => ({ ...validProSession, ...session, words: 1 })),
      }).success).toBe(true);
      expect(proReadingSyncPushSchema.safeParse({
        ...validProPush,
        sessions: [
          ...sessionsAtLimit.map((session) => ({ ...validProSession, ...session, words: 1 })),
          { ...validProSession, clientSessionId: `pro-${MAX_SESSIONS_PER_PUSH}`, words: 1 },
        ],
      }).success).toBe(false);
    });

    it('accepts 500 and rejects 501 rows in every Pro collection', () => {
      const collectionRows = {
        library: validLibraryRow,
        history: validHistoryRow,
        chapterStates: {
          novelId: '42',
          chapterId: 7,
          isRead: true,
          origin: 'manual' as const,
          updatedAt: 1782470400000,
        },
        novels: {
          novelId: '42',
          title: 'Example Novel',
          genre: 'Fantasy',
          totalChapters: 12,
          updatedAt: 1782470400000,
        },
      };

      for (const [key, row] of Object.entries(collectionRows)) {
        expect(proReadingSyncPushSchema.safeParse({
          ...validProPush,
          [key]: Array.from({ length: MAX_COLLECTION_ROWS }, () => row),
        }).success).toBe(true);
        expect(proReadingSyncPushSchema.safeParse({
          ...validProPush,
          [key]: Array.from({ length: MAX_COLLECTION_ROWS + 1 }, () => row),
        }).success).toBe(false);
      }
    });
  });

  describe('statistics projections', () => {
    it('accepts the complete Pro statistics shape with integer aggregate percentages', () => {
      expect(proStatsSchema.parse(validProStats)).toEqual(validProStats);
      expect(proStatsSchema.safeParse({ ...validProStats, yearlyActivity: { invalid: 1 } }).success).toBe(false);
      expect(proStatsSchema.safeParse({ ...validProStats, averageWPM: 120.5 }).success).toBe(false);
      expect(proStatsSchema.safeParse({ ...validProStats, averageWPM: 1001 }).success).toBe(false);
      expect(proStatsSchema.safeParse({ ...validProStats, genreDistribution: { Fantasy: 99.5 } }).success).toBe(false);
      expect(proStatsSchema.safeParse({ ...validProStats, genreDistribution: { Fantasy: 101 } }).success).toBe(false);
    });

    it('requires both remaining-time values to be null only at level 50', () => {
      const maxLevelStats = {
        ...validProStats,
        level: 50,
        tier: 5,
        levelProgress: 1,
        remainingTime: { seconds: null, minutes: null },
      };
      expect(proStatsSchema.parse(maxLevelStats)).toEqual(maxLevelStats);
      expect(proStatsSchema.safeParse({
        ...maxLevelStats,
        remainingTime: { seconds: 1, minutes: 0 },
      }).success).toBe(false);
      expect(proStatsSchema.safeParse({
        ...maxLevelStats,
        remainingTime: { seconds: null, minutes: 0 },
      }).success).toBe(false);
      expect(proStatsSchema.safeParse({
        ...validProStats,
        remainingTime: { seconds: null, minutes: null },
      }).success).toBe(false);
    });

    it('projects valid Free/Free and Pro/Pro statistics', () => {
      expect(projectReadingStats('free', validFreeStats)).toEqual(validFreeStats);
      expect(projectReadingStats('pro', validProStats)).toEqual(validProStats);
    });

    it('rejects invalid plan/stat pairings at runtime', () => {
      const callProjectReadingStats = (plan: string, input: unknown) =>
        Reflect.apply(projectReadingStats, undefined, [plan, input]);

      expect(() => callProjectReadingStats('pro', validFreeStats))
        .toThrow(ReadingSyncContractError);
      expect(() => callProjectReadingStats('free', validProStats))
        .toThrow(ReadingSyncContractError);
    });

    it('keeps invalid plan/stat pairings out of the public overloads', () => {
      if (false) {
        // @ts-expect-error Pro projection requires ProStats.
        projectReadingStats('pro', validFreeStats);
        // @ts-expect-error Free projection requires FreeStats.
        projectReadingStats('free', validProStats);
      }
    });

    it('projects Free stats to exactly the four allowlisted keys', () => {
      const projection = freeProjection({ ...validProStats, ...validFreeStats });
      expect(projection).toEqual(validFreeStats);
      expectExactKeys(projection, FREE_STATS_KEYS);
    });

    it('omits every Pro aggregate key from a Free projection', () => {
      const projected = freeProjection(validProStats);
      const freeStatsKeys = new Set<string>(FREE_STATS_KEYS);
      for (const key of PRO_STATS_KEYS.filter((key) => !freeStatsKeys.has(key))) {
        expect(projected).not.toHaveProperty(key);
      }
    });

    it('projects Pro stats to the complete allowlist without leaking unknown keys', () => {
      const statsWithUnknownKey = { ...validProStats, unexpected: 'must-not-leak' };
      const projected = proProjection(statsWithUnknownKey);
      expect(projected).toEqual(validProStats);
      expectExactKeys(projected, PRO_STATS_KEYS);
    });
  });

  describe('strict push and pull envelopes', () => {
    it('accepts app-valid Free and Pro push and pull envelopes', () => {
      expect(freeReadingSyncPushSchema.parse(validFreePush)).toEqual(validFreePush);
      expect(proReadingSyncPushSchema.parse(validProPush)).toEqual(validProPush);
      expect(freeReadingSyncPullSchema.parse(validFreePull)).toEqual(validFreePull);
      expect(proReadingSyncPullSchema.parse(validProPull)).toEqual(validProPull);
    });

    it('rejects Free top-level Pro collections and client-supplied plans', () => {
      for (const collection of ['library', 'history', 'chapterStates', 'novels']) {
        const result = freeReadingSyncPushSchema.safeParse({ ...validFreePush, [collection]: [] });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues[0]?.message).toBe('pro_fields_not_allowed');
        expect(freeReadingSyncPullSchema.safeParse({ ...validFreePull, [collection]: [] }).success).toBe(false);
      }
      expect(freeReadingSyncPushSchema.safeParse({ ...validFreePush, plan: 'pro' }).success).toBe(false);
      expect(freeReadingSyncPushSchema.safeParse({ ...validFreePush, syncVersion: 1 }).success).toBe(false);
      expect(proReadingSyncPullSchema.safeParse({ ...validProPull, plan: 'free' }).success).toBe(false);
    });

    it('accepts exact Free and Pro push response envelopes', () => {
      expect(freeReadingSyncPushResponseSchema.parse(validFreePushResponse)).toEqual(validFreePushResponse);
      expect(proReadingSyncPushResponseSchema.parse(validProPushResponse)).toEqual(validProPushResponse);
      expect(readingSyncPushResponseSchema.parse(validFreePushResponse)).toEqual(validFreePushResponse);
      expect(readingSyncPushResponseSchema.parse(validProPushResponse)).toEqual(validProPushResponse);
      expectExactKeys(validFreePushResponse, [
        'success',
        'plan',
        'serverNow',
        'applied',
        'acceptedSessionIds',
        'stats',
      ]);
      expectExactKeys(validProPushResponse, [
        'success',
        'plan',
        'serverNow',
        'applied',
        'acceptedSessionIds',
        'stats',
      ]);
      expectExactKeys(validFreePushResponse.applied, ['sessions']);
      expectExactKeys(validProPushResponse.applied, [
        'sessions',
        'library',
        'history',
        'chapterStates',
        'novels',
      ]);
    });

    it('rejects cross-plan push responses and non-exact response keys', () => {
      expect(readingSyncPushResponseSchema.safeParse({
        ...validFreePushResponse,
        stats: validProStats,
      }).success).toBe(false);
      expect(readingSyncPushResponseSchema.safeParse({
        ...validProPushResponse,
        stats: validFreeStats,
      }).success).toBe(false);
      expect(freeReadingSyncPushResponseSchema.safeParse({
        ...validFreePushResponse,
        applied: { sessions: 1, library: 0 },
      }).success).toBe(false);
      expect(proReadingSyncPushResponseSchema.safeParse({
        ...validProPushResponse,
        applied: { sessions: 1, library: 0, history: 0, chapterStates: 0 },
      }).success).toBe(false);
      expect(freeReadingSyncPushResponseSchema.safeParse({
        ...validFreePushResponse,
        library: { rows: [], nextCursor: null },
      }).success).toBe(false);
      expect(proReadingSyncPushResponseSchema.safeParse({
        ...validProPushResponse,
        unknown: true,
      }).success).toBe(false);
    });

    it('accepts exact Free and Pro pull response envelopes and Pro page objects', () => {
      expect(freeReadingSyncPullResponseSchema.parse(validFreePullResponse)).toEqual(validFreePullResponse);
      expect(proReadingSyncPullResponseSchema.parse(validProPullResponse)).toEqual(validProPullResponse);
      expect(readingSyncPullResponseSchema.parse(validFreePullResponse)).toEqual(validFreePullResponse);
      expect(readingSyncPullResponseSchema.parse(validProPullResponse)).toEqual(validProPullResponse);
      expectExactKeys(validFreePullResponse, ['success', 'plan', 'stats']);
      expectExactKeys(validProPullResponse, ['success', 'plan', 'library', 'history', 'sessions', 'stats']);
      for (const page of [validProPullResponse.library, validProPullResponse.history, validProPullResponse.sessions]) {
        expectExactKeys(page, ['rows', 'nextCursor']);
      }
    });

    it('rejects cross-plan pull responses, omitted Pro pages, and unknown page keys', () => {
      expect(readingSyncPullResponseSchema.safeParse({
        ...validFreePullResponse,
        stats: validProStats,
      }).success).toBe(false);
      expect(readingSyncPullResponseSchema.safeParse({
        ...validProPullResponse,
        stats: validFreeStats,
      }).success).toBe(false);
      const { history: omittedHistory, ...proWithoutHistory } = validProPullResponse;
      expect(proReadingSyncPullResponseSchema.safeParse(proWithoutHistory).success).toBe(false);
      for (const key of ['library', 'history', 'sessions', 'chapterStates']) {
        expect(freeReadingSyncPullResponseSchema.safeParse({
          ...validFreePullResponse,
          [key]: { rows: [], nextCursor: null },
        }).success).toBe(false);
      }
      expect(proReadingSyncPullResponseSchema.safeParse({
        ...validProPullResponse,
        library: { rows: [], nextCursor: null, hasMore: false },
      }).success).toBe(false);
      expect(proReadingSyncPullResponseSchema.safeParse({
        ...validProPullResponse,
        serverNow: 1782470501000,
      }).success).toBe(false);
    });

    it('enforces the 500-row response page limit', () => {
      const sessionsAtLimit = Array.from({ length: MAX_COLLECTION_ROWS }, (_, index) => ({
        ...validProSession,
        clientSessionId: `page-session-${index}`,
      }));
      expect(proReadingSyncPullResponseSchema.safeParse({
        ...validProPullResponse,
        sessions: { rows: sessionsAtLimit, nextCursor: null },
      }).success).toBe(true);
      expect(proReadingSyncPullResponseSchema.safeParse({
        ...validProPullResponse,
        sessions: {
          rows: [...sessionsAtLimit, {
            ...validProSession,
            clientSessionId: `page-session-${MAX_COLLECTION_ROWS}`,
          }],
          nextCursor: null,
        },
      }).success).toBe(false);
    });
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
