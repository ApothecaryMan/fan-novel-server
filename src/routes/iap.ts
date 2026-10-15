import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { iapPurchases } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getCaller } from '../middleware/ownership.js';
import { getEnv } from '../config/env.js';
import { PurchaseError, grantPoints, refundPurchase } from '../features/economy/service.js';

export const iapRouter = new Hono();

const PACKAGES: Record<string, { points: number; currency: string }> = {
  pro_pack_small: { points: 500, currency: 'pro' },
  pro_pack_medium: { points: 1200, currency: 'pro' },
  pro_pack_large: { points: 3000, currency: 'pro' },
};

const verifySchema = z.object({ purchaseToken: z.string().min(1).max(255), sku: z.string().min(1).max(100) });

function stubAllowed(): boolean {
  return getEnv().IAP_ALLOW_STUB === 'true';
}

iapRouter.post('/verify', requireAuth, async (c) => {
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'unauthorized' }, 401);
  if (!stubAllowed()) return c.json({ error: 'play_unavailable' }, 503);
  const parsed = verifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid receipt' }, 400);
  const pack = PACKAGES[parsed.data.sku];
  if (!pack) return c.json({ error: 'unknown sku' }, 400);
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const res = await db.transaction(async (tx: any) => {
      const existing = await tx.select().from(iapPurchases).where(eq(iapPurchases.purchaseToken, parsed.data.purchaseToken)).limit(1);
      if (existing.length) return { replayed: true };
      await tx.insert(iapPurchases).values({
        purchaseToken: parsed.data.purchaseToken, userId: caller.row!.id, sku: parsed.data.sku,
        pointsGranted: pack.points, currency: pack.currency, status: 'granted',
      });
      await grantPoints(tx, {
        userId: caller.row!.id, amount: pack.points, currency: pack.currency, type: 'iap_purchase',
        key: `iap:${parsed.data.purchaseToken}`, source: 'iap', referenceType: 'iap', referenceId: parsed.data.purchaseToken,
      });
      return { replayed: false };
    });
    if (!res.replayed) {
      await db.update(iapPurchases).set({ acknowledgedAt: new Date() })
        .where(eq(iapPurchases.purchaseToken, parsed.data.purchaseToken)).catch(() => null);
    }
    return c.json({ success: true, verification: 'stubbed', ...res });
  } catch (e: any) {
    if (String(e?.cause?.code ?? e?.code) === '23505') return c.json({ success: true, replayed: true });
    if (e instanceof PurchaseError) return c.json({ error: e.code }, e.status);
    noteDbFailure();
    return c.json({ error: 'store unavailable' }, 503);
  }
});

iapRouter.post('/webhook', async (c) => {
  const secret = getEnv().IAP_WEBHOOK_SECRET ?? '';
  const auth = c.req.header('Authorization') ?? '';
  if (!secret || auth !== `Bearer ${secret}`) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  const type = body?.messageType ?? body?.type ?? '';
  if (type === 'subscriptionNotification') return c.json({ success: true, ignored: 'subscription' });
  const token = body?.purchaseToken ?? body?.token ?? '';
  if (!token || type !== 'voidedPurchase') return c.json({ error: 'invalid notification' }, 400);
  if (!isDbAvailable()) return c.json({ error: 'store unavailable' }, 503);
  try {
    const res = await refundPurchase(db, { purchaseToken: token });
    return c.json({ success: true, ...res });
  } catch (e) {
    if (e instanceof PurchaseError) return c.json({ error: e.code }, e.status);
    noteDbFailure();
    return c.json({ error: 'store unavailable' }, 503);
  }
});
