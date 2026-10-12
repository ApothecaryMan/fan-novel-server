import { describe, expect, it } from 'vitest';
import { decideAvatarHeal, isGoogleHostedPhoto } from './googleAccount.js';

describe('isGoogleHostedPhoto', () => {
  it('matches Google user-content photo hosts only', () => {
    expect(isGoogleHostedPhoto('https://lh3.googleusercontent.com/a/photo')).toBe(true);
    expect(isGoogleHostedPhoto('https://lh6.googleusercontent.com/a/photo')).toBe(true);
    expect(isGoogleHostedPhoto('https://r2.example/custom.png')).toBe(false);
    expect(isGoogleHostedPhoto('https://cdn.test/a.png')).toBe(false);
    expect(isGoogleHostedPhoto('file:///local/pick.jpg')).toBe(false);
    expect(isGoogleHostedPhoto('/uploads/avatars/1_a.png')).toBe(false);
    expect(isGoogleHostedPhoto(undefined)).toBe(false);
    expect(isGoogleHostedPhoto(null)).toBe(false);
    expect(isGoogleHostedPhoto('')).toBe(false);
  });
});

describe('decideAvatarHeal', () => {
  it('fills an empty stored avatar from the fresh value', () => {
    expect(decideAvatarHeal(null, 'https://lh3.googleusercontent.com/a/p')).toBe(
      'https://lh3.googleusercontent.com/a/p'
    );
    expect(decideAvatarHeal(undefined, 'https://r2.example/custom.png')).toBe(
      'https://r2.example/custom.png'
    );
  });

  it('leaves a user customization alone', () => {
    expect(decideAvatarHeal('https://r2.example/custom.png', 'https://lh3.googleusercontent.com/a/p')).toBeUndefined();
    expect(decideAvatarHeal('https://r2.example/custom.png', 'https://r2.example/other.png')).toBeUndefined();
  });

  it('refreshes a stale Google-hosted photo to the fresh one', () => {
    expect(
      decideAvatarHeal(
        'https://lh3.googleusercontent.com/a/old-photo',
        'https://lh3.googleusercontent.com/a/new-photo'
      )
    ).toBe('https://lh3.googleusercontent.com/a/new-photo');
  });

  it('does nothing without a fresh value or when both agree', () => {
    expect(decideAvatarHeal('https://lh3.googleusercontent.com/a/p', null)).toBeUndefined();
    expect(decideAvatarHeal('https://lh3.googleusercontent.com/a/p', 'https://lh3.googleusercontent.com/a/p')).toBeUndefined();
    expect(decideAvatarHeal(null, null)).toBeUndefined();
    expect(decideAvatarHeal('file:///dead/local.jpg', 'https://lh3.googleusercontent.com/a/p')).toBe(
      'https://lh3.googleusercontent.com/a/p'
    );
  });
});
