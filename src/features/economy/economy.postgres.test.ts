import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../database/schema.js';
import { grantPoints, ledgerSum, purchaseItem, refundPurchase } from './service.js';

const url = process.env.PHASE1_PG_URL;
if (!url) throw new Error('PHASE1_PG_URL is required: economy ledger tests must run against Postgres, never skip');
const DATABASE_NAME = 'economy_ledger_test';
const parsed = new URL(url);
parsed.pathname = `/${DATABASE_NAME}`;
const dbUrl = parsed.toString();

let pool: pg.Pool;
let database: import('drizzle-orm/node-postgres').NodePgDatabase<typeof schema>;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
  if (existing.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
  expect(pool.options.max, 'pool max >= 10 or concurrency tests prove nothing').toBeGreaterThanOrEqual(10);
  database = drizzle(pool, { schema });
  await migrate(database, { migrationsFolder: './drizzle' });
}, 30_000);
afterAll(async () => { await pool?.end(); });

async function clean() {
  await pool.query('TRUNCATE users, store_items, point_transactions, user_coin_balances, user_inventory, user_equipped, iap_purchases RESTART IDENTITY CASCADE');
}

async function user(pro = false) {
  const [row] = await database.insert(schema.users).values({
    externalId: `google_econ_${Math.random().toString(36).slice(2)}`,
    email: `econ${Math.random().toString(36).slice(2)}@test.com`,
    username: `econ_${Math.random().toString(36).slice(2, 10)}`,
    role: 'reader',
    ...(pro ? { readingStatsPlan: 'pro', readingStatsPlanExpiresAt: Date.now() + 86_400_000 } : {}),
  }).returning();
  return row;
}

async function item(over: Partial<typeof schema.storeItems.$inferInsert> = {}) {
  const [row] = await database.insert(schema.storeItems).values({
    sku: `sku_${Math.random().toString(36).slice(2)}`, type: 'avatar', name: 'Frame',
    pricePoints: 100, currency: 'free', metadata: { frameKey: 'fan_avatar/x.png', proExclusive: false }, ...over,
  }).returning();
  return row;
}

async function assertInvariant(userId: string) {
  for (const currency of ['free', 'pro']) {
    const sum = await ledgerSum(database, userId, currency);
    const [wallet] = await database.select().from(schema.userCoinBalances)
      .where(and(eq(schema.userCoinBalances.userId, userId), eq(schema.userCoinBalances.currency, currency)));
    expect(sum, `ledger==wallet ${currency}`).toBe(wallet?.balance ?? 0);
  }
}

beforeEach(async () => { await clean(); });

