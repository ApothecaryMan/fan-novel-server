import { and, eq, sql, sum } from 'drizzle-orm';
import { iapPurchases, pointTransactions, storeItems, userCoinBalances, userEquipped, userInventory, users } from '../../database/schema.js';
import { DAILY_REWARD_CAP, PRO_DISCOUNT_PERCENT, isCappedSource } from './config.js';

export class PurchaseError extends Error {
  code: string;
  status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 500;
  constructor(code: string, status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 500, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

type Tx = Parameters<Parameters<{ transaction: (fn: (tx: never) => Promise<never>) => Promise<never> }['transaction']>[0]>[0];
type Db = { transaction: (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown> } & Record<string, unknown>;

function dayStartMs(nowMs: number): Date {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function lockedWallet(tx: any, userId: string, currency: string) {
  await tx.insert(userCoinBalances).values({ userId, currency, balance: 0 }).onConflictDoNothing();
  const rows = await tx.select().from(userCoinBalances)
    .where(and(eq(userCoinBalances.userId, userId), eq(userCoinBalances.currency, currency))).for('update');
  if (rows.length) return rows[0];
  throw new PurchaseError('wallet_unavailable', 500);
}

async function idempotencyHit(tx: any, userId: string, key: string) {
  const rows = await tx.select({ id: pointTransactions.id }).from(pointTransactions)
    .where(and(eq(pointTransactions.userId, userId), eq(pointTransactions.idempotencyKey, key))).limit(1);
  return rows.length > 0;
}

export function applyProDiscount(price: number, isPro: boolean): number {
  if (!isPro) return price;
  return Math.max(1, Math.floor(price * (100 - PRO_DISCOUNT_PERCENT) / 100));
}

export async function grantPoints(db: any, opts: {
  userId: string; amount: number; currency: string; type: string; key: string;
  source: string; referenceType?: string; referenceId?: string; reason?: string; actorId?: string; nowMs?: number;
}): Promise<{ status: 'granted' | 'capped' | 'replayed'; granted: number; balance: number }> {
  return db.transaction(async (tx: any) => {
    const wallet = await lockedWallet(tx, opts.userId, opts.currency);
    if (await idempotencyHit(tx, opts.userId, opts.key)) return { status: 'replayed' as const, granted: 0, balance: wallet.balance };
    let finalAmount = opts.amount;
    if (isCappedSource(opts.source)) {
      const cap = DAILY_REWARD_CAP[opts.currency as 'free' | 'pro'] ?? 0;
      const dayStart = dayStartMs(opts.nowMs ?? Date.now());
      const [row] = await tx.select({ total: sum(pointTransactions.amount) }).from(pointTransactions).where(and(
        eq(pointTransactions.userId, opts.userId), eq(pointTransactions.currency, opts.currency),
        eq(pointTransactions.type, 'reward'), sql`${pointTransactions.createdAt} >= ${dayStart}`,
      ));
      const used = Number(row?.total ?? 0);
      const remaining = cap - used;
      if (remaining <= 0) return { status: 'capped' as const, granted: 0, balance: wallet.balance };
      finalAmount = Math.min(finalAmount, remaining);
    }
    const balanceAfter = wallet.balance + finalAmount;
    await tx.insert(pointTransactions).values({
      userId: opts.userId, amount: finalAmount, balanceAfter, currency: opts.currency, type: opts.type,
      referenceType: opts.referenceType, referenceId: opts.referenceId, idempotencyKey: opts.key,
      reason: opts.reason, actorId: opts.actorId,
    });
    await tx.update(userCoinBalances).set({ balance: balanceAfter, updatedAt: new Date() })
      .where(and(eq(userCoinBalances.userId, opts.userId), eq(userCoinBalances.currency, opts.currency)));
    return { status: 'granted' as const, granted: finalAmount, balance: balanceAfter };
  });
}

export async function purchaseItem(db: any, opts: { userId: string; sku: string; idempotencyKey: string; isPro: boolean }) {
  return db.transaction(async (tx: any) => {
    const [item] = await tx.select().from(storeItems).where(eq(storeItems.sku, opts.sku)).limit(1);
    if (!item || !item.isActive) throw new PurchaseError('item_unavailable', 404);
    const now = new Date();
    if ((item.availableFrom && item.availableFrom > now) || (item.availableUntil && item.availableUntil < now)) {
      throw new PurchaseError('item_unavailable', 404);
    }
    const wallet = await lockedWallet(tx, opts.userId, item.currency);
    if (await idempotencyHit(tx, opts.userId, opts.idempotencyKey)) return { replayed: true, balance: wallet.balance };
    const owned = await tx.select({ id: userInventory.id }).from(userInventory)
      .where(and(eq(userInventory.userId, opts.userId), eq(userInventory.itemId, item.id))).limit(1);
    if (owned.length) throw new PurchaseError('already_owned', 409);
    const price = applyProDiscount(item.pricePoints, opts.isPro);
    if (wallet.balance < price) throw new PurchaseError('insufficient_balance', 402);
    const balanceAfter = wallet.balance - price;
    await tx.insert(pointTransactions).values({
      userId: opts.userId, amount: -price, balanceAfter, currency: item.currency, type: 'spend',
      referenceType: 'store_item', referenceId: item.id, idempotencyKey: opts.idempotencyKey,
    });
    await tx.update(userCoinBalances).set({ balance: balanceAfter, updatedAt: now })
      .where(and(eq(userCoinBalances.userId, opts.userId), eq(userCoinBalances.currency, item.currency)));
    try {
      const [inv] = await tx.insert(userInventory).values({
        userId: opts.userId, itemId: item.id, source: 'purchase', pricePaid: price, currency: item.currency,
      }).returning();
      return { replayed: false, balance: balanceAfter, itemId: item.id, inventoryId: inv.id };
    } catch (e: any) {
      if (String(e?.cause?.code ?? e?.code) === '23505') throw new PurchaseError('already_owned', 409);
      throw e;
    }
  }).catch((e: any) => {
    if (e instanceof PurchaseError) throw e;
    if (String(e?.cause?.code ?? e?.code) === '23505' && String(e?.cause?.constraint ?? e?.constraint ?? '').includes('ptx_user_idem')) {
      throw new PurchaseError('already_owned', 409);
    }
    throw e;
  });
}

export function decorationsFromEquipped(equipped: Array<{ slot: string; metadata: any }>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const row of equipped) {
    if (row.slot === 'avatar' && row.metadata?.frameKey) out.avatarFrameKey = row.metadata.frameKey;
    else if (row.slot === 'frame' && row.metadata?.frameKey) out.profileFrameKey = row.metadata.frameKey;
    else if (row.slot === 'profile_effect' && row.metadata?.styleId) out.profileEffectName = row.metadata.styleId;
  }
  return Object.keys(out).length ? out : null;
}

export const OWNED_SLOTS = ['avatar', 'profile_effect', 'frame', 'badge'] as const;
export const CUSTOM_SLOTS = ['name_style', 'banner'] as const;

function mergedDecorations(owned: Record<string, unknown> | null, customs: { nameStyle?: unknown; bannerGradient?: unknown }): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...(owned ?? {}) };
  if (customs.nameStyle !== undefined) out.nameStyle = customs.nameStyle as never;
  if (customs.bannerGradient !== undefined) out.bannerGradient = customs.bannerGradient as never;
  return Object.keys(out).length ? out : null;
}

async function currentCustoms(tx: any, userId: string): Promise<{ nameStyle?: unknown; bannerGradient?: unknown }> {
  const [row] = await tx.select({ profileDecorations: users.profileDecorations }).from(users).where(eq(users.id, userId)).limit(1);
  const d = (row?.profileDecorations ?? {}) as Record<string, unknown>;
  const customs: { nameStyle?: unknown; bannerGradient?: unknown } = {};
  if (d.nameStyle !== undefined) customs.nameStyle = d.nameStyle;
  if (d.bannerGradient !== undefined) customs.bannerGradient = d.bannerGradient;
  return customs;
}

async function writeMergedCache(tx: any, userId: string, customsOverride?: { nameStyle?: unknown; bannerGradient?: unknown; clearNameStyle?: boolean; clearBanner?: boolean }) {
  const rows = await tx.select({ slot: userEquipped.slot, metadata: storeItems.metadata })
    .from(userEquipped).innerJoin(storeItems, eq(storeItems.id, userEquipped.itemId))
    .where(eq(userEquipped.userId, userId));
  const customs = customsOverride ? { ...customsOverride } : await currentCustoms(tx, userId);
  const nameStyle = (customs as any).clearNameStyle ? undefined : (customs as any).nameStyle;
  const bannerGradient = (customs as any).clearBanner ? undefined : (customs as any).bannerGradient;
  const decorations = mergedDecorations(decorationsFromEquipped(rows as any), { nameStyle, bannerGradient });
  await tx.update(users).set({ profileDecorations: decorations as any, updatedAt: new Date() }).where(eq(users.id, userId));
  return { equipped: rows.map((r: any) => ({ slot: r.slot })), decorations };
}

export async function equipItem(db: any, opts: { userId: string; slot: string; itemId?: string | null; value?: unknown; isPro: boolean; graceUntilMs: number | null; nowMs?: number }) {
  return db.transaction(async (tx: any) => {
    if ((CUSTOM_SLOTS as readonly string[]).includes(opts.slot)) {
      const { nameStyleSchema, bannerGradientSchema } = await import('../../domain/profileDecorations.js');
      const schema = opts.slot === 'name_style' ? nameStyleSchema : bannerGradientSchema;
      const clearing = opts.value === null || opts.value === undefined;
      if (!clearing) {
        if (!opts.isPro) throw new PurchaseError('pro_required', 403);
        const parsed = schema.safeParse(opts.value);
        if (!parsed.success) throw new PurchaseError('invalid_custom_value', 400);
      }
      const customs = await currentCustoms(tx, opts.userId);
      if (opts.slot === 'name_style') {
        if (clearing) {
          return writeMergedCache(tx, opts.userId, { ...customs, clearNameStyle: true });
        }
        return writeMergedCache(tx, opts.userId, { ...customs, nameStyle: opts.value });
      }
      if (opts.value === null) return writeMergedCache(tx, opts.userId, { ...customs, clearBanner: true });
      return writeMergedCache(tx, opts.userId, { ...customs, bannerGradient: opts.value });
    }
    if (opts.itemId === null || opts.itemId === undefined) {
      await tx.delete(userEquipped).where(and(eq(userEquipped.userId, opts.userId), eq(userEquipped.slot, opts.slot)));
    } else {
      const [item] = await tx.select().from(storeItems).where(eq(storeItems.id, opts.itemId)).limit(1);
      if (!item) throw new PurchaseError('item_unavailable', 404);
      if (!item.isActive) throw new PurchaseError('item_inactive', 410);
      const [slotFor] = [item.type === 'avatar' ? 'avatar' : item.type === 'profile_effect' ? 'profile_effect' : item.type === 'frame' ? 'frame' : 'badge'];
      if (slotFor !== opts.slot) throw new PurchaseError('type_slot_mismatch', 400);
      const owned = await tx.select({ id: userInventory.id }).from(userInventory)
        .where(and(eq(userInventory.userId, opts.userId), eq(userInventory.itemId, item.id))).limit(1);
      if (!owned.length) throw new PurchaseError('not_owned', 403);
      const meta = (item.metadata ?? {}) as { proExclusive?: boolean };
      const nowMs = opts.nowMs ?? Date.now();
      const inGrace = opts.graceUntilMs !== null && nowMs < opts.graceUntilMs;
      if (meta.proExclusive && !opts.isPro && !inGrace) throw new PurchaseError('not_owned', 403);
      await tx.insert(userEquipped).values({ userId: opts.userId, slot: opts.slot, itemId: item.id })
        .onConflictDoUpdate({ target: [userEquipped.userId, userEquipped.slot], set: { itemId: item.id, equippedAt: new Date() } });
    }
    return writeMergedCache(tx, opts.userId);
  });
}

export async function refundPurchase(db: any, opts: { purchaseToken: string }) {
  return db.transaction(async (tx: any) => {
    const [purchase] = await tx.select().from(iapPurchases).where(eq(iapPurchases.purchaseToken, opts.purchaseToken)).limit(1);
    if (!purchase) throw new PurchaseError('purchase_not_found', 404);
    const wallet = await lockedWallet(tx, purchase.userId, purchase.currency);
    const [locked] = await tx.select().from(iapPurchases).where(eq(iapPurchases.purchaseToken, opts.purchaseToken)).for('update');
    if (locked.status === 'refunded') return { status: 'replayed' as const, balance: wallet.balance, debt: Math.max(0, -wallet.balance) };
    const key = `refund:${opts.purchaseToken}`;
    if (!(await idempotencyHit(tx, purchase.userId, key))) {
      const balanceAfter = wallet.balance - purchase.pointsGranted;
      await tx.insert(pointTransactions).values({
        userId: purchase.userId, amount: -purchase.pointsGranted, balanceAfter, currency: purchase.currency,
        type: 'refund', referenceType: 'iap', referenceId: opts.purchaseToken, idempotencyKey: key,
      });
      await tx.update(userCoinBalances).set({ balance: balanceAfter, updatedAt: new Date() })
        .where(and(eq(userCoinBalances.userId, purchase.userId), eq(userCoinBalances.currency, purchase.currency)));
      wallet.balance = balanceAfter;
    }
    if (wallet.balance < 0) {
      const owned = await tx.select().from(userInventory)
        .where(and(eq(userInventory.userId, purchase.userId), eq(userInventory.currency, purchase.currency)))
        .orderBy(sql`${userInventory.acquiredAt} desc`);
      for (const row of owned) {
        if (wallet.balance >= 0) break;
        await tx.delete(userEquipped).where(and(eq(userEquipped.userId, purchase.userId), eq(userEquipped.itemId, row.itemId)));
        await tx.delete(userInventory).where(and(eq(userInventory.userId, purchase.userId), eq(userInventory.itemId, row.itemId)));
        const itemKey = `refund-item:${opts.purchaseToken}:${row.itemId}`;
        if (!(await idempotencyHit(tx, purchase.userId, itemKey))) {
          const balanceAfter = wallet.balance + row.pricePaid;
          await tx.insert(pointTransactions).values({
            userId: purchase.userId, amount: row.pricePaid, balanceAfter, currency: purchase.currency,
            type: 'refund', referenceType: 'item', referenceId: row.itemId, idempotencyKey: itemKey,
          });
          await tx.update(userCoinBalances).set({ balance: balanceAfter, updatedAt: new Date() })
            .where(and(eq(userCoinBalances.userId, purchase.userId), eq(userCoinBalances.currency, purchase.currency)));
          wallet.balance = balanceAfter;
        }
      }
      const remaining = await tx.select({ slot: userEquipped.slot, metadata: storeItems.metadata })
        .from(userEquipped).innerJoin(storeItems, eq(storeItems.id, userEquipped.itemId))
        .where(eq(userEquipped.userId, purchase.userId));
      const customs = await currentCustoms(tx, purchase.userId);
      const decorations = mergedDecorations(decorationsFromEquipped(remaining as any), customs as any);
      await tx.update(users).set({ profileDecorations: decorations as any, updatedAt: new Date() })
        .where(eq(users.id, purchase.userId));
    }
    await tx.update(iapPurchases).set({ status: 'refunded', refundedAt: new Date() })
      .where(eq(iapPurchases.purchaseToken, opts.purchaseToken));
    return { status: 'refunded' as const, balance: wallet.balance, debt: Math.max(0, -wallet.balance) };
  });
}

export async function getBalances(db: any, userId: string): Promise<Record<string, number>> {
  const rows = await db.select().from(userCoinBalances).where(eq(userCoinBalances.userId, userId));
  const out: Record<string, number> = { free: 0, pro: 0 };
  for (const r of rows) out[r.currency] = r.balance;
  return out;
}

export async function ledgerSum(db: any, userId: string, currency: string): Promise<number> {
  const [row] = await db.select({ total: sum(pointTransactions.amount) }).from(pointTransactions)
    .where(and(eq(pointTransactions.userId, userId), eq(pointTransactions.currency, currency)));
  return Number(row?.total ?? 0);
}
