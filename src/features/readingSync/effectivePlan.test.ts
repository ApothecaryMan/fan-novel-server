import { describe, expect, it } from 'vitest';
import { effectiveReadingPlan } from './freeStore.js';

const NOW = 1782470400000;

describe('effectiveReadingPlan', () => {
  it('Free stays Free regardless of expiry', () => {
    expect(effectiveReadingPlan({ readingStatsPlan: 'free', readingStatsPlanExpiresAt: NOW + 1000 }, NOW)).toBe('free');
    expect(effectiveReadingPlan({ readingStatsPlan: 'free', readingStatsPlanExpiresAt: null }, NOW)).toBe('free');
    expect(effectiveReadingPlan(null, NOW)).toBe('free');
    expect(effectiveReadingPlan({ readingStatsPlan: 'unknown', readingStatsPlanExpiresAt: NOW + 1000 }, NOW)).toBe('free');
  });

  it('Pro with future expiry derives Pro', () => {
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: NOW + 1000 }, NOW)).toBe('pro');
  });

  it('expiry boundary belongs to Free (exclusive)', () => {
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: NOW }, NOW)).toBe('free');
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: NOW - 1 }, NOW)).toBe('free');
    expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: NOW + 1 }, NOW)).toBe('pro');
  });

  it('null/corrupt expiry fails closed', () => {
    for (const bad of [null, undefined, NaN, 1.5, 'tomorrow', -100, Infinity]) {
      expect(effectiveReadingPlan({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: bad }, NOW)).toBe('free');
    }
  });

  it('ignores grace/trial/display columns', () => {
    const row = {
      readingStatsPlan: 'pro',
      readingStatsPlanExpiresAt: NOW - 1,
      readingStatsGraceUntil: NOW + 999_999,
      readingStatsTrialStartedAt: NOW - 999,
      readingStatsTrialEndsAt: NOW + 999_999,
      readingStatsPlanStatus: 'active',
    };
    expect(effectiveReadingPlan(row, NOW)).toBe('free');
    expect(effectiveReadingPlan({ ...row, readingStatsPlanExpiresAt: NOW + 999 }, NOW)).toBe('pro');
  });
});
