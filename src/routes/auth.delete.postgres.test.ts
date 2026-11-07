import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';

const DATABASE_NAME = 'auth_delete_test';
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
if (!url) throw new Error('PHASE1_PG_URL is required: account-delete tests must run against Postgres, never skip');

const JWT_SECRET = 'auth-delete-pg-fixture-key-32bytes!!';
let counter = 0;

describe('DELETE /auth/me reading cleanup and Pro end (Postgres, fail-loud)', () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let app: Hono;

  const nextId = () => `del-pg-${process.pid.toString(36)}-${(counter += 1)}`;

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
    app = new Hono().route('/auth', authRouter);
  }, 30_000);
  beforeEach(async () => {
    await pool.query('TRUNCATE users, store_items, point_transactions, user_coin_balances, user_inventory, user_equipped, iap_purchases, reading_sessions, user_library, reading_novels, user_achievement_unlocks, user_categories, role_requests, author_api_keys, subscription_events, comments, comment_votes RESTART IDENTITY CASCADE');
  });
  afterAll(async () => { await closeDb(); await pool?.end(); vi.unstubAllGlobals(); });

  async function seedProUserWithReading() {
    const externalId = nextId();
    const now = Date.now();
    const [row] = await database.insert(schema.users).values({
      externalId, email: `${externalId}@test.local`, username: externalId, role: 'admin',
      isAuthor: true, isTranslator: true, weeklyReadingGoalHours: 5,
      readingStatsPlan: 'pro', readingStatsPlanExpiresAt: now + 86_400_000,
      readingStatsPlanStatus: 'active', readingStatsRenewalCount: 1,
    } as never).returning();
    const token = await signToken({ id: externalId, email: `${externalId}@test.local`, role: 'reader' });
    await database.insert(schema.readingSessions).values({
      userId: row.id, clientSessionId: 's-1', novelId: 'n1', chapterId: 1,
      progressPercent: 90, completed: true, completionSignalPresent: true, proFieldsPresent: false,
      seconds: 60, words: 0, minuteOfDay: 0, readDay: '2026-01-01', ts: now,
    });
    await database.insert(schema.userLibrary).values({
      userId: row.id, novelId: 'n1', updatedAt: now,
    });
    await database.insert(schema.readingNovels).values({
      userId: row.id, novelId: 'n1', title: 'T', genre: 'g', updatedAt: now,
    });
    await database.insert(schema.userAchievementUnlocks).values({
      userId: row.id, achievementId: 'a1', level: 2, firstSeenAt: now, catalogVersion: 1, updatedAt: now,
    });
    await database.insert(schema.userCategories).values({ userId: row.id, name: 'cat' });
    const { generatePat, hashPat } = await import('../middleware/authorToken.js');
    const pat = generatePat();
    await database.insert(schema.authorApiKeys).values({
      userId: row.id, name: 't', keyPrefix: pat.slice(0, 15), keyHash: await hashPat(pat), scopes: ['novels:write'],
    });
    await database.insert(schema.roleRequests).values({ userId: row.id, kind: 'author', status: 'pending', note: 'please approve' });
    const [item] = await database.insert(schema.storeItems).values({
      sku: `del-${Math.random().toString(36).slice(2)}`, type: 'avatar', name: 'F',
      pricePoints: 10, currency: 'free', metadata: { frameKey: 'fan_avatar/f.png', proExclusive: false },
    } as never).returning();
    await database.insert(schema.userInventory).values({ userId: row.id, itemId: item.id, source: 'purchase', pricePaid: 10, currency: 'free' });
    await database.insert(schema.userEquipped).values({ userId: row.id, slot: 'avatar', itemId: item.id });
    await database.insert(schema.pointTransactions).values({
      userId: row.id, amount: 10, balanceAfter: 10, currency: 'free', type: 'reward', idempotencyKey: 'k1',
    });
    await database.insert(schema.userCoinBalances).values({ userId: row.id, currency: 'free', balance: 10 });
    return { row, token, item, pat };
  }

  it('deletes reading rows and equipped, ends Pro with a revoke event, keeps ledger and inventory', async () => {
    const { row, token, pat } = await seedProUserWithReading();
    const res = await app.request('/auth/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await database.select().from(schema.readingSessions).then((r) => r.filter((x) => x.userId === row.id))).toHaveLength(0);
    expect(await database.select().from(schema.userLibrary).then((r) => r.filter((x) => x.userId === row.id))).toHaveLength(0);
    expect(await database.select().from(schema.readingNovels).then((r) => r.filter((x) => x.userId === row.id))).toHaveLength(0);
    expect(await database.select().from(schema.userAchievementUnlocks).then((r) => r.filter((x) => x.userId === row.id))).toHaveLength(0);
    expect(await database.select().from(schema.userCategories).then((r) => r.filter((x) => x.userId === row.id))).toHaveLength(0);
    expect(await database.select().from(schema.userEquipped).where(eq(schema.userEquipped.userId, row.id))).toHaveLength(0);
    const [fresh] = await database.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(fresh.email).toBeNull();
    expect(fresh.readingStatsPlan).toBe('free');
    expect(fresh.readingStatsPlanExpiresAt).toBeNull();
    expect(fresh.readingStatsGraceUntil).toBeNull();
    expect(fresh.readingStatsPlanStatus).toBe('cancelled');
    expect(fresh.role).toBe('reader');
    expect(fresh.isAuthor).toBe(false);
    expect(fresh.isTranslator).toBe(false);
    expect(fresh.weeklyReadingGoalHours).toBeNull();
    const events = await database.select().from(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, row.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'revoke', reason: 'system: account deleted' });
    expect(await database.select().from(schema.pointTransactions).then((r) => r.filter((x) => x.userId === row.id))).toHaveLength(1);
    expect(await database.select().from(schema.userInventory).then((r) => r.filter((x) => x.userId === row.id))).toHaveLength(1);
    expect(await database.select().from(schema.roleRequests).then((r) => r.filter((x) => x.userId === row.id))).toHaveLength(0);
    const [key] = await database.select().from(schema.authorApiKeys).where(eq(schema.authorApiKeys.userId, row.id));
    expect(key.revokedAt).not.toBeNull();
    const { resolvePat } = await import('../middleware/authorToken.js');
    await expect(resolvePat(pat).then((r) => r.ok)).resolves.toBe(false);
  });

  it('free user delete writes no revoke event and is idempotent-safe', async () => {
    const externalId = nextId();
    const [row] = await database.insert(schema.users).values({
      externalId, email: `${externalId}@test.local`, username: externalId, role: 'reader',
    }).returning();
    const token = await signToken({ id: externalId, email: `${externalId}@test.local`, role: 'reader' });
    const res = await app.request('/auth/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const events = await database.select().from(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, row.id));
    expect(events).toHaveLength(0);
    const again = await app.request('/auth/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(again.status).toBe(401);
  });
});
