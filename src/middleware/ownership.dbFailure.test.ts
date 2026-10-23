import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// A database blip must never be reported as "you are not signed in": that is
// what turned transient Neon failures into session errors the user could not
// explain. `getCaller` keeps returning an empty caller, but marks it so the
// auth middlewares can answer 503 instead of 401.
const holder = vi.hoisted(() => ({ throwOnSelect: false }));
vi.mock('../database/db.js', () => ({
  db: {
    select: () => {
      if (holder.throwOnSelect) throw new Error('connection terminated');
      return { from: () => ({ where: () => ({ limit: async () => [] }) }) };
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    transaction: async (fn: any) => fn({}),
  },
  isDbAvailable: () => true,
  noteDbFailure: () => undefined,
}));

function ctx() {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => (key === 'authUser' ? { sub: 'google_1' } : store.get(key)),
    set: (key: string, value: unknown) => { store.set(key, value); },
  } as any;
}

describe('getCaller db failure semantics', () => {
  beforeEach(() => { holder.throwOnSelect = false; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('flags an unavailable database instead of pretending the caller is anonymous', async () => {
    const { getCaller } = await import('../middleware/ownership.js');
    holder.throwOnSelect = true;
    const caller = await getCaller(ctx());
    expect(caller.row).toBeNull();
    expect(caller.dbUnavailable).toBe(true);
  });

  it('keeps an ordinary "no such user" row guest-shaped without the flag', async () => {
    const { getCaller } = await import('../middleware/ownership.js');
    holder.throwOnSelect = false;
    const caller = await getCaller(ctx());
    expect(caller.row).toBeNull();
    expect(caller.dbUnavailable).toBe(false);
  });

  it('answers 503, not 401, when the admin guard cannot read the database', async () => {
    const { requireAdminCaller } = await import('../middleware/ownership.js');
    holder.throwOnSelect = true;
    const app = new Hono()
      .use('*', (c, next) => { c.set('authUser', { sub: 'google_1' } as any); return next(); })
      .use('*', requireAdminCaller)
      .get('/', (c) => c.json({ ok: true }));
    expect((await app.request('/')).status).toBe(503);
  });

  it('still answers 401 when the id genuinely has no account row', async () => {
    const { requireAdminCaller } = await import('../middleware/ownership.js');
    holder.throwOnSelect = false;
    const app = new Hono()
      .use('*', (c, next) => { c.set('authUser', { sub: 'google_1' } as any); return next(); })
      .use('*', requireAdminCaller)
      .get('/', (c) => c.json({ ok: true }));
    expect((await app.request('/')).status).toBe(401);
  });
});
