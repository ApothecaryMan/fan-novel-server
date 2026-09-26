import { describe, expect, it } from 'vitest';
import { isUuid, parseBoundedInt } from './adminQueryParams.js';

describe('parseBoundedInt', () => {
  it('falls back for an absent or blank parameter', () => {
    expect(parseBoundedInt(undefined, 20, 1, 100)).toBe(20);
    expect(parseBoundedInt('', 20, 1, 100)).toBe(20);
    expect(parseBoundedInt('   ', 20, 1, 100)).toBe(20);
  });

  it('accepts a whole number inside the bounds', () => {
    expect(parseBoundedInt('50', 20, 1, 100)).toBe(50);
  });

  it('rejects a fractional number, which is the reported bug', () => {
    expect(parseBoundedInt('2.5', 20, 1, 100)).toBeNull();
    expect(parseBoundedInt('1.5', 1, 1, 100)).toBeNull();
  });

  it('rejects non-numeric text rather than coercing it to the fallback', () => {
    expect(parseBoundedInt('abc', 20, 1, 100)).toBeNull();
    expect(parseBoundedInt('NaN', 20, 1, 100)).toBeNull();
    expect(parseBoundedInt('Infinity', 20, 1, 100)).toBeNull();
    expect(parseBoundedInt('-Infinity', 20, 1, 100)).toBeNull();
  });

  it('accepts exponent and hex notation, which Number() resolves to a whole number', () => {
    // 1e3 is 1000 and 0x10 is 16. Both are whole numbers, so both are clamped
    // rather than rejected — the result is still a validated integer, which is
    // all the driver needs. Only values that are genuinely not whole numbers
    // are client errors.
    expect(parseBoundedInt('1e3', 20, 1, 100)).toBe(100);
    expect(parseBoundedInt('0x10', 20, 1, 100)).toBe(16);
  });

  it('clamps into range instead of rejecting an out-of-bounds integer', () => {
    expect(parseBoundedInt('1000', 20, 1, 100)).toBe(100);
    expect(parseBoundedInt('0', 1, 1, 100)).toBe(1);
    expect(parseBoundedInt('-3', 1, 1, 100)).toBe(1);
  });

  it('rejects a value beyond safe integer precision', () => {
    expect(parseBoundedInt('9007199254740993', 20, 1, 100)).toBeNull();
  });
});

describe('isUuid', () => {
  it('accepts a canonical uuid in either case', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(isUuid('A1B2C3D4-E5F6-4789-ABCD-EF0123456789')).toBe(true);
  });

  it('rejects the malformed ids that would fail the uuid cast', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid('00000000-0000-4000-8000-00000000000')).toBe(false);
    expect(isUuid('00000000-0000-4000-8000-0000000000000')).toBe(false);
    expect(isUuid('00000000_0000_4000_8000_000000000000')).toBe(false);
    expect(isUuid("00000000-0000-4000-8000-000000000000' OR 1=1--")).toBe(false);
  });
});
