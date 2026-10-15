/**
 * Profile decorations — the display-name effect, the banner wash, and the
 * avatar frame a reader picked for their own profile card.
 *
 * These were device-local (AsyncStorage) and invisible to everyone else. They
 * are now server-owned so a visitor opening the card sees what the owner chose.
 *
 * The shapes here MIRROR the app's models exactly and deliberately do NOT drift:
 *
 *   Fan Novel/src/features/profile/nameStyle.ts   NameStyleConfig (v: 2 only)
 *   Fan Novel/src/features/profile/bannerGradient.ts BannerGradient
 *   Fan Novel/src/features/decorations/fanAvatarFrames.ts  frame keys
 *
 * There is no v1 path: the app is still in development, no legacy row exists,
 * and the client normalizes with `normalizeNameStyle` before rendering, so a
 * value this build cannot draw renders plain rather than throwing.
 *
 * ONE jsonb column, not three columns. A single atomic value makes a
 * half-updated card impossible, and a decoration added next year needs no
 * migration. Measured cost of the worst case (all three chosen, full-length R2
 * frame key) is 276 bytes of jsonb per user; null costs one bit in the row's
 * null map.
 */

import { z } from 'zod';

export const NAME_STYLE_FILL_MODES = ['solid', 'linear', 'stripes', 'metal', 'rainbow'] as const;
export type NameStyleFillMode = (typeof NAME_STYLE_FILL_MODES)[number];

export const BANNER_TARGETS = ['banner', 'below'] as const;
export type BannerTarget = (typeof BANNER_TARGETS)[number];

export const BANNER_FADES = ['sharp', 'smooth', 'soft'] as const;
export type BannerFade = (typeof BANNER_FADES)[number];

export const BANNER_EXTENTS = ['low', 'mid', 'full'] as const;
export type BannerExtent = (typeof BANNER_EXTENTS)[number];

/**
 * Same hex domain the client's own `HEX_RE` accepts: 3, 6 or 8 digits. A 4-digit
 * form is deliberately NOT accepted, because the app's regex does not accept it
 * either and the two must agree on what a stored colour can be.
 */
const hex = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

/**
 * Frame key: an `fan_avatar/...` path into the R2 bucket. NOT validated against
 * the client's 10-key catalogue here — that list is a client asset and will grow;
 * pinning the server to it would reject keys a newer client already knows. The
 * client validates with `isFanAvatarFrameKey` and falls back to no frame, which
 * is the same trust-nothing read the other two fields get.
 */
/** Bounded number mirroring the client's editor ranges exactly. */
const num = (min: number, max: number) => z.number().finite().min(min).max(max);

/**
 * The v2 studio style. Bounds mirror the client's NUM_RANGES one-for-one; a
 * value the picker cannot produce is a tampered payload and fails the save.
 *
 * Deliberately NOT strict: unknown keys ride along untouched (capped by total
 * size below) so a future client field survives an old server instead of
 * 400ing the whole save. The top-level object stays strict — only this inner
 * shape is lenient, and only because styles grow field-by-field.
 */
export const nameStyleSchema = z.object({
  v: z.literal(2),
  fillMode: z.enum(NAME_STYLE_FILL_MODES),
  c1: hex, c2: hex, c3: hex,
  angle: num(0, 360), mid: num(5, 95), stripe: num(3, 40), gloss: num(0, 100),
  sw: num(0, 14), sc: hex, sw2: num(0, 14), sc2: hex, bevel: num(0, 6),
  glowR: num(0, 30), glowR2: num(0, 80), glowI: num(0, 100), glowC: hex, glowC2: hex, split: num(0, 10),
  exD: num(0, 40), exA: num(0, 360), exC1: hex, exC2: hex, exFade: num(0, 100),
  shD: num(0, 40), shB: num(0, 30), shC: hex, shA: num(0, 360),
  fontFamily: z.string().min(1).max(100).optional(),
  size: num(20, 110), weight: num(100, 900), spacing: num(-4, 30),
  skew: num(-30, 30), rot: num(-30, 30), tx: num(-60, 60), ty: num(-60, 60), sy: num(50, 150),
  upper: z.boolean(),
  hue: num(0, 360), sat: num(0, 250), bri: num(40, 180),
}).passthrough().refine((v) => JSON.stringify(v).length <= 4096, {
  message: 'nameStyle too large',
});

export const bannerGradientSchema = z.object({
  target: z.enum(BANNER_TARGETS),
  color: hex,
  /** 0..100 — 0 IS the off state, which is why there is no separate flag. */
  strength: z.number().finite().min(0).max(100),
  fade: z.enum(BANNER_FADES),
  extent: z.enum(BANNER_EXTENTS),
}).strict();

export const profileDecorationsSchema = z.object({
  nameStyle: nameStyleSchema.optional(),
  bannerGradient: bannerGradientSchema.optional(),
  avatarFrameKey: z.string().min(1).max(200).optional(),
  /**
   * Sheet-frame key: a `profile_frames/...` path into the R2 bucket. Shape only,
   * like the avatar frame — the remote catalog grows without a server deploy,
   * so an enum here would 400 every save carrying a new frame (the whole PATCH
   * fails, not just the new field). The client validates and falls back.
   */
  profileFrameKey: z.string().min(1).max(200).optional(),
  /**
   * Profile-effect name from the remote catalog. Free-form string for the same
   * reason: new effects must save without a server change. Length mirrors the
   * client's own effect-name bound.
   */
  profileEffectName: z.string().min(1).max(100).optional(),
}).strict();

export type ProfileDecorations = z.infer<typeof profileDecorationsSchema>;

/**
 * Trust-nothing read of a stored column.
 *
 * Returns null for anything the schema rejects — a tampered row, a value written
 * by a newer client, or JSON that drifted. A visitor then sees a plain card
 * rather than a half-rendered one, which is the same degradation the client's own
 * normalizers produce.
 */
export function parseProfileDecorations(raw: unknown): ProfileDecorations | null {
  if (raw === null || raw === undefined) return null;
  const parsed = profileDecorationsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** True when the value carries nothing a renderer would draw. */
export function isEmptyDecorations(value: ProfileDecorations | null): boolean {
  return !value || (!value.nameStyle && !value.bannerGradient && !value.avatarFrameKey && !value.profileFrameKey && !value.profileEffectName);
}

/**
 * Pro gate for studio customs. nameStyle/bannerGradient are Pro-only and end
 * with the subscription: without an active Pro they read as absent,
 * immediately, on every surface. Owned slots pass through untouched; a value
 * emptied by the strip reads as null so renderers see plain, not partial.
 */
export function stripGatedCustoms(value: ProfileDecorations | null, isPro: boolean): ProfileDecorations | null {
  if (isPro || !value) return value;
  const { nameStyle: _dropStyle, bannerGradient: _dropBanner, ...rest } = value;
  void _dropStyle;
  void _dropBanner;
  return isEmptyDecorations(rest as ProfileDecorations) ? null : (rest as ProfileDecorations);
}
