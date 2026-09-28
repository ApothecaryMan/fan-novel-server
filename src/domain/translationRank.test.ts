import { describe, expect, it } from 'vitest';
import { parseTranslationRank, TRANSLATION_RANKS } from './translationRank.js';

// The API must not leak an unknown stored value: toApi() normalizes through
// parseTranslationRank, so a bad row degrades to "unranked" (null) instead of
// sending the client a tier it has no label for.

describe('parseTranslationRank', () => {
  it('accepts every known tier, normalized', () => {
    for (const rank of TRANSLATION_RANKS) {
      expect(parseTranslationRank(rank)).toBe(rank);
    }
    expect(parseTranslationRank('s+')).toBe('S+');
    expect(parseTranslationRank(' a ')).toBe('A');
  });

  it('rejects unknown tiers and non-strings', () => {
    for (const bad of ['SS', 'S++', 'C', 'S-', '4', '', null, undefined, 1, {}]) {
      expect(parseTranslationRank(bad)).toBeNull();
    }
  });
});
