import { z } from 'zod';

// ==========================================
// Reading synchronization v2 protocol contracts.
//
// The v2 channel is intentionally separate from the legacy sync payloads.
// Every object below is allowlisted and strict. In particular, a Free request
// cannot add a Pro-only key and have it silently stripped by Zod: the parser
// reports a structured `pro_fields_not_allowed` issue before a route can write.
// ==========================================

export const READING_SYNC_VERSION = 2 as const;
export const readingPlanSchema = z.enum(['free', 'pro']);
export const syncVersionSchema = z.literal(READING_SYNC_VERSION);
export const COMPLETION_THRESHOLD = 85;
export const MAX_SESSIONS_PER_PUSH = 500;
export const MAX_COLLECTION_ROWS = 500;
export const MAX_NOVEL_ID_LENGTH = 100;
export const MAX_SECONDS_PER_SESSION = 86_400;
export const MAX_WORDS_PER_SESSION = 1_000_000;

export const CLIENT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const FREE_STATS_KEYS = [
  'level',
  'levelProgress',
  'totalSecondsRead',
  'uniqueInAppCompletedChapters',
] as const;

export const PRO_STATS_KEYS = [
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
] as const;

const FREE_SESSION_FORBIDDEN_KEYS = [
  // Pro session dimensions.
  'words',
  'minuteOfDay',
  'readDay',
  'genre',
  // Privacy/file fields that are not valid reading evidence.
  'fullWords',
  'scrollY',
  'content',
  'cover',
  'filePath',
  'novelCover',
  'coverUrl',
  // Aggregate/client-authoritative fields.
  ...PRO_STATS_KEYS,
  'asOfDay',
  'readingStats',
  'stats',
  'summary',
  'isPro',
  'statsPlan',
  'isRead',
  'isCompleted',
  'totalWordsRead',
  'totalChaptersCompleted',
  'totalNovelsCompleted',
  'lastReadDate',
  'last7DaysActivity',
  'yearlyActivity',
  'hourlyDistribution',
  'genreDistribution',
  'mostReadNovels',
  'mostReadNovelsTruncated',
  'completedNovels',
] as const;
const FREE_ENVELOPE_FORBIDDEN_KEYS = [
  'library',
  'history',
  'chapterStates',
  'novels',
] as const;

const finiteInteger = () => z.number().finite().int().safe();
const epochMilliseconds = () => finiteInteger().nonnegative();
const nonNegativeInteger = () => finiteInteger().nonnegative();
const percentage = () => z.number().finite().min(0).max(100);
const levelProgress = () => z.number().finite().min(0).max(1);
export const epochMillisecondsSchema = epochMilliseconds;
export const nonNegativeIntegerSchema = nonNegativeInteger;
export const percentageSchema = percentage;
export const levelProgressSchema = levelProgress;

const validCalendarDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const readDaySchema = z.string().refine(validCalendarDay, {
  message: 'readDay must be a valid YYYY-MM-DD calendar date',
  params: { code: 'invalid_read_day' },
});

export const novelIdSchema = z.union([
  z.string().trim().min(1).max(MAX_NOVEL_ID_LENGTH),
  z.number().finite().int().safe().transform(String),
]);

export const chapterIdSchema = z.number().finite().int().safe().positive();
export const secondsSchema = z.number().finite().int().min(0).max(MAX_SECONDS_PER_SESSION);
export const wordsSchema = z.number().finite().int().min(0).max(MAX_WORDS_PER_SESSION);
export const minuteOfDaySchema = z.number().finite().int().min(0).max(1439);

export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const cursorSchema = z.string().trim().min(1).max(1024).nullable();

/**
 * Build a strict object schema while retaining a useful error code for
 * unknown fields. Zod's built-in `.strict()` reports `unrecognized_keys` but
 * cannot distinguish a Free client trying to smuggle Pro data from a typo.
 * The preflight adds a custom issue and removes the unknown key only after that
 * issue has made the parse fail; the inner schema remains `.strict()` as a
 * second line of defense.
 */
function strictObject<T extends z.ZodRawShape>(
  shape: T,
  options: {
    forbiddenKeys?: readonly string[];
    forbiddenCode?: string;
  } = {},
) {
  const allowedKeys = new Set(Object.keys(shape));
  const forbiddenKeys = new Set(options.forbiddenKeys ?? []);
  const forbiddenCode = options.forbiddenCode ?? 'forbidden_field';

  return z.preprocess((value, ctx) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      let hasUnknownKey = false;
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (allowedKeys.has(key)) continue;
        hasUnknownKey = true;
        const code = forbiddenKeys.has(key) ? forbiddenCode : 'unknown_key';
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: code,
          params: { code, key },
        });
      }
      if (hasUnknownKey) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(([key]) => allowedKeys.has(key)),
        );
      }
    }
    return value;
  }, z.object(shape).strict());
}

