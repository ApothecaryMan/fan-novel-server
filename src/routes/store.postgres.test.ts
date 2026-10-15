import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';

const DATABASE_NAME = 'economy_store_test';
const baseUrl = process.env.PHASE1_PG_URL;
let url: string | undefined;
if (baseUrl) {
  const parsed = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/phase1_identity_test') {
    throw new Error('PHASE1_PG_URL must name the isolated local phase1_identity_test database');
  }
  parsed.pathname = `/${DATABASE_NAME}`;
  url = parsed.toString();
}
if (!url) throw new Error('PHASE1_PG_URL is required: economy store tests must run against Postgres, never skip');

const JWT_SECRET = 'store-pg-fixture-signing-key-32byte';
let counter = 0;

describe('economy store routes (Postgres, fail-loud)', () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let app: Hono;

  const nextId = () => `store-pg-${process.pid.toString(36)}-${(counter += 1)}`;
  async function createUser(role = 'reader', pro = false) {
    const externalId = nextId();
    const now = Date.now();
    const [row] = await database.insert(schema.users).values({
      externalId, email: `${externalId}@test.local`, username: externalId, role,
      ...(pro ? { readingStatsPlan: 'pro', readingStatsPlanExpiresAt: now + 86_400_000 } : {}),
    }).returning();
    const token = await signToken({ id: externalId, email: `${externalId}@test.local`, role });
    return { row, token };
  }
  async function createItem(over: Record<string, unknown> = {}) {
    const [row] = await database.insert(schema.storeItems).values({
      sku: `t-${Math.random().toString(36).slice(2)}`, type: 'avatar', name: 'T',
      pricePoints: 100, currency: 'free', metadata: { frameKey: 'fan_avatar/t.png', proExclusive: false }, ...over,
    } as never).returning();
    return row;
  }
  async function fund(userId: string, amount: number, currency = 'free', key = `f-${Math.random().toString(36).slice(2)}`) {
    const { grantPoints } = await import('../features/economy/service.js');
    const res = await grantPoints(database, { userId, amount, currency, type: 'reward', key, source: 'achievement' });
    expect(res.status).toBe('granted');
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: url, max: 10 });
    expect(pool.options.max).toBeGreaterThanOrEqual(10);
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = url;
    process.env.SYNC_OPEN = 'false';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';
    process.env.IAP_WEBHOOK_SECRET = 'wh-secret';
    vi.stubGlobal('__WORKER_ENV__', undefined);
    await initDb();
    const { authRouter } = await import('./auth.js');
    const { storeRouter, storeAdminRouter } = await import('./store.js');
    const { iapRouter } = await import('./iap.js');
    app = new Hono().route('/auth', authRouter).route('/store', storeRouter)
      .route('/admin/store', storeAdminRouter).route('/iap', iapRouter);
  }, 30_000);
  beforeEach(async () => {
    await pool.query('TRUNCATE users, store_items, point_transactions, user_coin_balances, user_inventory, user_equipped, iap_purchases RESTART IDENTITY CASCADE');
  });
  afterEach(async () => {
    const wallets = await pool.query('SELECT user_id, currency, balance FROM user_coin_balances');
    for (const w of wallets.rows) {
      const s = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM point_transactions WHERE user_id = $1 AND currency = $2', [w.user_id, w.currency]);
      expect(Number(s.rows[0].total), `ledger==wallet ${w.currency}`).toBe(w.balance);
    }
  });
  afterAll(async () => { await closeDb(); await pool?.end(); vi.unstubAllGlobals(); });

  it('PATCH /auth/me with store keys is rejected and changes nothing', async () => {
    const { row, token } = await createUser();
    const res = await app.request('/auth/me', { method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bio: 'ok', decorations: { avatarFrameKey: 'fan_avatar/x.png' } }) });
    expect(res.status).toBe(400);
    const [fresh] = await database.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(fresh.profileDecorations).toBeNull();
    expect(fresh.bio).toBeNull();
  });

  it('equipping unowned returns 403; owned equips with projection; null clears', async () => {
    const { row, token } = await createUser();
    const it1 = await createItem();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const denied = await app.request('/store/equip', { method: 'PUT', headers: auth, body: JSON.stringify({ slot: 'avatar', itemId: it1.id }) });
    expect(denied.status).toBe(403);
    await fund(row.id, 100);
    const bought = await app.request('/store/purchase', { method: 'POST', headers: auth, body: JSON.stringify({ sku: it1.sku, idempotencyKey: 'test-key-1' }) });
    expect(bought.status).toBe(200);
    const ok = await app.request('/store/equip', { method: 'PUT', headers: auth, body: JSON.stringify({ slot: 'avatar', itemId: it1.id }) });
    expect(ok.status).toBe(200);
    const [wearing] = await database.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(wearing.profileDecorations).toMatchObject({ avatarFrameKey: 'fan_avatar/t.png' });
    const cleared = await app.request('/store/equip', { method: 'PUT', headers: auth, body: JSON.stringify({ slot: 'avatar', itemId: null }) });
    expect(cleared.status).toBe(200);
    const [bare] = await database.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(bare.profileDecorations).toBeNull();
  });

  it('10 concurrent syncs for Pro create exactly one monthly leg', async () => {
    const { token } = await createUser('reader', true);
    const auth = { Authorization: `Bearer ${token}` };
    const results = await Promise.all(Array.from({ length: 10 }, () => app.request('/store/sync', { headers: auth })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const legs = await database.select().from(schema.pointTransactions).where(eq(schema.pointTransactions.type, 'reward'));
    expect(legs).toHaveLength(1);
    expect(legs[0].idempotencyKey).toMatch(/^pro-monthly:/);
  });

  it('webhook rejects bad auth, ignores subscriptions, refunds voided once under replay', async () => {
    await withStubEnv(async () => {
      const { row } = await createUser();
      await database.insert(schema.iapPurchases).values({ purchaseToken: 'w1', userId: row.id, sku: 'pro_pack_small', pointsGranted: 500, currency: 'pro', status: 'granted' });
      await fund(row.id, 500, 'pro', 'iap:w1');
      const noAuth = await app.request('/iap/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageType: 'voidedPurchase', purchaseToken: 'w1' }) });
      expect(noAuth.status).toBe(401);
      expect(await database.select().from(schema.pointTransactions).then((r) => r.filter((t) => t.type === 'refund'))).toHaveLength(0);
      const sub = await app.request('/iap/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wh-secret' }, body: JSON.stringify({ messageType: 'subscriptionNotification' }) });
      expect(sub.status).toBe(200);
      const results = await Promise.all(Array.from({ length: 5 }, () => app.request('/iap/webhook', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wh-secret' },
        body: JSON.stringify({ messageType: 'voidedPurchase', purchaseToken: 'w1' }) })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      const refunds = await database.select().from(schema.pointTransactions).then((r) => r.filter((t) => t.type === 'refund' && t.referenceId === 'w1'));
      expect(refunds).toHaveLength(1);
      expect(row.id).toBeTruthy();
    });
  });

  it('admin rejects invalid metadata and accepts badge with no migration', async () => {
    const { token } = await createUser('admin');
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const bad = await app.request('/admin/store/items', { method: 'POST', headers: auth,
      body: JSON.stringify({ sku: 'b1', type: 'badge', name: 'B', pricePoints: 10, currency: 'free', metadata: { nope: 1 } }) });
    expect(bad.status).toBe(400);
    const good = await app.request('/admin/store/items', { method: 'POST', headers: auth,
      body: JSON.stringify({ sku: 'b2', type: 'badge', name: 'B', pricePoints: 10, currency: 'free', metadata: { badgeKey: 'b2', proExclusive: false } }) });
    expect(good.status).toBe(201);
  });

  async function withStubEnv<T>(fn: () => Promise<T>): Promise<T> {
    const savedNode = process.env.NODE_ENV;
    const savedFlag = process.env.IAP_ALLOW_STUB;
    process.env.NODE_ENV = 'development';
    process.env.IAP_ALLOW_STUB = 'true';
    try {
      return await fn();
    } finally {
      process.env.NODE_ENV = savedNode;
      if (savedFlag === undefined) delete process.env.IAP_ALLOW_STUB;
      else process.env.IAP_ALLOW_STUB = savedFlag;
    }
  }

  it('verify fails closed without the stub flag and grants nothing', async () => {
    const { row, token } = await createUser();
    const res = await app.request('/iap/verify', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseToken: 'closed-1', sku: 'pro_pack_small' }) });
    expect(res.status).toBe(503);
    expect(await database.select().from(schema.iapPurchases)).toHaveLength(0);
    expect(await database.select().from(schema.pointTransactions)).toHaveLength(0);
    expect(row.id).toBeTruthy();
  });

  it('verify stays closed in production even with the flag set', async () => {
    process.env.IAP_ALLOW_STUB = 'true';
    try {
      const { token } = await createUser();
      const res = await app.request('/iap/verify', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchaseToken: 'closed-2', sku: 'pro_pack_small' }) });
      expect(res.status).toBe(503);
      expect(await database.select().from(schema.iapPurchases)).toHaveLength(0);
    } finally {
      delete process.env.IAP_ALLOW_STUB;
    }
  });

  it('webhook stays closed in production even with a valid secret', async () => {
    const res = await app.request('/iap/webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wh-secret' },
      body: JSON.stringify({ messageType: 'voidedPurchase', purchaseToken: 'x' }) });
    expect(res.status).toBe(503);
    expect(await database.select().from(schema.pointTransactions)).toHaveLength(0);
  });

  it('verify grants with the explicit stub flag and acknowledges', async () => {
    await withStubEnv(async () => {
      const { row, token } = await createUser();
      const res = await app.request('/iap/verify', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchaseToken: 'open-1', sku: 'pro_pack_small' }) });
      expect(res.status).toBe(200);
      expect((await res.json()).verification).toBe('stubbed');
      const [purchase] = await database.select().from(schema.iapPurchases).where(eq(schema.iapPurchases.purchaseToken, 'open-1'));
      expect(purchase.pointsGranted).toBe(500);
      expect(purchase.acknowledgedAt).not.toBeNull();
      const again = await app.request('/iap/verify', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchaseToken: 'open-1', sku: 'pro_pack_small' }) });
      expect((await again.json()).replayed).toBe(true);
      expect(row.id).toBeTruthy();
    });
  });

  it('webhook without a configured secret rejects with 401', async () => {
    await withStubEnv(async () => {
      const saved = process.env.IAP_WEBHOOK_SECRET;
      delete process.env.IAP_WEBHOOK_SECRET;
      try {
        const res = await app.request('/iap/webhook', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wh-secret' },
          body: JSON.stringify({ messageType: 'voidedPurchase', purchaseToken: 'x' }) });
        expect(res.status).toBe(401);
        expect(await database.select().from(schema.pointTransactions)).toHaveLength(0);
      } finally {
        process.env.IAP_WEBHOOK_SECRET = saved;
      }
    });
  });

  it('admin patches price and active flag, rejects bad metadata and unknown ids', async () => {
    const { token } = await createUser('admin');
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const it1 = await createItem({ sku: 'patch-1', pricePoints: 100 });
    const ok = await app.request(`/admin/store/items/${it1.id}`, { method: 'PATCH', headers: auth,
      body: JSON.stringify({ pricePoints: 250, isActive: false }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).item.pricePoints).toBe(250);
    const bad = await app.request(`/admin/store/items/${it1.id}`, { method: 'PATCH', headers: auth,
      body: JSON.stringify({ metadata: { nope: 1 } }) });
    expect(bad.status).toBe(400);
    const missing = await app.request('/admin/store/items/00000000-0000-4000-8000-000000000000', { method: 'PATCH', headers: auth,
      body: JSON.stringify({ pricePoints: 5 }) });
    expect(missing.status).toBe(404);
  });

  it('backfill converts legacy decorations once and is a no-op the second time', async () => {
    const { execFile } = await import('node:child_process');
    const [row] = await database.insert(schema.users).values({
      externalId: nextId(), email: 'backfill@test.local', username: nextId(), role: 'reader',
      profileDecorations: { avatarFrameKey: 'fan_avatar/legacy.png' } as never,
    }).returning();
    const run = () => new Promise<{ stdout: string }>((resolve, reject) => {
      execFile('node', ['scripts/backfill-economy-legacy.mjs'], { env: { ...process.env, DATABASE_URL: url }, cwd: process.cwd() },
        (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve({ stdout })));
    });
    const first = JSON.parse((await run()).stdout);
    expect(first).toMatchObject({ users: 1 });
    expect(first.inventory).toBeGreaterThan(0);
    const second = JSON.parse((await run()).stdout);
    expect(second).toMatchObject({ users: 1, items: 0, inventory: 0, equipped: 0 });
    expect(row.id).toBeTruthy();
  });

  it('admin grant requires a reason, caps the amount, and never goes negative', async () => {
    const { token } = await createUser('admin');
    const { row: target } = await createUser();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = { userId: target.id, amount: 50, currency: 'free' };
    const noReason = await app.request('/admin/store/grant', { method: 'POST', headers: auth, body: JSON.stringify(base) });
    expect(noReason.status).toBe(400);
    const negative = await app.request('/admin/store/grant', { method: 'POST', headers: auth,
      body: JSON.stringify({ ...base, amount: -50, reason: 'clawback attempt' }) });
    expect(negative.status).toBe(400);
    const overCap = await app.request('/admin/store/grant', { method: 'POST', headers: auth,
      body: JSON.stringify({ ...base, amount: 1000001, reason: 'too much' }) });
    expect(overCap.status).toBe(400);
    const ok = await app.request('/admin/store/grant', { method: 'POST', headers: auth,
      body: JSON.stringify({ ...base, reason: 'support credit' }) });
    expect(ok.status).toBe(200);
    const legs = await database.select().from(schema.pointTransactions).where(eq(schema.pointTransactions.userId, target.id));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ amount: 50, type: 'admin_adjust', reason: 'support credit' });
    expect(legs[0].actorId).toBeTruthy();
  });

  it('DELETE /auth/me anonymizes the row and keeps ledger and inventory', async () => {
    const { row, token } = await createUser();
    await fund(row.id, 200);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const res = await app.request('/auth/me', { method: 'DELETE', headers: auth });
    expect(res.status).toBe(200);
    const [kept] = await database.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(kept).toBeTruthy();
    expect(kept.email).toBeNull();
    expect(kept.googleSubject).toBeNull();
    expect(kept.displayName).toBe('Deleted user');
    const legs = await database.select().from(schema.pointTransactions).where(eq(schema.pointTransactions.userId, row.id));
    expect(legs.length).toBeGreaterThan(0);
    const relogin = await app.request('/auth/me', { method: 'GET', headers: auth });
    expect(relogin.status).toBe(401);
  });

  it('refund uses stored pointsGranted, not current package config', async () => {
    await withStubEnv(async () => {
      const { row } = await createUser();
      await database.insert(schema.iapPurchases).values({ purchaseToken: 'w2', userId: row.id, sku: 'pro_pack_small', pointsGranted: 999, currency: 'pro', status: 'granted' });
      await fund(row.id, 999, 'pro', 'iap:w2');
      const res = await app.request('/iap/webhook', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wh-secret' },
        body: JSON.stringify({ messageType: 'voidedPurchase', purchaseToken: 'w2' }) });
      expect(res.status).toBe(200);
      const legs = await database.select().from(schema.pointTransactions).then((r) => r.filter((t) => t.type === 'refund' && t.referenceId === 'w2'));
      expect(legs).toHaveLength(1);
      expect(legs[0].amount).toBe(-999);
      expect(row.id).toBeTruthy();
    });
  });
});
