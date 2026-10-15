import { z } from 'zod';

const base = z.object({ proExclusive: z.boolean().default(false) });

export const avatarMetadataSchema = base.extend({ frameKey: z.string().min(1).max(200) }).strict();
export const nameEffectMetadataSchema = base.extend({ styleId: z.string().min(1).max(100) }).strict();
export const frameMetadataSchema = base.extend({ frameKey: z.string().min(1).max(200) }).strict();
export const badgeMetadataSchema = base.extend({ badgeKey: z.string().min(1).max(100) }).strict();

export const ITEM_TYPES = ['avatar', 'profile_effect', 'frame', 'badge'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

const REGISTRY = { avatar: avatarMetadataSchema, profile_effect: nameEffectMetadataSchema, frame: frameMetadataSchema, badge: badgeMetadataSchema } as const;

export function validateItemMetadata(type: string, metadata: unknown) {
  const schema = (REGISTRY as Record<string, z.ZodTypeAny>)[type];
  if (!schema) return { ok: false as const, error: 'unknown_type' };
  const parsed = schema.safeParse(metadata ?? {});
  return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const, error: 'invalid_metadata', issues: parsed.error.issues };
}

export const SLOT_FOR_TYPE: Record<string, string> = { avatar: 'avatar', profile_effect: 'profile_effect', frame: 'frame', badge: 'badge' };