function withCompletionConsistency<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value, ctx) => {
    if (value === null || typeof value !== 'object') return;
    const candidate = value as { progressPercent?: unknown; completed?: unknown };
    if (typeof candidate.progressPercent !== 'number' || typeof candidate.completed !== 'boolean') return;
    const shouldBeCompleted = candidate.progressPercent >= COMPLETION_THRESHOLD;
    if (candidate.completed !== shouldBeCompleted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed'],
        message: 'completion_mismatch',
        params: { code: 'completion_mismatch' },
      });
    }
  });
}

export const syncUserSchema = strictObject({
  externalId: z.string().trim().min(1).max(255),
});

export const deviceIdSchema = z.string().trim().min(1).max(100).optional();
export const clientSessionIdSchema = z.string().regex(CLIENT_SESSION_ID_PATTERN);
export const progressPercentSchema = percentage();

const freeSessionShape = {
  clientSessionId: clientSessionIdSchema,
  novelId: novelIdSchema,
  chapterId: chapterIdSchema,
  seconds: secondsSchema,
  progressPercent: progressPercentSchema,
  completed: z.boolean(),
  ts: epochMilliseconds(),
};

const freeSessionBaseSchema = strictObject(freeSessionShape, {
  forbiddenKeys: FREE_SESSION_FORBIDDEN_KEYS,
  forbiddenCode: 'pro_fields_not_allowed',
});
export const freeSessionSchema = withCompletionConsistency(freeSessionBaseSchema);

const proSessionShape = {
  ...freeSessionShape,
  words: wordsSchema,
  minuteOfDay: minuteOfDaySchema,
  readDay: readDaySchema,
  genre: z.string().trim().max(100),
};

export const FREE_SESSION_KEYS = Object.keys(freeSessionShape) as [
  'clientSessionId',
  'novelId',
  'chapterId',
  'seconds',
  'progressPercent',
  'completed',
  'ts',
];
export const PRO_SESSION_KEYS = Object.keys(proSessionShape) as [
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
];

const proSessionBaseSchema = strictObject(proSessionShape, {
  forbiddenKeys: [
    'fullWords',
    'scrollY',
    'content',
    'cover',
    'filePath',
    'novelCover',
    'coverUrl',
  ],
  forbiddenCode: 'forbidden_field',
});
export const proSessionSchema = withCompletionConsistency(proSessionBaseSchema);

const freeStatsShape = {
  level: z.number().finite().int().min(1).max(50),
  levelProgress: levelProgress(),
  totalSecondsRead: nonNegativeInteger(),
  uniqueInAppCompletedChapters: nonNegativeInteger(),
};
export const freeStatsSchema = strictObject(freeStatsShape, {
  forbiddenKeys: PRO_STATS_KEYS,
  forbiddenCode: 'pro_fields_not_allowed',
});

const remainingTimeSchema = strictObject({
  seconds: nonNegativeInteger().nullable(),
  minutes: nonNegativeInteger().nullable(),
});

const activityDaySchema = strictObject({
  date: readDaySchema,
  activeSeconds: nonNegativeInteger(),
});

const mostReadNovelSchema = strictObject({
  novelId: novelIdSchema,
  title: z.string().trim().max(255).nullable().optional(),
  activeSeconds: nonNegativeInteger(),
  words: nonNegativeInteger(),
  chapters: nonNegativeInteger(),
});

const completedNovelSchema = strictObject({
  novelId: novelIdSchema,
  title: z.string().trim().max(255).nullable().optional(),
});

export const proStatsSchema = strictObject({
  asOfDay: readDaySchema,
  level: z.number().finite().int().min(1).max(50),
  tier: z.number().finite().int().min(1).max(5),
  levelProgress: levelProgress(),
  remainingTime: remainingTimeSchema,
  totalSecondsRead: nonNegativeInteger(),
  currentStreakDays: nonNegativeInteger(),
  longestStreakDays: nonNegativeInteger(),
  totalWords: nonNegativeInteger(),
  averageWPM: z.number().finite().min(0).max(1000),
  uniqueInAppCompletedChapters: nonNegativeInteger(),
  combinedTotalChaptersCompleted: nonNegativeInteger(),
  last7DaysActivity: z.array(activityDaySchema).length(7),
  yearlyActivity: z.record(readDaySchema, nonNegativeInteger()),
  hourlyDistribution: z.array(nonNegativeInteger()).length(24),
  genreDistribution: z.record(z.string().trim().min(1).max(100), percentage()),
  mostReadNovels: z.array(mostReadNovelSchema).max(100),
  mostReadNovelsTruncated: z.boolean(),
  completedNovels: z.array(completedNovelSchema),
});

