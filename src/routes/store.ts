import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { storeItems, userEquipped, userInventory, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getCaller } from '../middleware/ownership.js';
import { effectiveReadingPlan } from '../features/readingSync/freeStore.js';
import { ADMIN_GRANT_MAX, PRO_MONTHLY_GRANT } from '../features/economy/config.js';
import { validateItemMetadata } from '../features/economy/itemTypes.js';
import { PurchaseError, equipItem, getBalances, grantPoints, purchaseItem } from '../features/economy/service.js';

export const storeRouter = new Hono();

function err(c: any, e: unknown) {
  if (e instanceof PurchaseError) return c.json({ error: e.code }, e.status);
  noteDbFailure();
  return c.json({ error: 'store unavailable' }, 503);
}

storeRouter.get('/catalog', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const now = new Date();
    const rows = await db.select().from(storeItems).where(eq(storeItems.isActive, true));
    const live = rows.filter((r) =>
      (!r.availableFrom || r.availableFrom <= now) && (!r.availableUntil || r.availableUntil >= now));
    return c.json({ items: live.map((r) => ({ id: r.id, sku: r.sku, type: r.type, name: r.name, pricePoints: r.pricePoints, currency: r.currency, rarity: r.rarity, metadata: r.metadata })) });
  } catch {
    noteDbFailure();
    return c.json({ error: 'store unavailable' }, 503);
  }
});

storeRouter.get('/sync', requireAuth, async (c) => {
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'unauthorized' }, 401);
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const nowMs = Date.now();
    const isPro = effectiveReadingPlan(caller.row, nowMs) === 'pro';
    if (isPro) {
      const month = new Date(nowMs).toISOString().slice(0, 7);
      await grantPoints(db, { userId: caller.row.id, amount: PRO_MONTHLY_GRANT.free, currency: 'free', type: 'reward', key: `pro-monthly:${caller.row.id}:${month}`, source: 'pro_monthly', referenceType: 'pro_month', referenceId: month }).catch(() => null);
    }
    const balances = await getBalances(db, caller.row.id);
    const owned = await db.select({ itemId: userInventory.itemId }).from(userInventory).where(eq(userInventory.userId, caller.row.id));
    const equipped = await db.select({ slot: userEquipped.slot, itemId: userEquipped.itemId }).from(userEquipped).where(eq(userEquipped.userId, caller.row.id));
    const [fresh] = await db.select().from(users).where(eq(users.id, caller.row.id)).limit(1);
    const { parseProfileDecorations } = await import('../domain/profileDecorations.js');
    return c.json({ balances, ownedItemIds: owned.map((o) => o.itemId), equipped, decorations: parseProfileDecorations(fresh?.profileDecorations), serverNow: new Date(nowMs).toISOString() });
  } catch {
    noteDbFailure();
    return c.json({ error: 'store unavailable' }, 503);
  }
});

const purchaseSchema = z.object({ sku: z.string().min(1).max(100), idempotencyKey: z.string().min(8).max(128) });
storeRouter.post('/purchase', requireAuth, async (c) => {
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'unauthorized' }, 401);
  const parsed = purchaseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid purchase' }, 400);
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const isPro = effectiveReadingPlan(caller.row, Date.now()) === 'pro';
    const key = `client:${caller.row.id}:${parsed.data.idempotencyKey}`;
    const res = await purchaseItem(db, { userId: caller.row.id, sku: parsed.data.sku, idempotencyKey: key, isPro });
    return c.json({ success: true, ...res });
  } catch (e) { return err(c, e); }
});

const equipSchema = z.union([
  z.object({ slot: z.enum(['avatar', 'name_effect', 'frame', 'badge']), itemId: z.string().uuid().nullable() }),
  z.object({ slot: z.enum(['name_style', 'banner']), value: z.unknown() }),
]);
storeRouter.put('/equip', requireAuth, async (c) => {
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'unauthorized' }, 401);
  const parsed = equipSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid equip' }, 400);
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const nowMs = Date.now();
    const body = parsed.data as { slot: string; itemId?: string | null; value?: unknown };
    const res = await equipItem(db, {
      userId: caller.row.id, slot: body.slot, itemId: body.itemId ?? null, value: body.value,
      isPro: effectiveReadingPlan(caller.row, nowMs) === 'pro',
      graceUntilMs: typeof caller.row.readingStatsGraceUntil === 'number' ? caller.row.readingStatsGraceUntil : null, nowMs,
    });
    return c.json({ success: true, ...res });
  } catch (e) { return err(c, e); }
});

