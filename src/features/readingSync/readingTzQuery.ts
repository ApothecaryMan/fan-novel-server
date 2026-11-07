import { isFreeStreaksOptIn } from './contracts.js';
import { isValidTimeZone, isValidTzOffsetMinutes } from './timezone.js';

export interface ReadingTz {
  tz: string | null;
  tzOffsetMinutes: number | null;
}

function cleanTz(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isValidTimeZone(trimmed) ? trimmed : null;
}

function cleanOffset(value: unknown): number | null {
  if (typeof value === 'number' && isValidTzOffsetMinutes(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isSafeInteger(n) && isValidTzOffsetMinutes(n)) return n;
  }
  return null;
}

export function parseReadingTzQuery(query: {
  readingStatsTz?: unknown;
  readingStatsTzOffset?: unknown;
  tz?: unknown;
}): ReadingTz {
  const tz = cleanTz(query.readingStatsTz ?? query.tz);
  const tzOffsetMinutes = cleanOffset(query.readingStatsTzOffset);
  return { tz, tzOffsetMinutes };
}

export function parseReadingTzBody(body: unknown): ReadingTz {
  if (body === null || typeof body !== 'object') return { tz: null, tzOffsetMinutes: null };
  const record = body as Record<string, unknown>;
  const fromTop: ReadingTz = parseReadingTzQuery({
    readingStatsTz: record.readingStatsTz,
    readingStatsTzOffset: record.readingStatsTzOffset,
  });
  const nested = record.readingStats !== null && typeof record.readingStats === 'object'
    ? parseReadingTzQuery(record.readingStats as Record<string, unknown>)
    : { tz: null, tzOffsetMinutes: null };
  return {
    tz: fromTop.tz ?? nested.tz,
    tzOffsetMinutes: fromTop.tzOffsetMinutes ?? nested.tzOffsetMinutes,
  };
}

/**
 * Explicit opt-in for the Free streak fields (`readingStatsFreeStreaks=1`).
 * Query params arrive as strings; bodies carry JSON numbers/booleans/strings
 * per the contract union. Anything else — including a missing flag — reads as
 * off, so old clients that never send it get the legacy 4-key shape.
 */
export function parseFreeStreaksQuery(query: {
  readingStatsFreeStreaks?: unknown;
}): boolean {
  return isFreeStreaksOptIn(query.readingStatsFreeStreaks);
}

export function parseFreeStreaksBody(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (isFreeStreaksOptIn(record.readingStatsFreeStreaks)) return true;
  const nested = record.readingStats;
  return nested !== null
    && typeof nested === 'object'
    && isFreeStreaksOptIn((nested as Record<string, unknown>).readingStatsFreeStreaks);
}