const categoryIdsSchema = z.array(z.string().trim().min(1).max(100)).max(100);

export const readingSyncLibraryItemSchema = strictObject({
  novelId: novelIdSchema,
  sourceId: z.string().trim().max(100).nullable().optional(),
  categoryIds: categoryIdsSchema.optional(),
  lastReadChapterId: chapterIdSchema.nullable().optional(),
  lastReadChapterNumber: nonNegativeInteger().nullable().optional(),
  lastReadChapterTitle: z.string().trim().max(255).nullable().optional(),
  progressPercent: percentage().optional(),
  lastReadAt: isoDateTimeSchema.nullable().optional(),
  addedAt: isoDateTimeSchema.nullable().optional(),
  updatedAt: epochMilliseconds().optional(),
  deletedAt: epochMilliseconds().nullable().optional(),
}, {
  forbiddenKeys: ['content', 'cover', 'coverUrl', 'novelCover', 'filePath', 'scrollY'],
  forbiddenCode: 'forbidden_field',
});

export const readingSyncHistoryItemSchema = strictObject({
  novelId: novelIdSchema,
  novelTitle: z.string().trim().max(255).optional(),
  novelAuthor: z.string().trim().max(150).optional(),
  category: z.string().trim().max(100).optional(),
  sourceId: z.string().trim().max(100).nullable().optional(),
  chapterId: chapterIdSchema,
  chapterNumber: nonNegativeInteger().optional(),
  chapterTitle: z.string().trim().max(255).optional(),
  progressPercent: percentage().optional(),
  readDay: readDaySchema.optional(),
  readAt: epochMilliseconds().optional(),
  updatedAt: epochMilliseconds().optional(),
}, {
  forbiddenKeys: ['novelCover', 'cover', 'coverUrl', 'content', 'filePath', 'scrollY'],
  forbiddenCode: 'forbidden_field',
});

export const readingSyncChapterStateSchema = strictObject({
  novelId: novelIdSchema,
  chapterId: chapterIdSchema,
  isRead: z.boolean(),
  origin: z.enum(['manual', 'snapshot']),
  updatedAt: epochMilliseconds(),
});

export const readingSyncNovelMetadataSchema = strictObject({
  novelId: novelIdSchema,
  title: z.string().trim().max(255),
  genre: z.string().trim().max(100),
  sourceId: z.string().trim().max(100).nullable().optional(),
  totalChapters: nonNegativeInteger().nullable().optional(),
  updatedAt: epochMilliseconds(),
}, {
  forbiddenKeys: ['cover', 'coverUrl', 'novelCover', 'content', 'filePath', 'scrollY'],
  forbiddenCode: 'forbidden_field',
});

const freePushShape = {
  syncVersion: syncVersionSchema,
  user: syncUserSchema,
  deviceId: deviceIdSchema,
  sessions: z.array(freeSessionSchema).max(MAX_SESSIONS_PER_PUSH),
};
export const freePushSchema = strictObject(freePushShape, {
  forbiddenKeys: FREE_ENVELOPE_FORBIDDEN_KEYS,
  forbiddenCode: 'pro_fields_not_allowed',
});

const proPushShape = {
  syncVersion: syncVersionSchema,
  user: syncUserSchema,
  deviceId: deviceIdSchema,
  sessions: z.array(proSessionSchema).max(MAX_SESSIONS_PER_PUSH),
  library: z.array(readingSyncLibraryItemSchema).max(MAX_COLLECTION_ROWS).optional(),
  history: z.array(readingSyncHistoryItemSchema).max(MAX_COLLECTION_ROWS).optional(),
  chapterStates: z.array(readingSyncChapterStateSchema).max(MAX_COLLECTION_ROWS).optional(),
  novels: z.array(readingSyncNovelMetadataSchema).max(MAX_COLLECTION_ROWS).optional(),
};
export const proPushSchema = strictObject(proPushShape, {
  forbiddenKeys: ['content', 'cover', 'coverUrl', 'filePath', 'scrollY'],
  forbiddenCode: 'forbidden_field',
});

