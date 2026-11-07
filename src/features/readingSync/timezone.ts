export type TzResolution =
  | { kind: 'tz'; tz: string }
  | { kind: 'offset'; offsetMinutes: number }
  | { kind: 'legacy' };

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const tz = value.trim();
  if (!tz || tz.length > 100) return false;
  try {
    // Validates and warms the shared cache in one step.
    dayFormatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

export function isValidTzOffsetMinutes(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= -720
    && value <= 840;
}

export function parseTzOffsetParam(value: unknown): number | null {
  if (typeof value === 'number' && isValidTzOffsetMinutes(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isSafeInteger(n) && isValidTzOffsetMinutes(n)) return n;
  }
  return null;
}

export function resolveReadingTz(
  tzParam: unknown,
  offsetParam: unknown,
): TzResolution {
  if (isValidTimeZone(tzParam)) return { kind: 'tz', tz: (tzParam as string).trim() };
  const offset = parseTzOffsetParam(offsetParam);
  if (offset !== null) return { kind: 'offset', offsetMinutes: offset };
  return { kind: 'legacy' };
}

function safeTs(ts: unknown): number | null {
  return typeof ts === 'number' && Number.isSafeInteger(ts) && ts >= 0 ? ts : null;
}

/**
 * Cached Intl formatters per timezone. Constructing an Intl.DateTimeFormat is
 * orders of magnitude more expensive than formatting a date with it, so the
 * per-session bucketing loop (one call per stored session) must reuse
 * instances. A module-level Map is safe: formatters are stateless and the
 * process is single-threaded.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const hourFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(tz, formatter);
  }
  return formatter;
}

function hourFormatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = hourFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    });
    hourFormatters.set(tz, formatter);
  }
  return formatter;
}

/** Test hook: number of cached formatter instances. */
export function __tzFormatterCacheSizeForTest(): number {
  return dayFormatters.size + hourFormatters.size;
}

export function tzDayLabelFromTs(ts: number, tz: string): string | null {
  if (safeTs(ts) === null || !isValidTimeZone(tz)) return null;
  try {
    const parts = dayFormatterFor(tz).formatToParts(new Date(ts));
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const y = get('year');
    const m = get('month');
    const d = get('day');
    if (!y || !m || !d) return null;
    const label = `${y}-${m}-${d}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return null;
    return label;
  } catch {
    return null;
  }
}

export function tzHourFromTs(ts: number, tz: string): number | null {
  if (safeTs(ts) === null || !isValidTimeZone(tz)) return null;
  try {
    const parts = hourFormatterFor(tz).formatToParts(new Date(ts));
    const hourPart = parts.find((p) => p.type === 'hour')?.value;
    if (hourPart === undefined) return null;
    let h = Number(hourPart);
    if (!Number.isFinite(h)) return null;
    if (h === 24) h = 0;
    if (h < 0 || h > 23) return null;
    return h;
  } catch {
    return null;
  }
}

export function offsetDayLabelFromTs(ts: number, offsetMinutes: number): string | null {
  if (safeTs(ts) === null || !isValidTzOffsetMinutes(offsetMinutes)) return null;
  return new Date(ts + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function offsetHourFromTs(ts: number, offsetMinutes: number): number | null {
  if (safeTs(ts) === null || !isValidTzOffsetMinutes(offsetMinutes)) return null;
  return new Date(ts + offsetMinutes * 60_000).getUTCHours();
}

export function todayLabelInTz(tz: string): string {
  return tzDayLabelFromTs(Date.now(), tz) ?? new Date().toISOString().slice(0, 10);
}

export function todayLabelForOffset(offsetMinutes: number): string {
  return offsetDayLabelFromTs(Date.now(), offsetMinutes) ?? new Date().toISOString().slice(0, 10);
}
