/**
 * Translation-quality grading (تقييم جودة الترجمة).
 *
 * A novel carries an optional editorial grade. The grade is authored on the
 * server and read verbatim by the client — the client NEVER infers or invents
 * one, and a novel with no grade stays unranked (the badge is hidden).
 */

export const TRANSLATION_RANKS = ['B', 'A', 'S', 'S+'] as const;

export type TranslationRank = (typeof TRANSLATION_RANKS)[number];

/** Narrows an untrusted value to a known rank, or null when it is not one. */
export function parseTranslationRank(value: unknown): TranslationRank | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return (TRANSLATION_RANKS as readonly string[]).includes(normalized)
    ? (normalized as TranslationRank)
    : null;
}
