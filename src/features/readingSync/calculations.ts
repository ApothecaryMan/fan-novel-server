import {
  COMPLETION_THRESHOLD,
  MAX_WPM,
  type FreeStats,
  type ProCompletedNovel,
  type ProMostReadNovel,
  type ProStats,
} from './contracts.js';

/**
 * Reading-level inputs are deliberately kept separate from the wire session
 * types. A calculation receives normalized rows from storage, not a payload
 * that still needs protocol validation.
 *
 * `completionSignalPresent` is deliberately required. An absent marker is
 * materially different from `false`: only an explicit marker can establish
 * that a completion came from the in-app signal path.
 */
export interface FreeCalculationSession {
  seconds: number;
  novelId: string | number;
  chapterId: number;
  progressPercent: number;
  completed?: boolean;
  completionSignalPresent: boolean;
  clientSessionId?: string;
  ts?: number;
}

interface ProCalculationDimensions {
  words: number;
  minuteOfDay: number;
  readDay: string;
  genre: string | null;
}

interface ProDimensionsPresent extends FreeCalculationSession {
  proFieldsPresent: true;
  words: number;
  minuteOfDay: number;
  readDay: string;
  genre: string | null;
}

interface ProDimensionsAbsent extends FreeCalculationSession {
  /** Free-origin rows and legacy rows may not carry Pro dimensions. */
  proFieldsPresent?: false;
  words?: number;
  minuteOfDay?: number;
  readDay?: string;
  genre?: string | null;
}

/**
 * Pro rows are discriminated by the storage marker. A row that says its Pro
 * fields are present must provide every dimension; rows without that marker
 * retain the legacy/Free compatibility shape.
 */
export type ProCalculationSession = ProDimensionsPresent | ProDimensionsAbsent;

export interface ProCalculationChapterState {
  novelId: string | number;
  chapterId: number;
  isRead: boolean;
  origin?: 'manual' | 'snapshot';
  updatedAt?: number;
}

export interface ProCalculationNovel {
  novelId: string | number;
  title?: string | null;
  /** `novelTitle` is accepted as a harmless compatibility alias. */
  novelTitle?: string | null;
  genre?: string | null;
  totalChapters?: number | null;
  updatedAt?: number;
  sourceId?: string | null;
}

export interface ProCalculationOptions {
  asOfDay?: string;
  year?: number;
}

export interface ProCalculationInput {
  sessions: readonly ProCalculationSession[];
  chapterStates?: readonly ProCalculationChapterState[];
  novels?: readonly ProCalculationNovel[];
  asOfDay?: string;
  year?: number;
}

// These aliases make the normalized-input intent explicit for callers without
// introducing a second set of runtime shapes.
export type NormalizedFreeSession = FreeCalculationSession;
export type NormalizedProSession = ProCalculationSession;
export type NormalizedChapterState = ProCalculationChapterState;
export type NormalizedNovel = ProCalculationNovel;

export const MAX_LEVEL = 50;
export const LEVELS_PER_TIER = 10;
export const TIER_COUNT = 5;
export const TIER_STEPS_HOURS = [1, 2, 4, 8, 15] as const;

export interface LevelRow {
  level: number;
  tier: number;
  positionInTier: number;
  stepHours: number;
  deltaHours: number;
  deltaMinutes: number;
  cumulativeHours: number;
  cumulativeMinutes: number;
}

function buildLevelTable(): LevelRow[] {
  const rows: LevelRow[] = [];
  let cumulativeHours = 0;

  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    const tier = Math.ceil(level / LEVELS_PER_TIER);
    const positionInTier = ((level - 1) % LEVELS_PER_TIER) + 1;
    const stepHours = TIER_STEPS_HOURS[tier - 1];
    const deltaHours = stepHours * positionInTier;
    cumulativeHours += deltaHours;

    rows.push({
      level,
      tier,
      positionInTier,
      stepHours,
      deltaHours,
      deltaMinutes: deltaHours * 60,
      cumulativeHours,
      cumulativeMinutes: cumulativeHours * 60,
    });
  }

  return rows;
}

