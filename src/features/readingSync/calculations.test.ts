import { describe, expect, it } from 'vitest';
import {
  COMPLETION_THRESHOLD,
  MAX_WPM,
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
import {
  MAX_LEVEL,
  calculateFreeStats,
  calculateProStats,
  getLevelFromSeconds,
} from './calculations.js';
import type {
  ProCalculationSession,
} from './calculations.js';

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

describe('pure reading statistics calculations', () => {
  const proSession = (overrides: Partial<ProCalculationSession> = {}): ProCalculationSession => ({
    seconds: 60,
    words: 100,
    novelId: 'novel-1',
    chapterId: 1,
    progressPercent: 0,
    completed: false,
    completionSignalPresent: true,
    minuteOfDay: 600,
    readDay: '2026-09-25',
    genre: '',
    proFieldsPresent: true,
    ...overrides,
  });

  it('uses the shared floor-minute level ladder and caps at level 50', () => {
    expect(getLevelFromSeconds(3599).level).toBe(1);
    expect(getLevelFromSeconds(3600).level).toBe(2);
    expect(getLevelFromSeconds(55 * 3600).level).toBe(11);
    expect(getLevelFromSeconds(1650 * 3600).level).toBe(MAX_LEVEL);
    expect(getLevelFromSeconds(1650 * 3600).progress).toBe(1);
    expect(getLevelFromSeconds(Number.MAX_SAFE_INTEGER).tier).toBe(5);
  });

  it('recognizes the 21, 31, and 41 tier-entry thresholds', () => {
    for (const [level, hours] of [[21, 165], [31, 385], [41, 825]] as const) {
      const thresholdSeconds = hours * 3600;
      expect(getLevelFromSeconds(thresholdSeconds - 60).level).toBe(level - 1);
      const atThreshold = getLevelFromSeconds(thresholdSeconds);
      expect(atThreshold.level).toBe(level);
      expect(atThreshold.isTierEntry).toBe(true);
    }
  });

  it('returns a deterministic empty Free projection and sums only accepted time', () => {
    const stats = calculateFreeStats([]);
    expect(stats).toEqual({
      level: 1,
      levelProgress: 0,
      totalSecondsRead: 0,
      uniqueInAppCompletedChapters: 0,
    });
    expect(Object.keys(stats)).toEqual([
      'level',
      'levelProgress',
      'totalSecondsRead',
      'uniqueInAppCompletedChapters',
    ]);
  });

  it('deduplicates Free completions, honors the 85 boundary, and excludes legacy markers', () => {
    const stats = calculateFreeStats([
      { seconds: 100, novelId: 1, chapterId: 1, progressPercent: 84, completed: false, completionSignalPresent: true },
      { seconds: 50, novelId: '1', chapterId: 1, progressPercent: 85, completed: true, completionSignalPresent: true },
      { seconds: 0, novelId: 'novel-2', chapterId: 4, progressPercent: 100, completed: true, completionSignalPresent: true },
      { seconds: 7, novelId: 'legacy', chapterId: 9, progressPercent: 100, completed: true, completionSignalPresent: false },
      { seconds: 11, novelId: 'signal-only', chapterId: 2, progressPercent: 85, completed: false, completionSignalPresent: true },
    ]);

    expect(stats.totalSecondsRead).toBe(168);
    expect(stats.uniqueInAppCompletedChapters).toBe(3);
    expect(stats).not.toHaveProperty('tier');
    expect(stats).not.toHaveProperty('totalWords');
  });

  it('returns every empty Pro field with seven zero days and 24 zero hours', () => {
    const stats = calculateProStats({
      sessions: [],
      chapterStates: [],
      novels: [],
      asOfDay: '2026-09-25',
    });

    expect(stats).toEqual({
      asOfDay: '2026-09-25',
      level: 1,
      tier: 1,
      levelProgress: 0,
      remainingTime: { seconds: 3600, minutes: 60 },
      totalSecondsRead: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      totalWords: 0,
      averageWPM: 0,
      uniqueInAppCompletedChapters: 0,
      combinedTotalChaptersCompleted: 0,
      last7DaysActivity: [
        { date: '2026-09-19', activeSeconds: 0 },
        { date: '2026-09-20', activeSeconds: 0 },
        { date: '2026-09-21', activeSeconds: 0 },
        { date: '2026-09-22', activeSeconds: 0 },
        { date: '2026-09-23', activeSeconds: 0 },
        { date: '2026-09-24', activeSeconds: 0 },
        { date: '2026-09-25', activeSeconds: 0 },
      ],
      yearlyActivity: {},
      hourlyDistribution: Array.from({ length: 24 }, () => 0),
      genreDistribution: {},
      mostReadNovels: [],
      mostReadNovelsTruncated: false,
      completedNovels: [],
    });
    expect(proStatsSchema.parse(stats)).toEqual(stats);
  });

  it('returns null remaining time at the exact level-50 threshold', () => {
    const stats = calculateProStats({
      sessions: [proSession({ seconds: 1500 * 3600, words: 0 })],
      asOfDay: '2026-09-25',
    });

    expect(stats.level).toBe(50);
    expect(stats.tier).toBe(5);
    expect(stats.remainingTime).toEqual({ seconds: null, minutes: null });
    expect(proStatsSchema.parse(stats)).toEqual(stats);
  });

  it('derives Pro totals, WPM, streaks, activity, hours, genres, and novel aggregates', () => {
    const stats = calculateProStats({
      sessions: [
        proSession({
          seconds: 3600,
          words: 600,
          novelId: 'novel-1',
          chapterId: 1,
          progressPercent: 90,
          completed: true,
          readDay: '2026-09-23',
          minuteOfDay: 60,
          genre: 'Fantasy',
        }),
        proSession({
          seconds: 60,
          words: 100,
          novelId: 'novel-1',
          chapterId: 1,
          progressPercent: 90,
          completed: true,
          readDay: '2026-09-24',
          minuteOfDay: 120,
          genre: 'Fantasy',
        }),
        proSession({
          seconds: 120,
          words: 200,
          novelId: 'novel-1',
          chapterId: 2,
          progressPercent: 90,
          completed: true,
          readDay: '2026-09-25',
          minuteOfDay: 600,
          genre: '',
        }),
        proSession({
          seconds: 120,
          words: 100,
          novelId: 'novel-2',
          chapterId: 1,
          progressPercent: 40,
          readDay: '2026-09-25',
          minuteOfDay: 1200,
          genre: 'Action',
        }),
        proSession({
          seconds: 0,
          words: 0,
          novelId: 'novel-3',
          chapterId: 1,
          progressPercent: 100,
          completed: true,
          readDay: '2026-09-25',
          minuteOfDay: 1439,
          genre: '',
        }),
        // Legacy rows still contribute Pro time/words, but never completion.
        proSession({
          seconds: 300,
          words: 50,
          novelId: 'legacy-novel',
          chapterId: 1,
          progressPercent: 100,
          completed: true,
          completionSignalPresent: false,
          proFieldsPresent: false,
          readDay: '2026-09-25',
          minuteOfDay: 0,
          genre: '',
        }),
      ],
      chapterStates: [
        { novelId: 'novel-1', chapterId: 2, isRead: true, origin: 'manual', updatedAt: 10 },
        { novelId: 'novel-2', chapterId: 2, isRead: true, origin: 'snapshot', updatedAt: 10 },
      ],
      novels: [
        { novelId: 'novel-1', title: 'First Novel', genre: 'Fantasy', totalChapters: 2, updatedAt: 10 },
        { novelId: 'novel-2', genre: 'Action', totalChapters: 5, updatedAt: 10 },
        { novelId: 'novel-3', title: 'Mystery Novel', genre: 'Mystery', totalChapters: 1, updatedAt: 10 },
        { novelId: 'unknown-total', totalChapters: null, updatedAt: 10 },
      ],
      year: 2026,
    }, '2026-09-25');

    expect(stats.level).toBe(2);
    expect(stats.tier).toBe(1);
    expect(stats.levelProgress).toBeCloseTo(1 / 12, 8);
    expect(stats.remainingTime).toEqual({ seconds: 6600, minutes: 110 });
    expect(stats.totalSecondsRead).toBe(4200);
    expect(stats.totalWords).toBe(1050);
    expect(stats.averageWPM).toBe(15);
    expect(stats.currentStreakDays).toBe(3);
    expect(stats.longestStreakDays).toBe(3);
    expect(stats.uniqueInAppCompletedChapters).toBe(3);
    expect(stats.combinedTotalChaptersCompleted).toBe(4);
    expect(stats.last7DaysActivity).toEqual([
      { date: '2026-09-19', activeSeconds: 0 },
      { date: '2026-09-20', activeSeconds: 0 },
      { date: '2026-09-21', activeSeconds: 0 },
      { date: '2026-09-22', activeSeconds: 0 },
      { date: '2026-09-23', activeSeconds: 3600 },
      { date: '2026-09-24', activeSeconds: 60 },
      { date: '2026-09-25', activeSeconds: 540 },
    ]);
    expect(stats.yearlyActivity).toEqual({
      '2026-09-23': 3600,
      '2026-09-24': 60,
      '2026-09-25': 540,
    });
    expect(stats.hourlyDistribution[0]).toBe(300);
    expect(stats.hourlyDistribution[1]).toBe(3600);
    expect(stats.hourlyDistribution[2]).toBe(60);
    expect(stats.hourlyDistribution[10]).toBe(120);
    expect(stats.hourlyDistribution[20]).toBe(120);
    expect(stats.hourlyDistribution[23]).toBe(0);
    expect(stats.genreDistribution).toEqual({ Action: 20, Fantasy: 60, Mystery: 20 });
    expect(stats.mostReadNovels).toEqual([
      { novelId: 'novel-1', activeSeconds: 3780, words: 900, chapters: 2, title: 'First Novel' },
      { novelId: 'legacy-novel', activeSeconds: 300, words: 50, chapters: 0 },
      { novelId: 'novel-2', activeSeconds: 120, words: 100, chapters: 0 },
      { novelId: 'novel-3', activeSeconds: 0, words: 0, chapters: 1, title: 'Mystery Novel' },
    ]);
    expect(stats.mostReadNovelsTruncated).toBe(false);
    expect(stats.completedNovels).toEqual([
      { novelId: 'novel-1', title: 'First Novel' },
      { novelId: 'novel-3', title: 'Mystery Novel' },
    ]);
    expect(proStatsSchema.parse(stats)).toEqual(stats);
  });

  it('caps aggregate WPM at the contract maximum', () => {
    const stats = calculateProStats({
      sessions: [proSession({ seconds: 60, words: 2000 })],
      asOfDay: '2026-09-25',
    });

    expect(stats.averageWPM).toBe(MAX_WPM);
    expect(proStatsSchema.parse(stats)).toEqual(stats);
  });

  it('orders equal-time most-read novels by normalized novel ID', () => {
    const stats = calculateProStats({
      sessions: [
        proSession({ novelId: 'novel-b', seconds: 60, words: 60 }),
        proSession({ novelId: 'novel-a', seconds: 60, words: 60 }),
      ],
      asOfDay: '2026-09-25',
    });

    expect(stats.mostReadNovels.map((novel) => novel.novelId)).toEqual([
      'novel-a',
      'novel-b',
    ]);
  });

  it('uses yesterday fallback and does not bridge streak gaps', () => {
    const stats = calculateProStats({
      sessions: [
        proSession({ readDay: '2026-09-25', seconds: 60, words: 60 }),
        proSession({ readDay: '2026-09-24', seconds: 60, words: 60 }),
        proSession({ readDay: '2026-09-22', seconds: 60, words: 60 }),
        proSession({ readDay: '2026-09-20', seconds: 60, words: 60 }),
      ],
      asOfDay: '2026-09-26',
    });
    expect(stats.currentStreakDays).toBe(2);
    expect(stats.longestStreakDays).toBe(2);
  });

  it('keeps zero-second completion days for streaks but never creates WPM', () => {
    const stats = calculateProStats({
      sessions: [proSession({
        seconds: 0,
        words: 0,
        progressPercent: 100,
        completed: true,
        readDay: '2026-09-25',
      })],
      asOfDay: '2026-09-25',
    });
    expect(stats.uniqueInAppCompletedChapters).toBe(1);
    expect(stats.averageWPM).toBe(0);
    expect(stats.currentStreakDays).toBe(1);
    expect(stats.last7DaysActivity.at(-1)).toEqual({ date: '2026-09-25', activeSeconds: 0 });
  });

  it('does not promote Free-origin default dimensions into Pro aggregates', () => {
    const stats = calculateProStats({
      sessions: [{
        seconds: 60,
        words: 999,
        novelId: 'free-origin',
        chapterId: 1,
        progressPercent: 100,
        completed: true,
        completionSignalPresent: true,
        proFieldsPresent: false,
        readDay: '2026-09-25',
        minuteOfDay: 600,
        genre: 'Fantasy',
      }],
      novels: [{ novelId: 'free-origin', genre: 'Fantasy' }],
      asOfDay: '2026-09-25',
    });

    expect(stats.totalSecondsRead).toBe(60);
    expect(stats.totalWords).toBe(0);
    expect(stats.averageWPM).toBe(0);
    expect(stats.currentStreakDays).toBe(0);
    expect(stats.yearlyActivity).toEqual({});
    expect(stats.hourlyDistribution).toEqual(Array.from({ length: 24 }, () => 0));
    expect(stats.genreDistribution).toEqual({});
  });

  it('keeps calendar labels stable across month boundaries and filters the requested year', () => {
    const stats = calculateProStats({
      sessions: [
        proSession({ readDay: '2026-03-08', seconds: 60, words: 60 }),
        proSession({ readDay: '2026-03-09', seconds: 60, words: 60 }),
        proSession({ readDay: '2025-12-31', seconds: 60, words: 60 }),
      ],
      year: 2026,
      asOfDay: '2026-03-09',
    });
    expect(stats.currentStreakDays).toBe(2);
    expect(stats.longestStreakDays).toBe(2);
    expect(stats.last7DaysActivity.map((day) => day.date)).toEqual([
      '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
      '2026-03-07', '2026-03-08', '2026-03-09',
    ]);
    expect(stats.yearlyActivity).toEqual({
      '2026-03-08': 60,
      '2026-03-09': 60,
    });
  });

  it('pads low-numbered years and keeps the lower date boundary contract-valid', () => {
    const yearNine = calculateProStats({
      sessions: [proSession({ readDay: '0009-01-01', seconds: 60, words: 60 })],
      year: 9,
      asOfDay: '0009-01-01',
    });
    expect(yearNine.yearlyActivity).toEqual({ '0009-01-01': 60 });
    expect(proStatsSchema.parse(yearNine)).toEqual(yearNine);

    const lowerBoundary = calculateProStats({
      sessions: [proSession({ readDay: '0001-01-01', seconds: 60, words: 60 })],
      year: 1,
      asOfDay: '0001-01-01',
    });
    expect(lowerBoundary.last7DaysActivity).toEqual([
      { date: '0001-01-01', activeSeconds: 0 },
      { date: '0001-01-01', activeSeconds: 0 },
      { date: '0001-01-01', activeSeconds: 0 },
      { date: '0001-01-01', activeSeconds: 0 },
      { date: '0001-01-01', activeSeconds: 0 },
      { date: '0001-01-01', activeSeconds: 0 },
      { date: '0001-01-01', activeSeconds: 60 },
    ]);
    expect(lowerBoundary.yearlyActivity).toEqual({ '0001-01-01': 60 });
    expect(proStatsSchema.parse(lowerBoundary)).toEqual(lowerBoundary);
  });

  it('gives explicit calculation options precedence over input and legacy year', () => {
    const input = {
      sessions: [
        proSession({ readDay: '2024-01-01', seconds: 60, words: 60 }),
        proSession({ readDay: '2025-01-01', seconds: 60, words: 60 }),
        proSession({ readDay: '2026-01-01', seconds: 60, words: 60 }),
      ],
      asOfDay: '2024-01-01',
      year: 2024,
    };

    const stats = calculateProStats(input, {
      asOfDay: '2026-01-01',
      year: 2026,
    }, 2025);
    expect(stats.asOfDay).toBe('2026-01-01');
    expect(stats.yearlyActivity).toEqual({ '2026-01-01': 60 });
    expect(proStatsSchema.parse(stats)).toEqual(stats);

    const legacyOptions = calculateProStats(input, '2025-01-01', 2025);
    expect(legacyOptions.asOfDay).toBe('2025-01-01');
    expect(legacyOptions.yearlyActivity).toEqual({ '2025-01-01': 60 });
  });

  it('merges complementary equal-timestamp novel metadata without losing fields', () => {
    const stats = calculateProStats({
      sessions: [proSession({ novelId: 'merged-novel', seconds: 60, words: 60 })],
      chapterStates: [{
        novelId: 'merged-novel',
        chapterId: 2,
        isRead: true,
        origin: 'manual',
        updatedAt: 10,
      }],
      novels: [
        {
          novelId: 'merged-novel',
          title: 'Merged Title',
          sourceId: 'site:merged',
          updatedAt: 10,
        },
        {
          novelId: 'merged-novel',
          genre: 'Fantasy',
          totalChapters: 1,
          sourceId: null,
          updatedAt: 10,
        },
      ],
      asOfDay: '2026-09-25',
    });

    expect(stats.mostReadNovels).toEqual([
      { novelId: 'merged-novel', title: 'Merged Title', activeSeconds: 60, words: 60, chapters: 0 },
    ]);
    expect(stats.genreDistribution).toEqual({ Fantasy: 100 });
    expect(stats.completedNovels).toEqual([{ novelId: 'merged-novel', title: 'Merged Title' }]);
  });

  it('rejects malformed rows marked as having Pro dimensions', () => {
    const malformed = {
      ...proSession(),
      words: undefined,
    } as unknown as ProCalculationSession;

    expect(() => calculateProStats({
      sessions: [malformed],
      asOfDay: '2026-09-25',
    })).toThrow(/Malformed Pro calculation session/);
  });

  it('deduplicates manual overlap, ignores false state, and truncates most-read novels deterministically', () => {
    const sessions = Array.from({ length: 101 }, (_, index) => proSession({
      novelId: `novel-${String(index).padStart(3, '0')}`,
      chapterId: 1,
      seconds: index + 1,
      words: index,
      progressPercent: index === 100 ? 100 : 0,
      completed: index === 100,
      completionSignalPresent: true,
    }));
    const stats = calculateProStats({
      sessions,
      chapterStates: [
        { novelId: 'novel-000', chapterId: 1, isRead: true, updatedAt: 2 },
        { novelId: 'novel-000', chapterId: 1, isRead: false, updatedAt: 1 },
        { novelId: 'novel-001', chapterId: 2, isRead: true, updatedAt: 2 },
        { novelId: 'novel-002', chapterId: 2, isRead: false, updatedAt: 2 },
      ],
      novels: [{ novelId: 'novel-100', title: 'Finished', totalChapters: 1 }],
      asOfDay: '2026-09-25',
    });

    expect(stats.combinedTotalChaptersCompleted).toBe(3);
    expect(stats.mostReadNovels).toHaveLength(100);
    expect(stats.mostReadNovels[0]).toEqual({
      novelId: 'novel-100',
      title: 'Finished',
      activeSeconds: 101,
      words: 100,
      chapters: 1,
    });
    expect(stats.mostReadNovelsTruncated).toBe(true);
    expect(stats.completedNovels).toEqual([{ novelId: 'novel-100', title: 'Finished' }]);
  });
});
