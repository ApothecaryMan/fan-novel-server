import { describe, expect, it } from 'vitest';
import { buildUploadFilename, parseUploadKey } from './objectStore.js';

describe('objectStore naming', () => {
  it('builds collision-free uuid filenames per mime', () => {
    const a = buildUploadFilename('avatars', 'image/png');
    const b = buildUploadFilename('avatars', 'image/png');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
    expect(b).toMatch(/^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
  });

  it('maps mime to extension', () => {
    expect(buildUploadFilename('banners', 'image/webp')).toMatch(/\.webp$/);
    expect(buildUploadFilename('covers', 'image/jpeg')).toMatch(/\.jpg$/);
  });

  it('parses owned keys from relative urls only', () => {
    expect(parseUploadKey('/uploads/avatars/550e8400-e29b-41d4-a716-446655440000.png')).toBe(
      'avatars/550e8400-e29b-41d4-a716-446655440000.png',
    );
    expect(parseUploadKey('https://cdn.test/a.png')).toBeNull();
    expect(parseUploadKey('file:///local/pick.jpg')).toBeNull();
    expect(parseUploadKey(null)).toBeNull();
  });
});
