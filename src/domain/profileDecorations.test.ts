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

const nameStyleV2: NonNullable<ProfileDecorations['nameStyle']> = {
  v: 2,
  fillMode: 'linear',
  c1: '#ff5e9c', c2: '#7b61ff', c3: '#27e1ff',
  angle: 90, mid: 50, stripe: 10, gloss: 0,
  sw: 0, sc: '#000000', sw2: 0, sc2: '#ffffff', bevel: 0,
  glowR: 0, glowR2: 0, glowI: 80, glowC: '#ff2bd6', glowC2: '#7a2bff', split: 0,
  exD: 0, exA: 45, exC1: '#4b2bb5', exC2: '#1a0f4d', exFade: 0,
  shD: 0, shB: 8, shC: '#000000', shA: 90,
  size: 56, weight: 900, spacing: 0,
  skew: 0, rot: 0, tx: 0, ty: 0, sy: 100,
  upper: false,
  hue: 0, sat: 100, bri: 100,
};

const valid: ProfileDecorations = {
  nameStyle: nameStyleV2,
  bannerGradient: { target: 'banner', color: '#FF7043', fade: 'soft', extent: 'mid', strength: 60 },
  avatarFrameKey: 'fan_avatar/gold_avatar_frame_512.png',
};

describe('parseProfileDecorations', () => {
  it('accepts every field at once', () => {
    expect(parseProfileDecorations(valid)).toEqual(valid);
  });

  it('accepts any subset, because each decoration is independent', () => {
    expect(parseProfileDecorations({ nameStyle: nameStyleV2 })).toEqual({ nameStyle: nameStyleV2 });
    expect(parseProfileDecorations({ avatarFrameKey: 'fan_avatar/fire_avatar_frame_full_quality.png' }))
      .toEqual({ avatarFrameKey: 'fan_avatar/fire_avatar_frame_full_quality.png' });
  });

  it('treats null and undefined as no decorations', () => {
    expect(parseProfileDecorations(null)).toBeNull();
    expect(parseProfileDecorations(undefined)).toBeNull();
  });

  // A fill mode or version this build does not know (written by a newer
  // client) must read as nothing. Rendering the known parts would be a
  // partial card, which is worse than none.
  it('rejects an unknown name-style fill mode or version rather than half-reading it', () => {
    expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, fillMode: 'hologram' } })).toBeNull();
    expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, v: 3 } })).toBeNull();
  });

  it('rejects an out-of-range or non-finite name-style number', () => {
    for (const bad of [-1, 111, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, size: bad } })).toBeNull();
    }
    expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, split: 11 } })).toBeNull();
  });

  it('rejects a name style missing a required field', () => {
    expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, glowI: undefined } })).toBeNull();
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
      expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, c1: bad } })).toBeNull();
    }
  });

  it('accepts the 3, 6 and 8 digit hex forms the client allows', () => {
    for (const hex of ['#f70', '#ff7043', '#ff7043cc']) {
      expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, c1: hex, c2: hex } })).not.toBeNull();
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
    for (const bad of ['fire', 42, [valid], { nameStyle: 'fire' }]) {
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

  // The sheet-frame key and effect name are validated by SHAPE, not against a
  // fixed catalogue — the remote R2 catalog grows without a server deploy, so
  // pinning the server to known values would 400 every save carrying a new
  // decoration (the whole PATCH fails, not just the new field).
  it('accepts profile frame keys and effect names, including future ones', () => {
    expect(parseProfileDecorations({
      profileFrameKey: 'profile_frames/999_new.png',
      profileEffectName: 'Future Effect',
    })).toEqual({
      profileFrameKey: 'profile_frames/999_new.png',
      profileEffectName: 'Future Effect',
    });
  });

  it('rejects an empty or absurdly long frame key or effect name', () => {
    expect(parseProfileDecorations({ profileFrameKey: '' })).toBeNull();
    expect(parseProfileDecorations({ profileFrameKey: 'a'.repeat(201) })).toBeNull();
    expect(parseProfileDecorations({ profileEffectName: '' })).toBeNull();
    expect(parseProfileDecorations({ profileEffectName: 'a'.repeat(101) })).toBeNull();
  });
});

describe('isEmptyDecorations', () => {
  it('is true for null and for an object with nothing to draw', () => {
    expect(isEmptyDecorations(null)).toBe(true);
    expect(isEmptyDecorations({})).toBe(true);
  });

  it('is false as soon as one decoration would render', () => {
    expect(isEmptyDecorations({ avatarFrameKey: 'fan_avatar/gold_avatar_frame_512.png' })).toBe(false);
    expect(isEmptyDecorations({ nameStyle: nameStyleV2 })).toBe(false);
    expect(isEmptyDecorations({ profileFrameKey: 'profile_frames/999_new.png' })).toBe(false);
    expect(isEmptyDecorations({ profileEffectName: 'Future Effect' })).toBe(false);
  });
});

describe('profileDecorationsSchema', () => {
  it('is strict: an extra key inside a legacy-style sub-object is rejected', () => {
    expect(profileDecorationsSchema.safeParse({
      bannerGradient: { target: 'banner', color: '#FF7043', fade: 'soft', extent: 'mid', strength: 60, glow: true },
    }).success).toBe(false);
  });

  // The inner nameStyle object is deliberately LENIENT: a future client field
  // must survive an old server instead of 400ing the whole save. Unknown keys
  // ride along untouched so nothing is lost on the round trip.
  it('preserves an unknown future nameStyle key instead of rejecting the save', () => {
    const out = parseProfileDecorations({ nameStyle: { ...nameStyleV2, glowX: 1 } });
    expect(out).not.toBeNull();
    expect((out?.nameStyle as Record<string, unknown>).glowX).toBe(1);
  });

  it('accepts an optional font family within its length bound', () => {
    expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, fontFamily: 'Thmanyah' } })).not.toBeNull();
    expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, fontFamily: '' } })).toBeNull();
    expect(parseProfileDecorations({ nameStyle: { ...nameStyleV2, fontFamily: 'a'.repeat(101) } })).toBeNull();
  });

  it('rejects an absurdly large name style even when every field is valid', () => {
    expect(parseProfileDecorations({
      nameStyle: { ...nameStyleV2, futureBlob: 'a'.repeat(5000) },
    })).toBeNull();
  });
});