async function requireAdmin(c: any): Promise<{ caller: Awaited<ReturnType<typeof getCaller>> } | { errorResponse: Response }> {
  const caller = await getCaller(c);
  if (!caller.row) return { errorResponse: c.json({ error: 'unauthorized' }, 401) };
  if (!caller.isAdmin) return { errorResponse: c.json({ error: 'forbidden' }, 403) };
  return { caller };
}

export const storeAdminRouter = new Hono();

const itemSchema = z.object({
  sku: z.string().min(1).max(100), type: z.string().min(1).max(32), name: z.string().min(1).max(200),
  pricePoints: z.number().int().positive(), currency: z.enum(['free', 'pro']),
  rarity: z.string().max(32).optional(), metadata: z.record(z.unknown()).default({}),
});
storeAdminRouter.post('/items', requireAuth, async (c) => {
  const gate = await requireAdmin(c);
  if ('errorResponse' in gate) return gate.errorResponse;
  const parsed = itemSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid item' }, 400);
  const meta = validateItemMetadata(parsed.data.type, parsed.data.metadata);
  if (!meta.ok) return c.json({ error: meta.error }, 400);
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const [row] = await db.insert(storeItems).values({ ...parsed.data, metadata: meta.value as any }).returning();
    return c.json({ success: true, item: row }, 201);
  } catch (e: any) {
    if (String(e?.cause?.code ?? e?.code) === '23505') return c.json({ error: 'sku_taken' }, 409);
    noteDbFailure();
    return c.json({ error: 'store unavailable' }, 503);
  }
});

const itemPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(), pricePoints: z.number().int().positive().optional(),
  rarity: z.string().max(32).nullable().optional(), metadata: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
  availableFrom: z.string().datetime().nullable().optional(), availableUntil: z.string().datetime().nullable().optional(),
});
storeAdminRouter.patch('/items/:id', requireAuth, async (c) => {
  const gate = await requireAdmin(c);
  if ('errorResponse' in gate) return gate.errorResponse;
  const parsed = itemPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid item patch' }, 400);
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const [current] = await db.select().from(storeItems).where(eq(storeItems.id, c.req.param('id'))).limit(1);
    if (!current) return c.json({ error: 'item_unavailable' }, 404);
    if (parsed.data.metadata !== undefined) {
      const meta = validateItemMetadata(current.type, parsed.data.metadata);
      if (!meta.ok) return c.json({ error: meta.error }, 400);
      parsed.data.metadata = meta.value as Record<string, unknown>;
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.pricePoints !== undefined) patch.pricePoints = parsed.data.pricePoints;
    if (parsed.data.rarity !== undefined) patch.rarity = parsed.data.rarity;
    if (parsed.data.metadata !== undefined) patch.metadata = parsed.data.metadata;
    if (parsed.data.isActive !== undefined) patch.isActive = parsed.data.isActive;
    if (parsed.data.availableFrom !== undefined) patch.availableFrom = parsed.data.availableFrom ? new Date(parsed.data.availableFrom) : null;
    if (parsed.data.availableUntil !== undefined) patch.availableUntil = parsed.data.availableUntil ? new Date(parsed.data.availableUntil) : null;
    if (!Object.keys(patch).length) return c.json({ error: 'empty patch' }, 400);
    const [row] = await db.update(storeItems).set(patch).where(eq(storeItems.id, current.id)).returning();
    return c.json({ success: true, item: row });
  } catch (e) { return err(c, e); }
});
const grantSchema = z.object({ userId: z.string().uuid(), amount: z.number().int().min(1).max(ADMIN_GRANT_MAX), currency: z.enum(['free', 'pro']), reason: z.string().min(1).max(500) });
storeAdminRouter.post('/grant', requireAuth, async (c) => {
  const gate = await requireAdmin(c);
  if ('errorResponse' in gate) return gate.errorResponse;
  const parsed = grantSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid grant' }, 400);
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const res = await grantPoints(db, {
      userId: parsed.data.userId, amount: parsed.data.amount, currency: parsed.data.currency,
      type: 'admin_adjust', key: `admin:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      source: 'admin', reason: parsed.data.reason, actorId: gate.caller.row!.id,
    });
    return c.json({ success: true, ...res });
  } catch (e) { return err(c, e); }
});
