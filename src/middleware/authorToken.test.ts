import { describe, it, expect } from 'vitest';
import { generatePat, hashPat, isPatFormat, PAT_PREFIX } from './authorToken.js';

describe('author PAT helpers (pure, no DB)', () => {
  it('mints unique tokens with the fn_pat_ prefix', () => {
    const a = generatePat();
    const b = generatePat();
    expect(a.startsWith(PAT_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(50);
  });

  it('hashes deterministically to 64 hex chars', async () => {
    const pat = generatePat();
    const h1 = await hashPat(pat);
    const h2 = await hashPat(pat);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    const other = await hashPat(generatePat());
    expect(other).not.toBe(h1);
  });

  it('recognizes PAT format and rejects session JWTs', () => {
    expect(isPatFormat(generatePat())).toBe(true);
    expect(isPatFormat('eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe(false);
    expect(isPatFormat('fn_pat_')).toBe(false);
    expect(isPatFormat('')).toBe(false);
  });
});