/**
 * The canonical server copy of the app's five-tier/50-level ladder. Route
 * code can consume these helpers in a later task; keeping the table here makes
 * the pure calculation module independent of Hono/database imports.
 */
export const LEVEL_TABLE: readonly LevelRow[] = buildLevelTable();

export function minutesToReach(level: number): number {
  if (!Number.isFinite(level)) return 0;
  const normalized = Math.floor(level);
  if (normalized <= 1) return 0;
  if (normalized > MAX_LEVEL) return LEVEL_TABLE[MAX_LEVEL - 1].cumulativeMinutes;
  return LEVEL_TABLE[normalized - 2].cumulativeMinutes;
}

export function tierOfLevel(level: number): number {
  const normalized = Number.isFinite(level) ? Math.floor(level) : 1;
  const clamped = Math.min(MAX_LEVEL, Math.max(1, normalized));
  return Math.ceil(clamped / LEVELS_PER_TIER);
}

export function isTierEntryLevel(level: number): boolean {
  return Number.isInteger(level)
    && level > 1
    && level <= MAX_LEVEL
    && (level - 1) % LEVELS_PER_TIER === 0;
}

export interface LevelInfo {
  level: number;
  tier: number;
  isTierEntry: boolean;
  isMax: boolean;
  progress: number;
  totalMinutes: number;
  currentRequiredMinutes: number;
  nextRequiredMinutes: number | null;
}

/** Map whole active minutes to the app-compatible level/tier/progress state. */
export function getLevelFromMinutes(totalActiveMinutes: number): LevelInfo {
  const total = Number.isFinite(totalActiveMinutes)
    ? Math.max(0, Math.floor(totalActiveMinutes))
    : 0;

  let level = 1;
  for (let thresholdLevel = 1; thresholdLevel < MAX_LEVEL; thresholdLevel += 1) {
    if (total >= LEVEL_TABLE[thresholdLevel - 1].cumulativeMinutes) {
      level = thresholdLevel + 1;
    } else {
      break;
    }
  }

  const currentRequiredMinutes = minutesToReach(level);
  const isMax = level >= MAX_LEVEL;
  const nextRequiredMinutes = isMax ? null : minutesToReach(level + 1);
  const span = (nextRequiredMinutes ?? LEVEL_TABLE[MAX_LEVEL - 1].cumulativeMinutes)
    - currentRequiredMinutes;
  const progress = isMax && total >= LEVEL_TABLE[MAX_LEVEL - 1].cumulativeMinutes
    ? 1
    : span > 0
      ? Math.min(1, Math.max(0, (total - currentRequiredMinutes) / span))
      : 1;

  return {
    level,
    tier: tierOfLevel(level),
    isTierEntry: isTierEntryLevel(level),
    isMax,
    progress,
    totalMinutes: total,
    currentRequiredMinutes,
    nextRequiredMinutes,
  };
}

/** The calculation boundary uses floor(totalSeconds / 60), not wall time. */
export function getLevelFromSeconds(totalSeconds: number): LevelInfo {
  const seconds = Number.isFinite(totalSeconds) && totalSeconds > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(totalSeconds))
    : 0;
  return getLevelFromMinutes(Math.floor(seconds / 60));
}

export function calculateLevel(totalSeconds: number): LevelInfo {
  return getLevelFromSeconds(totalSeconds);
}

const DAY_MS = 86_400_000;
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

function civilDayNumber(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.floor(date.getTime() / DAY_MS);
}

// The public contract accepts four-digit years 0001 through 9999. Keep the
// arithmetic domain explicit so a seven-day window at the lower boundary can
// never be rendered as year 0000 (or any other unsupported label).
const MIN_DAY_NUMBER = civilDayNumber(MIN_YEAR, 1, 1);
const MAX_DAY_NUMBER = civilDayNumber(MAX_YEAR, 12, 31);

