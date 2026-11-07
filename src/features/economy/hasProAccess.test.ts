import { describe, expect, it } from 'vitest';
import { hasProAccess } from './service.js';

describe('hasProAccess', () => {
  const now = 1_700_000_000_000;
  it('grants while the effective plan is pro', () => {
    expect(hasProAccess({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: now + 1000 }, now)).toBe(true);
  });
  it('denies an expired pro without grace', () => {
    expect(hasProAccess({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: now - 1000 }, now)).toBe(false);
  });
  it('denies a free plan without grace', () => {
    expect(hasProAccess({ readingStatsPlan: 'free', readingStatsGraceUntil: null }, now)).toBe(false);
  });
  it('grants inside a live safe-integer grace window', () => {
    expect(hasProAccess({ readingStatsPlan: 'free', readingStatsGraceUntil: now + 1000 }, now)).toBe(true);
  });
  it('denies an expired grace window and corrupt grace values fail closed', () => {
    expect(hasProAccess({ readingStatsPlan: 'free', readingStatsGraceUntil: now - 1 }, now)).toBe(false);
    expect(hasProAccess({ readingStatsPlan: 'free', readingStatsGraceUntil: Number.NaN }, now)).toBe(false);
    expect(hasProAccess({ readingStatsPlan: 'free', readingStatsGraceUntil: Number.POSITIVE_INFINITY }, now)).toBe(false);
    expect(hasProAccess({ readingStatsPlan: 'free', readingStatsGraceUntil: 'tomorrow' }, now)).toBe(false);
    expect(hasProAccess(null, now)).toBe(false);
  });
});
