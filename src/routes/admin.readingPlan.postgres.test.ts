import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';

const DATABASE_NAME = 'admin_reading_plan_test';
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
if (!url) throw new Error('PHASE1_PG_URL is required: reading-plan tests must run against Postgres, never skip');

const JWT_SECRET = 'reading-plan-pg-fixture-signing-key-32b';
let counter = 0;

describe('admin reading-plan atomic grant/revoke (Postgres, fail-loud)', () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let app: Hono;
  let adminToken: string;

  const nextId = () => `rp-pg-${process.pid.toString(36)}-${(counter += 1)}`;
  async function createUser(over: Record<string, unknown> = {}) {
    const externalId = nextId();
    const [row] = await database.insert(schema.users).values({
      externalId, email: `${externalId}@test.local`, username: externalId, role: 'reader', ...over,
    } as never).returning();
    return row;
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
    process.env.ADMIN_EMAILS = '';
    vi.stubGlobal('__WORKER_ENV__', undefined);
    await initDb();
    const { adminRouter } = await import('./admin.js');
    app = new Hono().route('/api/v1/admin', adminRouter);
    const adminRow = await createUser({ role: 'admin' });
    adminToken = await signToken({ id: adminRow.externalId!, email: adminRow.email!, role: 'admin' });
  }, 30_000);
  beforeEach(async () => {
    await pool.query('TRUNCATE subscription_events, users RESTART IDENTITY CASCADE');
    const [adminRow] = await database.insert(schema.users).values({
      externalId: `rp-admin-${process.pid.toString(36)}`, email: `rp-admin-${process.pid.toString(36)}@t.local`,
      username: `rp-admin-${process.pid.toString(36)}`, role: 'admin',
    }).returning();
    adminToken = await signToken({ id: adminRow.externalId!, email: adminRow.email!, role: 'admin' });
  });
  afterAll(async () => { await closeDb(); await pool?.end(); vi.unstubAllGlobals(); });

  const grant = (id: string, body: unknown) =>
    app.request(`/api/v1/admin/users/${id}/reading-plan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('grants Pro from now and writes a grant event', async () => {
    const target = await createUser();
    const before = Date.now();
    const res = await grant(target.id, { plan: 'pro', durationDays: 30, reason: 'test grant' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.effectivePlan).toBe('pro');
    expect(json.planStatus).toBe('active');
    expect(typeof json.planExpiresAt).toBe('number');
    expect(json.planExpiresAt).toBeGreaterThan(before);
    const [fresh] = await database.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(fresh.readingStatsPlan).toBe('pro');
    expect(fresh.readingStatsRenewalCount).toBe(1);
    expect(fresh.readingStatsTotalSubscribedMs).toBe(30 * 86_400_000);
    const events = await database.select().from(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, target.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'grant', reason: 'test grant', durationDays: 30 });
    expect(events[0].previousExpiresAt).toBeNull();
    expect(events[0].newExpiresAt).toBe(json.planExpiresAt);
  });

  it('renews from the live expiry and writes renew, additive on retry', async () => {
    const target = await createUser();
    const r1 = await grant(target.id, { plan: 'pro', durationDays: 10, reason: 'first' });
    const first = await r1.json();
    const r2 = await grant(target.id, { plan: 'pro', durationDays: 10, reason: 'second' });
    expect(r2.status).toBe(200);
    const second = await r2.json();
    expect(second.planExpiresAt).toBe(first.planExpiresAt + 10 * 86_400_000);
    const events = await database.select().from(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, target.id));
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('grant');
    expect(events[1].type).toBe('renew');
    expect(events[1].previousExpiresAt).toBe(first.planExpiresAt);
  });

  it('serializes two concurrent grants: both windows apply, two events', async () => {
    const target = await createUser();
    const results = await Promise.all([
      grant(target.id, { plan: 'pro', durationDays: 7, reason: 'race-a' }),
      grant(target.id, { plan: 'pro', durationDays: 7, reason: 'race-b' }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies.every((b) => b.success === true)).toBe(true);
    const [fresh] = await database.select().from(schema.users).where(eq(schema.users.id, target.id));
    const expiries = bodies.map((b) => b.planExpiresAt).sort((a, b) => a - b);
    expect(fresh.readingStatsPlanExpiresAt).toBe(expiries[1]);
    expect(expiries[1] - expiries[0]).toBe(7 * 86_400_000);
    expect(fresh.readingStatsRenewalCount).toBe(2);
    expect(fresh.readingStatsTotalSubscribedMs).toBe(14 * 86_400_000);
    const events = await database.select().from(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, target.id));
    expect(events).toHaveLength(2);
  });

  it('revoke clears the window and writes the event with the old expiry', async () => {
    const target = await createUser();
    const g = await grant(target.id, { plan: 'pro', durationDays: 30, reason: 'to revoke' });
    const granted = await g.json();
    const res = await grant(target.id, { plan: 'free', reason: 'support revoke' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ success: true, effectivePlan: 'free', planExpiresAt: null, planStatus: 'cancelled' });
    const [fresh] = await database.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(fresh.readingStatsPlan).toBe('free');
    expect(fresh.readingStatsPlanExpiresAt).toBeNull();
    expect(fresh.readingStatsGraceUntil).toBeNull();
    const events = await database.select().from(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, target.id));
    expect(events).toHaveLength(2);
    const revoke = events.find((e) => e.type === 'revoke');
    expect(revoke).toMatchObject({ reason: 'support revoke', newExpiresAt: null, durationDays: null });
    expect(revoke!.previousExpiresAt).toBe(granted.planExpiresAt);
  });

  it('returns 404 for an unknown user and 400 for bad input', async () => {
    const missing = await grant('00000000-0000-4000-8000-000000000000', { plan: 'pro', durationDays: 1, reason: 'x' });
    expect(missing.status).toBe(404);
    const badId = await grant('not-a-uuid', { plan: 'pro', durationDays: 1, reason: 'x' });
    expect(badId.status).toBe(400);
    const badBody = await grant((await createUser()).id, { plan: 'pro', reason: '' });
    expect(badBody.status).toBe(400);
  });
});
