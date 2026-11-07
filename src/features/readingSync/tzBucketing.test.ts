import { describe, expect, it } from 'vitest';
import {
  calculateFreeStats,
  calculateProStats,
} from './calculations.js';
import {
  __tzFormatterCacheSizeForTest,
  isValidTimeZone,
  offsetDayLabelFromTs,
  resolveReadingTz,
  tzDayLabelFromTs,
  tzHourFromTs,
} from './timezone.js';

describe('viewer-timezone day bucketing', () => {
  const tsLateUtc = Date.UTC(2026, 8, 25, 22, 30, 0);

  it('validates IANA zones and falls back on invalid input', () => {
    expect(isValidTimeZone('Africa/Cairo')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(resolveReadingTz('Africa/Cairo', null)).toEqual({ kind: 'tz', tz: 'Africa/Cairo' });
    expect(resolveReadingTz('Bogus/Zone', 120)).toEqual({ kind: 'offset', offsetMinutes: 120 });
    expect(resolveReadingTz('Bogus/Zone', null)).toEqual({ kind: 'legacy' });
    expect(resolveReadingTz(null, null)).toEqual({ kind: 'legacy' });
  });

  it('maps 22:30 UTC to the next day in Africa/Cairo', () => {
    expect(new Date(tsLateUtc).toISOString().slice(0, 10)).toBe('2026-09-25');
    const cairoDay = tzDayLabelFromTs(tsLateUtc, 'Africa/Cairo');
    expect(cairoDay).toBe('2026-09-26');
    expect(tzHourFromTs(tsLateUtc, 'UTC')).toBe(22);
    const cairoHour = tzHourFromTs(tsLateUtc, 'Africa/Cairo');
    expect(cairoHour).toBe(1);
    expect(offsetDayLabelFromTs(tsLateUtc, 180)).toBe('2026-09-26');
  });

  it('buckets Pro day maps and hours from ts in the viewer timezone', () => {
    const proSession = {
      seconds: 600,
      words: 100,
      novelId: '42',
      chapterId: 1,
      progressPercent: 50,
      completed: false,
      completionSignalPresent: true,
      proFieldsPresent: true as const,
      minuteOfDay: 22 * 60 + 30,
      readDay: '2026-09-25',
      ts: tsLateUtc,
    };
    const plain = calculateProStats({
      sessions: [proSession],
      novels: [],
      asOfDay: '2026-09-26',
    });
    expect(plain.yearlyActivity).toEqual({ '2026-09-25': 600 });
    expect(plain.hourlyDistribution[22]).toBe(600);

    const tz = calculateProStats({
      sessions: [proSession],
      novels: [],
      asOfDay: '2026-09-26',
      tz: 'Africa/Cairo',
    });
    expect(tz.yearlyActivity).toEqual({ '2026-09-26': 600 });
    expect(tz.hourlyDistribution[1]).toBe(600);
    expect(tz.hourlyDistribution[22]).toBe(0);
    expect(tz.asOfDay).toBe('2026-09-26');
  });

  it('computes Free streaks from ts and re-buckets them in the viewer timezone', () => {
    const noon = Date.UTC(2026, 9, 15, 12, 0, 0);
    const sessions = [
      { seconds: 60, novelId: '1', chapterId: 1, progressPercent: 10, completed: false, completionSignalPresent: true, ts: noon - 86_400_000 },
      { seconds: 60, novelId: '1', chapterId: 2, progressPercent: 10, completed: false, completionSignalPresent: true, ts: noon },
    ];
    const plain = calculateFreeStats(sessions, { asOfDay: '2026-10-15' });
    expect(plain.longestStreakDays).toBe(2);

    const utcDay1 = Date.UTC(2026, 9, 15, 23, 30, 0);
    const utcDay2 = Date.UTC(2026, 9, 16, 0, 30, 0);
    const split = [
      { seconds: 60, novelId: '1', chapterId: 1, progressPercent: 10, completed: false, completionSignalPresent: true, ts: utcDay1 },
      { seconds: 60, novelId: '1', chapterId: 2, progressPercent: 10, completed: false, completionSignalPresent: true, ts: utcDay2 },
    ];
    const utc = calculateFreeStats(split, { asOfDay: '2026-10-16' });
    expect(utc.longestStreakDays).toBe(2);
    const cairo = calculateFreeStats(split, { asOfDay: '2026-10-16', tz: 'Africa/Cairo' });
    expect(cairo.longestStreakDays).toBe(1);
  });

  it('reuses one cached Intl formatter per timezone across sessions', () => {
    // Timezones not touched by any other test in this file, so the delta is exact.
    const before = __tzFormatterCacheSizeForTest();
    const ts = Date.UTC(2026, 9, 15, 12, 0, 0);
    // Kiritimati is UTC+14: 12:00 UTC is 02:00 local, so the first 22 hourly
    // sessions stay on 2026-10-16 while the hour sweeps 02..23.
    for (let i = 0; i < 22; i += 1) {
      expect(tzDayLabelFromTs(ts + i * 3_600_000, 'Pacific/Kiritimati')).toBe('2026-10-16');
      expect(tzHourFromTs(ts + i * 3_600_000, 'Pacific/Kiritimati')).toBe((2 + i) % 24);
    }
    // One day-formatter + one hour-formatter, no matter how many sessions.
    expect(__tzFormatterCacheSizeForTest() - before).toBe(2);
  });
});
