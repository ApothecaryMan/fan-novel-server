/**
 * Profile decorations — the display-name effect, the banner wash, and the
 * avatar frame a reader picked for their own profile card.
 *
 * These were device-local (AsyncStorage) and invisible to everyone else. They
 * are now server-owned so a visitor opening the card sees what the owner chose.
 *
 * The shapes here MIRROR the app's models exactly and deliberately do NOT drift:
 *
 *   Fan Novel/src/features/profile/nameEffect.ts   NameEffect
 *   Fan Novel/src/features/profile/bannerGradient.ts BannerGradient
 *   Fan Novel/src/features/decorations/fanAvatarFrames.ts  frame keys
 *
 * The client already normalizes a stored value with `normalizeNameEffect` /
 * `normalizeBannerGradient` before rendering, so an older build that meets a kind
 * or key it does not know renders plain rather than throwing. That is the
 * forward-compatibility guarantee: the SERVER may learn a new kind before a
 * client can draw it, and the only cost is that it renders plain until the
 * client updates.
 *
 * ONE jsonb column, not three columns. A single atomic value makes a
 * half-updated card impossible, and a decoration added next year needs no
 * migration. Measured cost of the worst case (all three chosen, full-length R2
 * frame key) is 276 bytes of jsonb per user; null costs one bit in the row's
 * null map.
 */

import { z } from 'zod';

export const NAME_EFFECT_KINDS = [
  'plain', 'solid', 'gradient', 'glitter', 'outline',
  'rainbow', 'neon', 'fire', 'gold', 'ice', 'sunset', 'matrix', 'retro', 'sparkle',
] as const;
export type NameEffectKind = (typeof NAME_EFFECT_KINDS)[number];

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
export const nameEffectSchema = z.object({
  kind: z.enum(NAME_EFFECT_KINDS),
  color: hex,
  color2: hex,
}).strict();

export const bannerGradientSchema = z.object({
  target: z.enum(BANNER_TARGETS),
  color: hex,
  /** 0..100 — 0 IS the off state, which is why there is no separate flag. */
  strength: z.number().finite().min(0).max(100),
  fade: z.enum(BANNER_FADES),
  extent: z.enum(BANNER_EXTENTS),
}).strict();

export const profileDecorationsSchema = z.object({
  nameEffect: nameEffectSchema.optional(),
  bannerGradient: bannerGradientSchema.optional(),
  avatarFrameKey: z.string().min(1).max(200).optional(),
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
  return !value || (!value.nameEffect && !value.bannerGradient && !value.avatarFrameKey);
}