const freePullShape = {
  syncVersion: syncVersionSchema,
  user: syncUserSchema,
  deviceId: deviceIdSchema,
};
export const freePullSchema = strictObject(freePullShape, {
  forbiddenKeys: FREE_ENVELOPE_FORBIDDEN_KEYS,
  forbiddenCode: 'pro_fields_not_allowed',
});

export const readingStatsQuerySchema = strictObject({
  libraryCursor: cursorSchema,
  historyCursor: cursorSchema,
  sessionCursor: cursorSchema,
  year: z.number().finite().int().min(1).max(9999),
});

const proPullShape = {
  syncVersion: syncVersionSchema,
  user: syncUserSchema,
  deviceId: deviceIdSchema,
  readingStats: readingStatsQuerySchema,
};
export const proPullSchema = strictObject(proPullShape);

// A plan-neutral union is useful to a route after it has resolved the plan;
// neither branch accepts a client-supplied `plan` key.
export const readingSyncPushSchema = z.union([freePushSchema, proPushSchema]);
export const readingSyncPullSchema = z.union([freePullSchema, proPullSchema]);

// Descriptive aliases for callers that use the full feature name.
export const readingSyncUserSchema = syncUserSchema;
export const freeReadingSessionSchema = freeSessionSchema;
export const proReadingSessionSchema = proSessionSchema;
export const freeReadingSyncPushSchema = freePushSchema;
export const proReadingSyncPushSchema = proPushSchema;
export const freeReadingSyncPullSchema = freePullSchema;
export const proReadingSyncPullSchema = proPullSchema;
export const freePushEnvelopeSchema = freePushSchema;
export const proPushEnvelopeSchema = proPushSchema;
export const freePullEnvelopeSchema = freePullSchema;
export const proPullEnvelopeSchema = proPullSchema;
export const freeStatsProjectionSchema = freeStatsSchema;
export const proStatsProjectionSchema = proStatsSchema;
export const readingSyncVersionSchema = syncVersionSchema;
export const readingSyncStatsQuerySchema = readingStatsQuerySchema;

export type ReadingPlan = z.infer<typeof readingPlanSchema>;
export type FreeSession = z.infer<typeof freeSessionSchema>;
export type ProSession = z.infer<typeof proSessionSchema>;
export type FreeStats = z.infer<typeof freeStatsSchema>;
export type ProStats = z.infer<typeof proStatsSchema>;
export type ReadingSyncUser = z.infer<typeof syncUserSchema>;
export type FreePushEnvelope = z.infer<typeof freePushSchema>;
export type ProPushEnvelope = z.infer<typeof proPushSchema>;
export type FreePullEnvelope = z.infer<typeof freePullSchema>;
export type ProPullEnvelope = z.infer<typeof proPullSchema>;
export type FreePush = FreePushEnvelope;
export type ProPush = ProPushEnvelope;
export type FreePull = FreePullEnvelope;
export type ProPull = ProPullEnvelope;
export type ReadingSyncPushEnvelope = z.infer<typeof readingSyncPushSchema>;
export type ReadingSyncPullEnvelope = z.infer<typeof readingSyncPullSchema>;
export type ReadingStatsQuery = z.infer<typeof readingStatsQuerySchema>;
export type ReadingSyncLibraryItem = z.infer<typeof readingSyncLibraryItemSchema>;
export type ReadingSyncHistoryItem = z.infer<typeof readingSyncHistoryItemSchema>;
export type ReadingSyncChapterState = z.infer<typeof readingSyncChapterStateSchema>;
export type ReadingSyncNovelMetadata = z.infer<typeof readingSyncNovelMetadataSchema>;

export type ReadingSyncErrorCode =
  | 'pro_fields_not_allowed'
  | 'forbidden_field'
  | 'unknown_key'
  | 'completion_mismatch'
  | 'invalid_sync_payload';

function issueCode(issue: z.ZodIssue): string | null {
  if (!('params' in issue)) return null;
  const params = issue.params as { code?: unknown } | undefined;
  return typeof params?.code === 'string' ? params.code : null;
}

/** Error thrown by the convenience parsers; routes can map `code` to a status. */
export class ReadingSyncContractError extends Error {
  readonly code: ReadingSyncErrorCode;
  readonly issues: z.ZodIssue[];

