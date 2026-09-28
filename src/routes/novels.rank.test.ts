import { describe, expect, it } from 'vitest';
import { toApi } from './novels.js';

// The translation grade is server-authored. The client hides its badge purely
// on this value, so the API contract is: an unranked novel must serialize as an
// explicit `null` — never a default tier, never omitted — and a ranked one must
// come through untouched. Any placeholder here would show a false grade.

function row(translationRank: string | null): Parameters<typeof toApi>[0] {
  return {
    id: 'novel_1',
    title: 'Novel',
    originalTitle: null,
    author: 'Author',
    translator: null,
    status: 'مستمرة',
    category: 'رواية',
    tags: [],
    rating: 50,
    readersCount: '0',
    totalChapters: 0,
    coverUrl: '',
    summary: '',
    featuredRank: null,
    commentsEnabled: true,
    authorUserId: null,
    translatorUserId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    translationRank,
  } as unknown as Parameters<typeof toApi>[0];
}

describe('toApi translation grade', () => {
  it('serializes an unranked novel as an explicit null', () => {
    const data = toApi(row(null));
    expect(data.translationRank).toBeNull();
    // Must survive JSON round-trip as null, not vanish into undefined.
    expect(JSON.parse(JSON.stringify(data)).translationRank).toBeNull();
    expect('translationRank' in data).toBe(true);
  });

  it('passes every valid tier through unchanged', () => {
    for (const rank of ['B', 'A', 'S', 'S+'] as const) {
      expect(toApi(row(rank)).translationRank).toBe(rank);
    }
  });

  it('degrades an unrecognized stored value to null instead of leaking it', () => {
    expect(toApi(row('SS')).translationRank).toBeNull();
    expect(toApi(row('4')).translationRank).toBeNull();
    expect(toApi(row(' b ')).translationRank).toBe('B');
  });
});
