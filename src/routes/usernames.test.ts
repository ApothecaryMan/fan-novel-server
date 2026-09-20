import { describe, expect, it } from 'vitest';
import { MAX_PROBES, MAX_SUGGESTIONS, normalizeUsernameCandidate, suggestUsernames, USERNAME_RE } from './usernames.js';

describe('normalizeUsernameCandidate', () => {
  it('accepts valid handles verbatim', () => {
    expect(normalizeUsernameCandidate('Sara_123')).toBe('Sara_123');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeUsernameCandidate('  sara_1  ')).toBe('sara_1');
  });
  it('rejects without repair: too short, too long, bad chars, empty, non-string', () => {
    expect(normalizeUsernameCandidate('ab')).toBeNull();
    expect(normalizeUsernameCandidate('a'.repeat(21))).toBeNull();
    expect(normalizeUsernameCandidate('bad-name!')).toBeNull();
    expect(normalizeUsernameCandidate('  ')).toBeNull();
    expect(normalizeUsernameCandidate(undefined)).toBeNull();
    expect(normalizeUsernameCandidate(42)).toBeNull();
  });
  it('does not lowercase: case is preserved exactly', () => {
    expect(normalizeUsernameCandidate('Sara')).toBe('Sara');
  });
});

describe('suggestUsernames', () => {
  it('returns empty for an invalid base', async () => {
    let probes = 0;
    const out = await suggestUsernames('bad-name!', async () => { probes++; return true; });
    expect(out).toEqual([]);
    expect(probes).toBe(0);
  });
  it('is deterministic for the same taken-set', async () => {
    const taken = new Set(['sara', 'sara_1', 'sara_2']);
    const isTaken = async (c: string) => taken.has(c);
    expect(await suggestUsernames('sara', isTaken)).toEqual(['sara_3', 'sara_4', 'sara_5']);
    expect(await suggestUsernames('sara', isTaken)).toEqual(['sara_3', 'sara_4', 'sara_5']);
  });
  it('caps at MAX_SUGGESTIONS=3 and MAX_PROBES=20', async () => {
    expect(MAX_SUGGESTIONS).toBe(3);
    expect(MAX_PROBES).toBe(20);
    let probes = 0;
    const isTaken = async (_c: string) => { probes++; return true; };
    const out = await suggestUsernames('taken_name', isTaken);
    expect(out).toEqual([]);
    expect(probes).toBe(20);
  });
  it('stops early once 3 free names are found', async () => {
    let probes = 0;
    const taken = new Set(['bob', 'bob_1']);
    const out = await suggestUsernames('bob', async (c: string) => { probes++; return taken.has(c); });
    expect(out).toEqual(['bob_2', 'bob_3', 'bob_4']);
    expect(probes).toBe(4);
  });
  it('every suggestion matches USERNAME_RE', async () => {
    const out = await suggestUsernames('sara', async () => false);
    expect(out).toHaveLength(3);
    for (const s of out) expect(USERNAME_RE.test(s)).toBe(true);
  });
  it('truncates 20-char bases so base_n still fits 20 chars and matches RE', async () => {
    const base = 'a'.repeat(20);
    const out = await suggestUsernames(base, async () => false);
    expect(out).toEqual([`${'a'.repeat(18)}_1`, `${'a'.repeat(18)}_2`, `${'a'.repeat(18)}_3`]);
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(20);
      expect(USERNAME_RE.test(s)).toBe(true);
    }
  });
  it('handles two-digit suffixes within 20 chars', async () => {
    const base = 'b'.repeat(20);
    const taken = new Set([...Array.from({ length: 9 }, (_, i) => `${'b'.repeat(18)}_${i + 1}`), `${'b'.repeat(17)}_10`, `${'b'.repeat(17)}_11`]);
    const out = await suggestUsernames(base, async (c: string) => taken.has(c));
    expect(out[0]).toBe(`${'b'.repeat(17)}_12`);
    expect(out[0].length).toBeLessThanOrEqual(20);
    expect(USERNAME_RE.test(out[0])).toBe(true);
  });
  it('returns empty when the table is adversarially saturated', async () => {
    const base = 'zed';
    const taken = new Set(Array.from({ length: 20 }, (_, i) => `zed_${i + 1}`));
    const out = await suggestUsernames(base, async (c: string) => taken.has(c));
    expect(out).toEqual([]);
  });
});
