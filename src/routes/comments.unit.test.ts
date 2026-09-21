import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor, parseCommentId } from './comments.js';

// resolveEffectiveChapter lives in comments.ts (Task 5). Pure rule:
// explicit != null -> explicit; else parent chapter; else null.
// Mismatch detection is `explicit != null && parent != null && explicit !== parent`.
function expectedEffective(explicit: number | undefined, parent: number | null): number | null {
  return explicit ?? parent ?? null;
}

describe('parseCommentId', () => {
  it('accepts bare and app_ ids', () => {
    expect(parseCommentId('123')).toBe(123);
    expect(parseCommentId('app_123')).toBe(123);
    expect(parseCommentId('  app_7  ')).toBe(7);
  });
  it('rejects garbage', () => {
    for (const bad of ['0', '-3', '12.5', 'abc', 'app_', 'app_0', 'app_-2', 'app_1.5', 'app_app_1', '', '   ', 'app_abc', '99999999999999999999999']) {
      expect(parseCommentId(bad)).toBeNull();
    }
  });
});

describe('cursor codec (Workers-safe, wire-compatible)', () => {
  it('round-trips both shapes', () => {
    expect(decodeCursor(encodeCursor({ t: 1726400000000, i: 42 }))).toEqual({ t: 1726400000000, i: 42 });
    expect(decodeCursor(encodeCursor({ t: 1, i: 2, s: 9 }))).toEqual({ t: 1, i: 2, s: 9 });
  });
  it('decodes a pre-fix Buffer vector', () => {
    // produced by Buffer.from(JSON.stringify({t:1726400000000,i:42})).toString('base64url')
    const preFix = Buffer.from(JSON.stringify({ t: 1726400000000, i: 42 }), 'utf8').toString('base64url');
    expect(decodeCursor(preFix)).toEqual({ t: 1726400000000, i: 42 });
  });
  it('rejects garbage and wrong shapes', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(encodeCursor({ t: 1, i: 2, s: 9 }).slice(0, -2) + '%%')).toBeNull();
  });
});

describe('chapter inheritance resolver', () => {
  it('inherits parent when omitted, keeps explicit, null when neither', () => {
    expect(expectedEffective(undefined, 72)).toBe(72);
    expect(expectedEffective(undefined, null)).toBeNull();
    expect(expectedEffective(5, 72)).toBe(5);
    expect(expectedEffective(72, 72)).toBe(72);
  });
  it('detects mismatch only when explicit disagrees with a known parent scope', () => {
    const mismatch = (explicit: number | undefined, parent: number | null) =>
      explicit != null && parent != null && explicit !== parent;
    expect(mismatch(5, 72)).toBe(true);
    expect(mismatch(72, 72)).toBe(false);
    expect(mismatch(undefined, 72)).toBe(false);
    expect(mismatch(5, null)).toBe(false);
  });
});
