import { describe, expect, it } from 'vitest';
import { escapeLikePattern } from './adminUserSearch.js';

describe('escapeLikePattern', () => {
  it('leaves an ordinary term untouched', () => {
    expect(escapeLikePattern('ahmed')).toBe('ahmed');
  });

  it('escapes the percent wildcard so it cannot match every row', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
  });

  it('escapes the underscore wildcard', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('escapes backslashes before escaping wildcards', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('returns an empty string for an empty term', () => {
    expect(escapeLikePattern('')).toBe('');
  });

  it('escapes every metacharacter in a mixed term', () => {
    expect(escapeLikePattern('50%_off\\now')).toBe('50\\%\\_off\\\\now');
  });
});
