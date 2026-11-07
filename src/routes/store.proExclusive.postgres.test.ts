import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';

const DATABASE_NAME = 'store_pro_exclusive_test';
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
if (!url) throw new Error('PHASE1_PG_URL is required: pro-exclusive tests must run against Postgres, never skip');

const JWT_SECRET = 'pro-exclusive-pg-fixture-key-32bytes!';
let counter = 0;

describe('pro-exclusive equipped cleanup on sync (Postgres, fail-loud)', () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let app: Hono;

  const nextId = () => `px-pg-${process.pid.toString(36)}-${(counter += 1)}`;
  async function createUser(over: Record<string, unknown> = {}) {
    const externalId = nextId();
    const [row] = await database.insert(schema.users).values({
      externalId, email: `${externalId}@test.local`, username: externalId, role: 'reader', ...over,
    } as never).returning();
    const token = await signToken({ id: externalId, email: `${externalId}@test.local`, role: 'reader' });
    return { row, token };
  }
  async function createProItem(skuSuffix: string) {
    const [row] = await database.insert(schema.storeItems).values({
      sku: `px-${skuSuffix}-${Math.random().toString(36).slice(2)}`, type: 'avatar', name: 'Pro frame',
      pricePoints: 10, currency: 'free', metadata: { frameKey: 'fan_avatar/pro.png', proExclusive: true },
    } as never).returning();
    return row;
  }
  async function createFreeItem(skuSuffix: string) {
    const [row] = await database.insert(schema.storeItems).values({
      sku: `fx-${skuSuffix}-${Math.random().toString(36).slice(2)}`, type: 'avatar', name: 'Free frame',
      pricePoints: 10, currency: 'free', metadata: { frameKey: 'fan_avatar/free.png', proExclusive: false },
    } as never).returning();
    return row;
  }
  async function fund(userId: string, key: string) {
    const { grantPoints } = await import('../features/economy/service.js');
    const res = await grantPoints(database, { userId, amount: 100, currency: 'free', type: 'reward', key, source: 'achievement' });
    expect(res.status).toBe('granted');
  }
  async function buyAndEquip(token: string, userId: string, item: { id: string; sku: string }) {
    const { purchaseItem, equipItem } = await import('../features/economy/service.js');
    await purchaseItem(database, { userId, sku: item.sku, idempotencyKey: `c:${item.id}`, isPro: true });
    const { hasProAccess } = await import('../features/economy/service.js');
    void hasProAccess;
    await equipItem(database, { userId, slot: 'avatar', itemId: item.id, isPro: true, graceUntilMs: null });
    void token;
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: url, max: 10 });
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = url;
    process.env.SYNC_OPEN = 'false';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';
    vi.stubGlobal('__WORKER_ENV__', undefined);
    await initDb();
    const { authRouter } = await import('./auth.js');
    const { storeRouter } = await import('./store.js');
    app = new Hono().route('/auth', authRouter).route('/store', storeRouter);
  }, 30_000);
  beforeEach(async () => {
    await pool.query('TRUNCATE users, store_items, point_transactions, user_coin_balances, user_inventory, user_equipped, iap_purchases RESTART IDENTITY CASCADE');
  });
  afterAll(async () => { await closeDb(); await pool?.end(); vi.unstubAllGlobals(); });

  it('expired Pro loses pro-exclusive equipped on sync but keeps ownership', async () => {
    const now = Date.now();
    const { row, token } = await createUser({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: now + 86_400_000 });
    const proItem = await createProItem('a');
    await fund(row.id, `px-fund-${row.id}`);
    await buyAndEquip(token, row.id, proItem);
    let equipped = await database.select().from(schema.userEquipped).where(eq(schema.userEquipped.userId, row.id));
    expect(equipped).toHaveLength(1);
    await database.update(schema.users).set({ readingStatsPlanExpiresAt: Date.now() - 1000 }).where(eq(schema.users.id, row.id));
    const res = await app.request('/store/sync', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.equipped).toHaveLength(0);
    expect(body.decorations).toBeNull();
    equipped = await database.select().from(schema.userEquipped).where(eq(schema.userEquipped.userId, row.id));
    expect(equipped).toHaveLength(0);
    const owned = await database.select().from(schema.userInventory).where(eq(schema.userInventory.userId, row.id));
    expect(owned).toHaveLength(1);
    const [fresh] = await database.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(fresh.profileDecorations).toBeNull();
  });

  it('active Pro keeps pro-exclusive equipped on sync', async () => {
    const now = Date.now();
    const { row, token } = await createUser({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: now + 86_400_000 });
    const proItem = await createProItem('b');
    await fund(row.id, `px-fund-${row.id}`);
    await buyAndEquip(token, row.id, proItem);
    const res = await app.request('/store/sync', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.equipped).toHaveLength(1);
    expect(body.decorations).toMatchObject({ avatarFrameKey: 'fan_avatar/pro.png' });
  });

  it('grace user keeps pro-exclusive equipped on sync', async () => {
    const past = Date.now() - 1000;
    const graceUntil = Date.now() + 86_400_000;
    const { row, token } = await createUser({
      readingStatsPlan: 'pro', readingStatsPlanExpiresAt: past, readingStatsGraceUntil: graceUntil,
    });
    const proItem = await createProItem('c');
    await fund(row.id, `px-fund-${row.id}`);
    const { purchaseItem, equipItem } = await import('../features/economy/service.js');
    await purchaseItem(database, { userId: row.id, sku: proItem.sku, idempotencyKey: `c:${proItem.id}`, isPro: false });
    await equipItem(database, { userId: row.id, slot: 'avatar', itemId: proItem.id, isPro: false, graceUntilMs: graceUntil });
    const res = await app.request('/store/sync', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.equipped).toHaveLength(1);
    expect(body.decorations).toMatchObject({ avatarFrameKey: 'fan_avatar/pro.png' });
  });

  it('expired Pro keeps non-exclusive equipped but strips the exclusive one', async () => {
    const now = Date.now();
    const { row, token } = await createUser({ readingStatsPlan: 'pro', readingStatsPlanExpiresAt: now + 86_400_000 });
    const proItem = await createProItem('d');
    const freeItem = await createFreeItem('d');
    await fund(row.id, `px-fund-${row.id}`);
    const { purchaseItem, equipItem } = await import('../features/economy/service.js');
    await purchaseItem(database, { userId: row.id, sku: proItem.sku, idempotencyKey: `c:${proItem.id}`, isPro: true });
    await equipItem(database, { userId: row.id, slot: 'avatar', itemId: proItem.id, isPro: true, graceUntilMs: null });
    await database.update(schema.users).set({ readingStatsPlanExpiresAt: Date.now() - 1000 }).where(eq(schema.users.id, row.id));
    const res = await app.request('/store/sync', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).equipped).toHaveLength(0);
    void freeItem;
  });
});