  constructor(error: unknown) {
    const isZodError = error instanceof z.ZodError;
    const issues = isZodError ? error.issues : [];
    const discoveredCodes = issues.map(issueCode).filter((code): code is string => Boolean(code));
    const code = (
      discoveredCodes.includes('pro_fields_not_allowed')
        ? 'pro_fields_not_allowed'
        : discoveredCodes.includes('forbidden_field')
          ? 'forbidden_field'
          : discoveredCodes.includes('completion_mismatch')
            ? 'completion_mismatch'
            : discoveredCodes.includes('unknown_key')
              ? 'unknown_key'
              : 'invalid_sync_payload'
    ) as ReadingSyncErrorCode;
    const detail = issues.length > 0 ? issues.map((issue) => issue.message).join('; ') : 'invalid payload';
    super(`${code}: ${detail}`);
    this.name = 'ReadingSyncContractError';
    this.code = code;
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function parseContract<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ReadingSyncContractError) throw error;
    throw new ReadingSyncContractError(error);
  }
}

export function parseFreeSession(input: unknown): FreeSession {
  return parseContract(freeSessionSchema, input);
}

export function parseProSession(input: unknown): ProSession {
  return parseContract(proSessionSchema, input);
}

export function parseFreeStats(input: unknown): FreeStats {
  return parseContract(freeStatsSchema, input);
}

export function parseProStats(input: unknown): ProStats {
  return parseContract(proStatsSchema, input);
}

export function parseFreePushEnvelope(input: unknown): FreePushEnvelope {
  return parseContract(freePushSchema, input);
}

export function parseProPushEnvelope(input: unknown): ProPushEnvelope {
  return parseContract(proPushSchema, input);
}

export function parseFreePullEnvelope(input: unknown): FreePullEnvelope {
  return parseContract(freePullSchema, input);
}

export function parseProPullEnvelope(input: unknown): ProPullEnvelope {
  return parseContract(proPullSchema, input);
}

// Short aliases make the parser convenient in route tests and calculation code.
export const parseFreePush = parseFreePushEnvelope;
export const parseProPush = parseProPushEnvelope;
export const parseFreePull = parseFreePullEnvelope;
export const parseProPull = parseProPullEnvelope;

/** Serialize only the four Free fields, even when given a Pro-shaped value. */
export function freeProjection(input: FreeStats | ProStats): FreeStats {
  return {
    level: input.level,
    levelProgress: input.levelProgress,
    totalSecondsRead: input.totalSecondsRead,
    uniqueInAppCompletedChapters: input.uniqueInAppCompletedChapters,
  };
}

export const projectFreeStats = freeProjection;

/** Serialize every approved Pro aggregate/data key without spreading input. */
export function proProjection(input: ProStats): ProStats {
  return {
    asOfDay: input.asOfDay,
    level: input.level,
    tier: input.tier,
    levelProgress: input.levelProgress,
    remainingTime: {
      seconds: input.remainingTime.seconds,
      minutes: input.remainingTime.minutes,
    },
    totalSecondsRead: input.totalSecondsRead,
    currentStreakDays: input.currentStreakDays,
    longestStreakDays: input.longestStreakDays,
    totalWords: input.totalWords,
    averageWPM: input.averageWPM,
    uniqueInAppCompletedChapters: input.uniqueInAppCompletedChapters,
    combinedTotalChaptersCompleted: input.combinedTotalChaptersCompleted,
    last7DaysActivity: input.last7DaysActivity.map((day) => ({
      date: day.date,
      activeSeconds: day.activeSeconds,
    })),
    yearlyActivity: Object.fromEntries(
      Object.entries(input.yearlyActivity).map(([date, activeSeconds]) => [date, activeSeconds]),
    ),
    hourlyDistribution: [...input.hourlyDistribution],
    genreDistribution: Object.fromEntries(
      Object.entries(input.genreDistribution).map(([genre, percentageValue]) => [genre, percentageValue]),
    ),
    mostReadNovels: input.mostReadNovels.map((novel) => {
      const projected = {
        novelId: novel.novelId,
        activeSeconds: novel.activeSeconds,
        words: novel.words,
        chapters: novel.chapters,
      } as {
        novelId: string;
        title?: string | null;
        activeSeconds: number;
        words: number;
        chapters: number;
      };
      if (novel.title !== undefined) projected.title = novel.title;
      return projected;
    }),
    mostReadNovelsTruncated: input.mostReadNovelsTruncated,
    completedNovels: input.completedNovels.map((novel) => {
      const projected = { novelId: novel.novelId } as {
        novelId: string;
        title?: string | null;
      };
      if (novel.title !== undefined) projected.title = novel.title;
      return projected;
    }),
  };
}

export const projectProStats = proProjection;

export function projectReadingStats(plan: ReadingPlan, input: FreeStats | ProStats): FreeStats | ProStats {
  return plan === 'free' ? freeProjection(input) : proProjection(input as ProStats);
}
