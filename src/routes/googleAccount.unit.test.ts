import { describe, expect, it } from 'vitest';
import { cleanMediaUrl } from './googleAccount.js';

describe('cleanMediaUrl', () => {
  it('accepts remote http(s) image URLs', () => {
    expect(cleanMediaUrl('https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
    expect(cleanMediaUrl('https://r2.example/custom.png')).toBe('https://r2.example/custom.png');
  });

  it('accepts server-relative upload paths', () => {
    expect(cleanMediaUrl('/uploads/avatars/1_a.png')).toBe('/uploads/avatars/1_a.png');
    expect(cleanMediaUrl('/uploads/banners/1_b.webp')).toBe('/uploads/banners/1_b.webp');
    expect(cleanMediaUrl('/uploads/covers/1_c.jpg')).toBe('/uploads/covers/1_c.jpg');
  });

  it('rejects device file URIs and empty values', () => {
    expect(cleanMediaUrl('file:///local/pick.jpg')).toBeUndefined();
    expect(cleanMediaUrl('')).toBeUndefined();
    expect(cleanMediaUrl(undefined)).toBeUndefined();
    expect(cleanMediaUrl(null)).toBeUndefined();
  });
});
