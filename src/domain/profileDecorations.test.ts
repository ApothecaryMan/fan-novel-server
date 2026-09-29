import { describe, it, expect } from 'vitest';
import {
  parseProfileDecorations,
  isEmptyDecorations,
  profileDecorationsSchema,
  type ProfileDecorations,
} from './profileDecorations.js';

// The server is the authority for a stored decoration, but the CLIENT is what
// actually draws it — and the client may be older than the row. Every rule
// below exists so that a value this build cannot draw degrades to "plain"
// instead of reaching a renderer as something it will throw on.

const valid: ProfileDecorations = {
  nameEffect: { kind: 'fire', color: '#FF7043', color2: '#FFD740' },
  bannerGradient: { target: 'banner', color: '#FF7043', fade: 'soft', extent: 'mid', strength: 60 },
  avatarFrameKey: 'fan_avatar/gold_avatar_frame_512.png',
};

describe('parseProfileDecorations', () => {
  it('accepts every field at once', () => {
    expect(parseProfileDecorations(valid)).toEqual(valid);
  });

  it('accepts any subset, because each decoration is independent', () => {
    expect(parseProfileDecorations({ nameEffect: valid.nameEffect })).toEqual({ nameEffect: valid.nameEffect });
    expect(parseProfileDecorations({ avatarFrameKey: 'fan_avatar/fire_avatar_frame_full_quality.png' }))
      .toEqual({ avatarFrameKey: 'fan_avatar/fire_avatar_frame_full_quality.png' });
  });

  it('treats null and undefined as no decorations', () => {
    expect(parseProfileDecorations(null)).toBeNull();
    expect(parseProfileDecorations(undefined)).toBeNull();
  });

  // A kind this build does not know yet (written by a newer client) must read as
  // nothing. Rendering the known parts would be a partial card, which is worse
  // than none and is exactly the failure the client normalizer cannot see.
  it('rejects an unknown name-effect kind rather than half-reading it', () => {
    expect(parseProfileDecorations({ nameEffect: { ...valid.nameEffect, kind: 'hologram' } })).toBeNull();
  });

  it('rejects an unknown banner target, fade and extent', () => {
    const base = valid.bannerGradient!;
    expect(parseProfileDecorations({ bannerGradient: { ...base, target: 'overlay' } })).toBeNull();
    expect(parseProfileDecorations({ bannerGradient: { ...base, fade: 'linear' } })).toBeNull();
    expect(parseProfileDecorations({ bannerGradient: { ...base, extent: 'huge' } })).toBeNull();
  });

  // The hex domain must match the client's own HEX_RE exactly, or a colour the
  // client would reject could be stored and then render as nothing.
  it('rejects a colour outside the client hex domain', () => {
    for (const bad of ['red', '#12345', 'FF7043', '#GGGGGG', '#1234']) {
      expect(parseProfileDecorations({ nameEffect: { ...valid.nameEffect!, color: bad } })).toBeNull();
    }
  });

  it('accepts the 3, 6 and 8 digit hex forms the client allows', () => {
    for (const hex of ['#f70', '#ff7043', '#ff7043cc']) {
      expect(parseProfileDecorations({ nameEffect: { kind: 'solid', color: hex, color2: hex } })).not.toBeNull();
    }
  });

  it('rejects an out-of-range or non-finite strength', () => {
    const base = valid.bannerGradient!;
    for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseProfileDecorations({ bannerGradient: { ...base, strength: bad } })).toBeNull();
    }
  });

  it('accepts the 0 and 100 strength bounds — 0 is the deliberate off state', () => {
    const base = valid.bannerGradient!;
    expect(parseProfileDecorations({ bannerGradient: { ...base, strength: 0 } })).not.toBeNull();
    expect(parseProfileDecorations({ bannerGradient: { ...base, strength: 100 } })).not.toBeNull();
  });

  // An unknown TOP-LEVEL key means a newer client stored something this build
  // does not model. Rejecting the whole value is deliberate: silently dropping
  // the unknown key would let a card render "partly".
  it('rejects an unknown top-level key', () => {
    expect(parseProfileDecorations({ ...valid, bannerEffectUrl: 'https://cdn.test/x.gif' })).toBeNull();
  });

  it('rejects a non-object and a stray array', () => {
    for (const bad of ['fire', 42, [valid], { nameEffect: 'fire' }]) {
      expect(parseProfileDecorations(bad)).toBeNull();
    }
  });

  // A frame key is NOT checked against the client's 10-key catalogue on purpose:
  // that list is a client asset and will grow, so pinning the server to it would
  // reject keys a newer client already knows. The client validates and falls
  // back to no frame.
  it('accepts an unknown frame key rather than rejecting the whole card', () => {
    const out = parseProfileDecorations({ avatarFrameKey: 'fan_avatar/not_yet_shipped.png' });
    expect(out).toEqual({ avatarFrameKey: 'fan_avatar/not_yet_shipped.png' });
  });

  it('rejects a frame key that is empty or absurdly long', () => {
    expect(parseProfileDecorations({ avatarFrameKey: '' })).toBeNull();
    expect(parseProfileDecorations({ avatarFrameKey: 'a'.repeat(201) })).toBeNull();
  });
});

describe('isEmptyDecorations', () => {
  it('is true for null and for an object with nothing to draw', () => {
    expect(isEmptyDecorations(null)).toBe(true);
    expect(isEmptyDecorations({})).toBe(true);
  });

  it('is false as soon as one decoration would render', () => {
    expect(isEmptyDecorations({ avatarFrameKey: 'fan_avatar/gold_avatar_frame_512.png' })).toBe(false);
    expect(isEmptyDecorations({ nameEffect: valid.nameEffect })).toBe(false);
  });
});

describe('profileDecorationsSchema', () => {
  it('is strict: an extra key inside a sub-object is rejected too', () => {
    expect(profileDecorationsSchema.safeParse({
      nameEffect: { ...valid.nameEffect, glow: true },
    }).success).toBe(false);
  });
});