describe('economy ledger (Postgres, fail-loud)', () => {
  it('idempotent replay grants once; same key across users succeeds independently', async () => {
    const a = await user();
    const b = await user();
    const key = 'daily:dup';
    const r1 = await grantPoints(database, { userId: a.id, amount: 50, currency: 'free', type: 'reward', key, source: 'achievement' });
    const r2 = await grantPoints(database, { userId: a.id, amount: 50, currency: 'free', type: 'reward', key, source: 'achievement' });
    const r3 = await grantPoints(database, { userId: b.id, amount: 50, currency: 'free', type: 'reward', key, source: 'achievement' });
    expect(r1.status).toBe('granted');
    expect(r2.status).toBe('replayed');
    expect(r3.status).toBe('granted');
    await assertInvariant(a.id);
    await assertInvariant(b.id);
  });

  it('ledger is append-only: UPDATE and DELETE are rejected', async () => {
    const u = await user();
    await grantPoints(database, { userId: u.id, amount: 10, currency: 'free', type: 'reward', key: 'k1', source: 'achievement' });
    await expect(pool.query('UPDATE point_transactions SET amount = 999 WHERE user_id = $1', [u.id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM point_transactions WHERE user_id = $1', [u.id])).rejects.toThrow(/append-only/);
    await assertInvariant(u.id);
  });

  it('insufficient balance rejects 402 with no writes', async () => {
    const u = await user();
    const it1 = await item({ pricePoints: 100 });
    await expect(purchaseItem(database, { userId: u.id, sku: it1.sku, idempotencyKey: 'c:1', isPro: false }))
      .rejects.toMatchObject({ code: 'insufficient_balance', status: 402 });
    expect(await database.select().from(schema.userInventory)).toHaveLength(0);
    expect(await database.select().from(schema.pointTransactions)).toHaveLength(0);
  });

  it('10 concurrent purchases converge to exactly one inventory row', async () => {
    const u = await user();
    await grantPoints(database, { userId: u.id, amount: 100, currency: 'free', type: 'reward', key: 'fund', source: 'achievement' });
    const it1 = await item({ pricePoints: 100 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
      purchaseItem(database, { userId: u.id, sku: it1.sku, idempotencyKey: `c:${i}`, isPro: false })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'already_owned')).toBe(true);
    expect(await database.select().from(schema.userInventory)).toHaveLength(1);
    await assertInvariant(u.id);
  });

  it('spending while negative is rejected', async () => {
    const u = await user();
    await database.insert(schema.userCoinBalances).values({ userId: u.id, currency: 'pro', balance: -50 });
    const it1 = await item({ pricePoints: 10, currency: 'pro' });
    await expect(purchaseItem(database, { userId: u.id, sku: it1.sku, idempotencyKey: 'c:neg', isPro: false }))
      .rejects.toMatchObject({ code: 'insufficient_balance', status: 402 });
  });

  it('daily cap clamps partial remainder and caps at zero with no row', async () => {
    const u = await user();
    const r1 = await grantPoints(database, { userId: u.id, amount: 480, currency: 'free', type: 'reward', key: 'd1', source: 'reading' });
    expect(r1).toMatchObject({ status: 'granted', granted: 480 });
    const r2 = await grantPoints(database, { userId: u.id, amount: 100, currency: 'free', type: 'reward', key: 'd2', source: 'reading' });
    expect(r2).toMatchObject({ status: 'granted', granted: 20 });
    const before = await database.select().from(schema.pointTransactions);
    const r3 = await grantPoints(database, { userId: u.id, amount: 10, currency: 'free', type: 'reward', key: 'd3', source: 'reading' });
    expect(r3).toMatchObject({ status: 'capped', granted: 0 });
    expect(await database.select().from(schema.pointTransactions)).toHaveLength(before.length);
    await assertInvariant(u.id);
  });

  it('concurrent rewards never exceed the daily cap', async () => {
    const u = await user();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      grantPoints(database, { userId: u.id, amount: 100, currency: 'free', type: 'reward', key: `race:${i}`, source: 'daily_login' })));
    const total = results.reduce((s, r) => s + r.granted, 0);
    expect(total).toBeLessThanOrEqual(500);
    await assertInvariant(u.id);
  });

  it('inactive and out-of-window items return 404', async () => {
    const u = await user();
    await grantPoints(database, { userId: u.id, amount: 1000, currency: 'free', type: 'reward', key: 'fund2', source: 'achievement' });
    const off = await item({ sku: 'off-1', isActive: false });
    await expect(purchaseItem(database, { userId: u.id, sku: off.sku, idempotencyKey: 'c:off', isPro: false }))
      .rejects.toMatchObject({ code: 'item_unavailable', status: 404 });
    const future = await item({ sku: 'fut-1', availableFrom: new Date(Date.now() + 86_400_000) });
    await expect(purchaseItem(database, { userId: u.id, sku: future.sku, idempotencyKey: 'c:fut', isPro: false }))
      .rejects.toMatchObject({ code: 'item_unavailable', status: 404 });
    expect(await database.select().from(schema.userInventory)).toHaveLength(0);
    await assertInvariant(u.id);
  });

  it('refund of an equipped item unequips cleanly with an empty slot', async () => {
    const { equipItem } = await import('./service.js');
    const u = await user();
    await database.insert(schema.iapPurchases).values({ purchaseToken: 'tok-eq', userId: u.id, sku: 'pro_pack_small', pointsGranted: 500, currency: 'pro', status: 'granted' });
    await grantPoints(database, { userId: u.id, amount: 500, currency: 'pro', type: 'iap_purchase', key: 'iap:tok-eq', source: 'iap' });
    const it1 = await item({ sku: 'eq-1', pricePoints: 200, currency: 'pro' });
    await purchaseItem(database, { userId: u.id, sku: it1.sku, idempotencyKey: 'c:eq', isPro: false });
    await equipItem(database, { userId: u.id, slot: 'avatar', itemId: it1.id, isPro: false, graceUntilMs: null });
    const res = await refundPurchase(database, { purchaseToken: 'tok-eq' });
    expect(res.status).toBe('refunded');
    expect(await database.select().from(schema.userEquipped).where(eq(schema.userEquipped.userId, u.id))).toHaveLength(0);
    const [row] = await database.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row.profileDecorations).toBeNull();
    await assertInvariant(u.id);
  });

  it('refund after spend claws back newest pro items with debt in response', async () => {
    const u = await user();
    await database.insert(schema.iapPurchases).values({ purchaseToken: 'tok1', userId: u.id, sku: 'pro_pack_small', pointsGranted: 500, currency: 'pro', status: 'granted' });
    await grantPoints(database, { userId: u.id, amount: 500, currency: 'pro', type: 'iap_purchase', key: 'iap:tok1', source: 'iap', referenceType: 'iap', referenceId: 'tok1' });
    const a = await item({ sku: 'claw-a', pricePoints: 200, currency: 'pro' });
    const b = await item({ sku: 'claw-b', pricePoints: 200, currency: 'pro' });
    await purchaseItem(database, { userId: u.id, sku: a.sku, idempotencyKey: 'c:a', isPro: false });
    await purchaseItem(database, { userId: u.id, sku: b.sku, idempotencyKey: 'c:b', isPro: false });
    const res = await refundPurchase(database, { purchaseToken: 'tok1' });
    expect(res.status).toBe('refunded');
    const inv = await database.select().from(schema.userInventory).where(eq(schema.userInventory.userId, u.id));
    expect(inv.map((r) => r.itemId)).not.toContain(b.id);
    expect(res.debt).toBeGreaterThanOrEqual(0);
    await assertInvariant(u.id);
    const again = await refundPurchase(database, { purchaseToken: 'tok1' });
    expect(again.status).toBe('replayed');
  });

  it('custom slots store validated values without ownership and merge with equipped', async () => {
    const { equipItem } = await import('./service.js');
    const u = await user();
    const style = { v: 2, fillMode: 'solid', c1: '#ffffff', c2: '#000000', c3: '#ff0000', angle: 0, mid: 50, stripe: 10, gloss: 0, sw: 0, sc: '#000000', sw2: 0, sc2: '#ffffff', bevel: 0, glowR: 0, glowR2: 0, glowI: 0, glowC: '#000000', glowC2: '#000000', split: 0, exD: 0, exA: 0, exC1: '#000000', exC2: '#000000', exFade: 0, shD: 0, shB: 0, shC: '#000000', shA: 0, size: 56, weight: 400, spacing: 0, skew: 0, rot: 0, tx: 0, ty: 0, sy: 100, upper: false, hue: 0, sat: 100, bri: 100 };
    const banner = { target: 'banner', color: '#4CAF50', fade: 'soft', extent: 'mid', strength: 60 };
    await expect(equipItem(database, { userId: u.id, slot: 'name_style', value: { fillMode: 'hologram' }, isPro: false, graceUntilMs: null }))
      .rejects.toMatchObject({ code: 'invalid_custom_value', status: 400 });
    const r1 = await equipItem(database, { userId: u.id, slot: 'name_style', value: style, isPro: false, graceUntilMs: null });
    expect(r1.decorations).toMatchObject({ nameStyle: style });
    const it1 = await item({ pricePoints: 100, currency: 'free' });
    await grantPoints(database, { userId: u.id, amount: 100, currency: 'free', type: 'reward', key: 'cf', source: 'achievement' });
    await purchaseItem(database, { userId: u.id, sku: it1.sku, idempotencyKey: 'c:cf', isPro: false });
    const r2 = await equipItem(database, { userId: u.id, slot: 'avatar', itemId: it1.id, isPro: false, graceUntilMs: null });
    expect(r2.decorations).toMatchObject({ nameStyle: style, avatarFrameKey: 'fan_avatar/x.png' });
    const r3 = await equipItem(database, { userId: u.id, slot: 'banner', value: banner, isPro: false, graceUntilMs: null });
    expect(r3.decorations).toMatchObject({ bannerGradient: banner });
    const r4 = await equipItem(database, { userId: u.id, slot: 'name_style', value: null, isPro: false, graceUntilMs: null });
    expect(r4.decorations).not.toHaveProperty('nameStyle');
    expect(r4.decorations).toMatchObject({ avatarFrameKey: 'fan_avatar/x.png' });
    await assertInvariant(u.id);
  });
});