function clampSupportedDayNumber(dayNumber: number): number {
  if (!Number.isFinite(dayNumber)) return MIN_DAY_NUMBER;
  return Math.min(MAX_DAY_NUMBER, Math.max(MIN_DAY_NUMBER, Math.floor(dayNumber)));
}

interface ParsedDay {
  label: string;
  dayNumber: number;
}

/**
 * Parse a calendar label without constructing a local Date. UTC Date methods
 * are used only as a civil-calendar arithmetic engine; the input timezone is
 * never consulted, so a local client day remains that exact label on the
 * server.
 */
function parseDay(label: unknown): ParsedDay | null {
  if (typeof label !== 'string') return null;
  const normalized = label.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;

  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(5, 7));
  const day = Number(normalized.slice(8, 10));
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    label: normalized,
    dayNumber: Math.floor(date.getTime() / DAY_MS),
  };
}

function dayLabel(dayNumber: number): string {
  const date = new Date(clampSupportedDayNumber(dayNumber) * DAY_MS);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function utcTodayLabel(): string {
  const now = new Date();
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function asOfDayFrom(
  inputAsOfDay: unknown,
  optionsAsOfDay: unknown,
): ParsedDay {
  return parseDay(optionsAsOfDay)
    ?? parseDay(inputAsOfDay)
    ?? parseDay(utcTodayLabel())!;
}

function requestedYear(inputYear: unknown, optionsYear: unknown, asOfDay: ParsedDay): number {
  const fallbackYear = Number(asOfDay.label.slice(0, 4));
  // Explicit calculation options win, then the input snapshot, then the
  // as-of day. Invalid values are ignored at the level where they were
  // supplied instead of masking a valid lower-precedence value.
  for (const candidate of [optionsYear, inputYear, fallbackYear]) {
    if (typeof candidate === 'number'
      && Number.isInteger(candidate)
      && candidate >= MIN_YEAR
      && candidate <= MAX_YEAR) {
      return candidate;
    }
  }
  return fallbackYear;
}

function yearPrefix(year: number): string {
  return `${String(year).padStart(4, '0')}-`;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function addNonNegative(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + nonNegativeInteger(right));
}

function normalizeNovelId(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function normalizeChapterId(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

function pairKey(novelId: string, chapterId: number): string {
  return `${novelId}#${chapterId}`;
}

function addPair(
  pairs: Set<string>,
  byNovel: Map<string, Set<number>>,
  novelId: string,
  chapterId: number,
): void {
  pairs.add(pairKey(novelId, chapterId));
  const chapters = byNovel.get(novelId) ?? new Set<number>();
  chapters.add(chapterId);
  byNovel.set(novelId, chapters);
}

function isInAppCompletion(session: FreeCalculationSession): boolean {
  return session.completionSignalPresent === true
    && typeof session.progressPercent === 'number'
    && Number.isFinite(session.progressPercent)
    && session.progressPercent >= COMPLETION_THRESHOLD;
}

function hasValidProDimensions(value: unknown): value is ProCalculationDimensions {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ProCalculationDimensions>;
  return typeof candidate.words === 'number'
    && Number.isSafeInteger(candidate.words)
    && candidate.words >= 0
    && typeof candidate.minuteOfDay === 'number'
    && Number.isInteger(candidate.minuteOfDay)
    && candidate.minuteOfDay >= 0
    && candidate.minuteOfDay <= 1439
    && typeof candidate.readDay === 'string'
    && parseDay(candidate.readDay) !== null
    && (candidate.genre === null || typeof candidate.genre === 'string');
}

function assertValidProDimensions(session: ProDimensionsPresent): void {
  if (!hasValidProDimensions(session)) {
    throw new TypeError(
      'Malformed Pro calculation session: proFieldsPresent=true requires valid words, minuteOfDay, readDay, and genre',
    );
  }
}

function assertValidProSessions(sessions: readonly ProCalculationSession[]): void {
  for (const session of sessions) {
    if (session.proFieldsPresent === true) {
      assertValidProDimensions(session);
    }
  }
}

function sumSeconds(sessions: readonly FreeCalculationSession[]): number {
  return sessions.reduce((total, session) => addNonNegative(total, session.seconds), 0);
}

function hasAcceptedProDimensions(session: ProCalculationSession): boolean {
  // A v2 Free-origin event has a completion signal but no Pro dimensions.
  // Legacy rows have the opposite marker combination and may still carry
  // valid historical words/day/hour values.
  return session.proFieldsPresent !== false || session.completionSignalPresent !== true;
}

function creditedWords(session: ProCalculationSession): number {
  if (!hasAcceptedProDimensions(session)) return 0;
  if (session.proFieldsPresent === true) return nonNegativeInteger(session.words);
  return nonNegativeInteger(session.words ?? 0);
}

function sumWords(sessions: readonly ProCalculationSession[]): number {
  return sessions.reduce((total, session) => addNonNegative(total, creditedWords(session)), 0);
}

function averageWpm(totalWords: number, totalSeconds: number): number {
  if (totalWords <= 0 || totalSeconds <= 0) return 0;
  const minutes = totalSeconds / 60;
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(MAX_WPM, Math.max(1, Math.round(totalWords / minutes)));
}

function calculateStreaks(days: Set<number>, asOfDay: number): {
  current: number;
  longest: number;
} {
  let current = 0;
  let cursor = asOfDay;
  if (!days.has(cursor)) cursor -= 1;

  while (days.has(cursor)) {
    current += 1;
    cursor -= 1;
  }

  const sorted = [...days].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of sorted) {
    run = previous !== null && day - previous === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }

  return { current, longest };
}

interface LatestChapterStateValue {
  novelId: string;
  chapterId: number;
  isRead: boolean;
  updatedAt: number | null;
}

function latestChapterStates(
  states: readonly ProCalculationChapterState[],
): Map<string, LatestChapterStateValue> {
  const latest = new Map<string, LatestChapterStateValue>();

  states.forEach((state) => {
    const novelId = normalizeNovelId(state.novelId);
    const chapterId = normalizeChapterId(state.chapterId);
    if (novelId === null || chapterId === null) return;

    const key = pairKey(novelId, chapterId);
    const candidate: LatestChapterStateValue = {
      novelId,
      chapterId,
      isRead: state.isRead === true,
      updatedAt: typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt)
        ? state.updatedAt
        : null,
    };
    const previous = latest.get(key);
    if (!previous) {
      latest.set(key, candidate);
      return;
    }

    if (candidate.updatedAt === null && previous.updatedAt !== null) return;
    if (previous.updatedAt !== null && candidate.updatedAt !== null) {
      if (candidate.updatedAt < previous.updatedAt) return;
      if (candidate.updatedAt === previous.updatedAt && !candidate.isRead && previous.isRead) {
        return;
      }
    }
    latest.set(key, candidate);
  });

  return latest;
}

interface NormalizedNovelMetadata {
  novelId: string;
  title?: string | null;
  genre?: string | null;
  sourceId?: string | null;
  totalChapters: number | null;
  updatedAt: number | null;
}

function normalizeTitle(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeGenre(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSourceId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTotalChapters(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 && Number.isSafeInteger(normalized) ? normalized : null;
}

function preferNonEmptyString(
  candidate: string | null | undefined,
  previous: string | null | undefined,
): string | null | undefined {
  return candidate !== null && candidate !== undefined && candidate.length > 0
    ? candidate
    : previous;
}

/**
 * The server treats a newer metadata row as authoritative. At an equal
 * timestamp, however, rows can be complementary (for example a title from a
 * library response and chapter count from a snapshot), so merge each field
 * independently and never let an empty value erase a non-empty one.
 */
function mergeEqualTimestampMetadata(
  previous: NormalizedNovelMetadata,
  candidate: NormalizedNovelMetadata,
): NormalizedNovelMetadata {
  return {
    novelId: candidate.novelId,
    title: preferNonEmptyString(candidate.title, previous.title),
    genre: preferNonEmptyString(candidate.genre, previous.genre),
    sourceId: preferNonEmptyString(candidate.sourceId, previous.sourceId),
    totalChapters: candidate.totalChapters ?? previous.totalChapters,
    updatedAt: candidate.updatedAt,
  };
}

function normalizeNovelMetadata(
  novels: readonly ProCalculationNovel[],
): Map<string, NormalizedNovelMetadata> {
  const normalized = new Map<string, NormalizedNovelMetadata>();

  novels.forEach((novel) => {
    const novelId = normalizeNovelId(novel.novelId);
    if (novelId === null) return;

    const candidate: NormalizedNovelMetadata = {
      novelId,
      title: normalizeTitle(novel.title) ?? normalizeTitle(novel.novelTitle),
      genre: normalizeGenre(novel.genre),
      sourceId: normalizeSourceId(novel.sourceId),
      totalChapters: normalizeTotalChapters(novel.totalChapters),
      updatedAt: typeof novel.updatedAt === 'number' && Number.isFinite(novel.updatedAt)
        ? novel.updatedAt
        : null,
    };
    const previous = normalized.get(novelId);
    if (!previous) {
      normalized.set(novelId, candidate);
      return;
    }

    if (candidate.updatedAt === null) {
      if (previous.updatedAt === null) {
        normalized.set(novelId, mergeEqualTimestampMetadata(previous, candidate));
      }
      return;
    }
    if (previous.updatedAt === null) {
      normalized.set(novelId, candidate);
      return;
    }
    if (candidate.updatedAt < previous.updatedAt) return;
    normalized.set(
      novelId,
      candidate.updatedAt === previous.updatedAt
        ? mergeEqualTimestampMetadata(previous, candidate)
        : candidate,
    );
  });

  return normalized;
}

function genreDistribution(
  sessions: readonly ProCalculationSession[],
  metadata: Map<string, NormalizedNovelMetadata>,
): Record<string, number> {
  const counts = new Map<string, number>();
  let total = 0;

  for (const session of sessions) {
    if (!hasAcceptedProDimensions(session)) continue;
    const novelId = normalizeNovelId(session.novelId);
    const genre = normalizeGenre(session.genre)
      ?? (novelId === null ? undefined : normalizeGenre(metadata.get(novelId)?.genre));
    if (genre === undefined) continue;
    counts.set(genre, (counts.get(genre) ?? 0) + 1);
    total += 1;
  }

  if (total === 0) return {};
  return Object.fromEntries(
    [...counts.keys()].sort().map((genre) => [
      genre,
      Math.round((counts.get(genre)! / total) * 100),
    ]),
  );
}

function mostReadNovels(
  sessions: readonly ProCalculationSession[],
  completedByNovel: Map<string, Set<number>>,
  metadata: Map<string, NormalizedNovelMetadata>,
): { rows: ProMostReadNovel[]; truncated: boolean } {
  const aggregates = new Map<string, {
    activeSeconds: number;
    words: number;
  }>();

  for (const session of sessions) {
    const novelId = normalizeNovelId(session.novelId);
    if (novelId === null) continue;

    const aggregate = aggregates.get(novelId) ?? {
      activeSeconds: 0,
      words: 0,
    };
    aggregate.activeSeconds = addNonNegative(aggregate.activeSeconds, session.seconds);
    aggregate.words = addNonNegative(aggregate.words, creditedWords(session));
    aggregates.set(novelId, aggregate);
  }

  const ordered = [...aggregates.entries()].sort(([leftId, left], [rightId, right]) => {
    if (left.activeSeconds !== right.activeSeconds) return right.activeSeconds - left.activeSeconds;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const rows: ProMostReadNovel[] = [];
  for (const [novelId, aggregate] of ordered.slice(0, 100)) {
    const title = metadata.get(novelId)?.title;
    const row = {
      novelId,
      ...(title !== undefined ? { title } : {}),
      activeSeconds: aggregate.activeSeconds,
      words: aggregate.words,
      chapters: completedByNovel.get(novelId)?.size ?? 0,
    } satisfies ProMostReadNovel;
    rows.push(row);
  }

  return { rows, truncated: ordered.length > 100 };
}

function completedNovels(
  metadata: Map<string, NormalizedNovelMetadata>,
  combinedByNovel: Map<string, Set<number>>,
): ProCompletedNovel[] {
  const rows: ProCompletedNovel[] = [];
  const orderedMetadata = [...metadata.values()].sort((left, right) => {
    return left.novelId < right.novelId ? -1 : left.novelId > right.novelId ? 1 : 0;
  });
  for (const novel of orderedMetadata) {
    if (novel.totalChapters === null) continue;
    if ((combinedByNovel.get(novel.novelId)?.size ?? 0) < novel.totalChapters) continue;

    const row: ProCompletedNovel = { novelId: novel.novelId };
    if (novel.title !== undefined) row.title = novel.title;
    rows.push(row);
  }
  return rows;
}

/** Calculate the four Free fields from normalized accepted session rows. */
export function calculateFreeStats(
  sessions: readonly FreeCalculationSession[],
): FreeStats {
  const totalSecondsRead = sumSeconds(sessions);
  const completedPairs = new Set<string>();

  for (const session of sessions) {
    if (!isInAppCompletion(session)) continue;
    const novelId = normalizeNovelId(session.novelId);
    const chapterId = normalizeChapterId(session.chapterId);
    if (novelId !== null && chapterId !== null) {
      completedPairs.add(pairKey(novelId, chapterId));
    }
  }

  const level = getLevelFromSeconds(totalSecondsRead);
  return {
    level: level.level,
    levelProgress: level.progress,
    totalSecondsRead,
    uniqueInAppCompletedChapters: completedPairs.size,
  };
}

export function calculateFreeReadingStats(
  sessions: readonly FreeCalculationSession[],
): FreeStats {
  return calculateFreeStats(sessions);
}

/** Calculate the complete Pro projection without returning any source rows. */
export function calculateProStats(
  input: ProCalculationInput,
  options?: ProCalculationOptions | string,
  legacyYear?: number,
): ProStats {
  const sessions = input.sessions;
  assertValidProSessions(sessions);
  const chapterStates = input.chapterStates ?? [];
  const novels = input.novels ?? [];
  const optionObject = typeof options === 'string' ? { asOfDay: options } : options;
  const asOfDay = asOfDayFrom(input.asOfDay, optionObject?.asOfDay);
  const year = requestedYear(input.year, optionObject?.year ?? legacyYear, asOfDay);

  const totalSecondsRead = sumSeconds(sessions);
  const totalWords = sumWords(sessions);
  const level = getLevelFromSeconds(totalSecondsRead);
  const inAppPairs = new Set<string>();
  const inAppByNovel = new Map<string, Set<number>>();
  const activeDaySeconds = new Map<number, number>();
  const activeYearSeconds = new Map<number, number>();
  const readDayNumbers = new Set<number>();
  const hourlyDistribution = Array.from({ length: 24 }, () => 0);
  const metadata = normalizeNovelMetadata(novels);

  for (const session of sessions) {
    const seconds = nonNegativeInteger(session.seconds);
    const novelId = normalizeNovelId(session.novelId);
    const chapterId = normalizeChapterId(session.chapterId);

    if (isInAppCompletion(session) && novelId !== null && chapterId !== null) {
      addPair(inAppPairs, inAppByNovel, novelId, chapterId);
    }

    const proDimensions = hasAcceptedProDimensions(session);
    const readDay = proDimensions ? parseDay(session.readDay) : null;
    if (readDay !== null) {
      readDayNumbers.add(readDay.dayNumber);
      const previous = activeDaySeconds.get(readDay.dayNumber) ?? 0;
      activeDaySeconds.set(readDay.dayNumber, addNonNegative(previous, seconds));
      if (readDay.label.startsWith(yearPrefix(year))) {
        const previousYear = activeYearSeconds.get(readDay.dayNumber) ?? 0;
        activeYearSeconds.set(readDay.dayNumber, addNonNegative(previousYear, seconds));
      }
    }

    if (proDimensions && typeof session.minuteOfDay === 'number' && Number.isFinite(session.minuteOfDay)) {
      const hour = Math.min(23, Math.max(0, Math.floor(session.minuteOfDay / 60)));
      hourlyDistribution[hour] = addNonNegative(hourlyDistribution[hour], seconds);
    }
  }

  const activeStates = latestChapterStates(chapterStates);
  const combinedPairs = new Set(inAppPairs);
  const combinedByNovel = new Map<string, Set<number>>(
    [...inAppByNovel.entries()].map(([novelId, chapters]) => [novelId, new Set(chapters)]),
  );
  for (const [key, state] of activeStates) {
    if (!state.isRead) continue;
    combinedPairs.add(key);
    const chapters = combinedByNovel.get(state.novelId) ?? new Set<number>();
    chapters.add(state.chapterId);
    combinedByNovel.set(state.novelId, chapters);
  }

  const streak = calculateStreaks(readDayNumbers, asOfDay.dayNumber);
  const last7DaysActivity = Array.from({ length: 7 }, (_, index) => {
    const requestedDay = asOfDay.dayNumber - (6 - index);
    // There are only seven supported dates before 0001-01-01. Clamp the
    // label to the contract domain; the out-of-domain slots remain zero so
    // clamping never multiplies the activity total.
    const day = clampSupportedDayNumber(requestedDay);
    return {
      date: dayLabel(day),
      activeSeconds: requestedDay === day ? (activeDaySeconds.get(day) ?? 0) : 0,
    };
  });
  const yearlyActivity: Record<string, number> = {};
  for (const day of [...activeYearSeconds.keys()].sort((a, b) => a - b)) {
    const activeSeconds = activeYearSeconds.get(day) ?? 0;
    if (activeSeconds > 0) yearlyActivity[dayLabel(day)] = activeSeconds;
  }

  const mostRead = mostReadNovels(sessions, inAppByNovel, metadata);
  const completed = completedNovels(metadata, combinedByNovel);
  const nextThresholdSeconds = level.nextRequiredMinutes === null
    ? null
    : level.nextRequiredMinutes * 60;
  const activeMinutes = Math.floor(totalSecondsRead / 60);
  const remainingTime = nextThresholdSeconds === null
    ? { seconds: null, minutes: null }
    : {
      seconds: Math.max(0, nextThresholdSeconds - totalSecondsRead),
      minutes: Math.max(0, level.nextRequiredMinutes! - activeMinutes),
    };

  return {
    asOfDay: asOfDay.label,
    level: level.level,
    tier: level.tier,
    levelProgress: level.progress,
    remainingTime,
    totalSecondsRead,
    currentStreakDays: streak.current,
    longestStreakDays: streak.longest,
    totalWords,
    averageWPM: averageWpm(totalWords, totalSecondsRead),
    uniqueInAppCompletedChapters: inAppPairs.size,
    combinedTotalChaptersCompleted: combinedPairs.size,
    last7DaysActivity,
    yearlyActivity,
    hourlyDistribution,
    genreDistribution: genreDistribution(sessions, metadata),
    mostReadNovels: mostRead.rows,
    mostReadNovelsTruncated: mostRead.truncated,
    completedNovels: completed,
  };
}

export function calculateProReadingStats(
  input: ProCalculationInput,
  options?: ProCalculationOptions | string,
  legacyYear?: number,
): ProStats {
  return calculateProStats(input, options, legacyYear);
}
