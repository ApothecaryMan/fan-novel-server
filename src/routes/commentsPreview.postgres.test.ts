import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { comments, novels, users } from '../database/schema.js';
import { closeDb, initDb } from '../database/db.js';
import { commentsNovelsRouter } from './comments.js';

/**
 * Route-level tests for the `preview` array on GET /api/v1/novels/:id/comments.
 *
 * The contract these lock down is the reply TREE, not a row count: the preview
 * picks the newest 2 rows per root across every depth, so without the ancestor
 * CTE a reply-to-a-reply ships without its parent and the client cannot nest it
 * or name its target — the reader then cannot tell a reply-to-a-reply from a
 * reply-to-the-comment. That is a real planner question (a recursive CTE that
 * terminates and returns the right rows), so it needs a real database.
 */
const baseUrl = process.env.PHASE1_PG_URL;
const DATABASE_NAME = 'comments_preview_route_test';

let url: string | undefined;
if (baseUrl) {
  const parsed = new URL(baseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash ||
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/phase1_identity_test') {
    throw new Error('PHASE1_PG_URL must name the isolated local phase1_identity_test database');
  }
  parsed.pathname = `/${DATABASE_NAME}`;
  url = parsed.toString();
}

const JWT_SECRET = 'cprev-fixture-signing-key-32-bytes-min';
let counter = 0;
const nextSubject = () => `cprev-${process.pid.toString(36)}-${(counter += 1)}`;

type PreviewRow = { id: string; parentId: string | null; author: { name: string } };

let pool: pg.Pool;
let database: ReturnType<typeof drizzle<typeof schema>>;
let app: Hono;
let novelId: string;
const userIds: Record<string, string> = {};

async function author(key: string, name: string): Promise<string> {
  if (userIds[key]) return userIds[key];
  const externalId = nextSubject();
  const [u] = await database.insert(users).values({
    externalId, email: `${externalId}@test.local`, username: externalId, displayName: name, role: 'reader',
  }).returning();
  userIds[key] = u.id;
  return u.id;
}

beforeAll(async () => {
  if (!url) return;
  const bootstrap = new pg.Client({ connectionString: baseUrl });
  await bootstrap.connect();
  const existing = await bootstrap.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
  if (existing.rowCount === 0) await bootstrap.query(`CREATE DATABASE ${DATABASE_NAME}`);
  await bootstrap.end();

  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.ADMIN_EMAILS = '';
  process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';

  await initDb();
  pool = new pg.Pool({ connectionString: url });
  database = drizzle(pool, { schema });
  await migrate(database, { migrationsFolder: './drizzle' });

  app = new Hono();
  app.route('/api/v1/novels', commentsNovelsRouter);
});

afterAll(async () => {
  if (pool) await pool.end();
  await closeDb();
});

/** Insert a comment, returning its numeric id. */
async function add(opts: {
  body: string; userKey: string; parentId?: number; rootId?: number; depth?: number;
  status?: string; minutesAgo: number;
}): Promise<number> {
  const [row] = await database.insert(comments).values({
    novelId,
    userId: await author(opts.userKey, opts.userKey),
    chapterNumber: 1,
    body: opts.body,
    bodyHash: `h-${opts.body}-${nextSubject()}`,
    status: (opts.status ?? 'visible') as 'visible' | 'pending' | 'deleted',
    parentId: opts.parentId ?? null,
    rootId: opts.rootId ?? null,
    depth: opts.depth ?? 0,
    createdAt: new Date(Date.now() - opts.minutesAgo * 60_000),
  }).returning();
  return row.id;
}

async function listRoots() {
  // `chapter=1` is required: with no chapter param the route filters to
  // novel-level comments (chapterNumber IS NULL, comments.ts:449).
  const res = await app.request(`/api/v1/novels/${novelId}/comments?limit=20&chapter=1`);
  const body = await res.json() as { data: Array<{ id: string; preview: PreviewRow[] }> };
  return body.data ?? [];
}

beforeEach(async () => {
  if (!url) return;
  await database.delete(comments);
  await database.delete(novels);
  novelId = `nov-${nextSubject()}`;
  await database.insert(novels).values({
    id: novelId, title: 'T', author: 'a', category: 'c',
    coverUrl: 'https://cdn.test/c.png', summary: 's',
  });
});

describe('GET /novels/:id/comments — reply preview', () => {
  it('carries the ancestor chain so a reply-to-a-reply arrives with its parent', async () => {
    // root -> a -> b. The newest 2 rows are `a` and `b`; `b`'s parent `a` is
    // inside the window, so the client can nest without any ancestor help.
    const root = await add({ body: 'root', userKey: 'rootUser', minutesAgo: 60 });
    const a = await add({ body: 'a', userKey: 'aUser', parentId: root, rootId: root, depth: 1, minutesAgo: 30 });
    await add({ body: 'b', userKey: 'bUser', parentId: a, rootId: root, depth: 2, minutesAgo: 5 });

    const [listed] = await listRoots();
    const ids = listed.preview.map((p) => p.id);
    expect(ids).toContain(`app_${a}`);
  });

  it('includes a MISSING ancestor when the 2 newest rows skip a generation', async () => {
    // root -> a -> b -> c -> d. The newest 2 are `c` and `d`; `c`'s parent `b`
    // is outside the window, so the ancestor CTE must supply `b` (and `a`) or
    // the client renders `c` as a direct reply to the root.
    const root = await add({ body: 'root', userKey: 'rootUser', minutesAgo: 90 });
    const a = await add({ body: 'a', userKey: 'aUser', parentId: root, rootId: root, depth: 1, minutesAgo: 80 });
    const b = await add({ body: 'b', userKey: 'bUser', parentId: a, rootId: root, depth: 2, minutesAgo: 70 });
    const c = await add({ body: 'c', userKey: 'cUser', parentId: b, rootId: root, depth: 3, minutesAgo: 5 });
    const d = await add({ body: 'd', userKey: 'dUser', parentId: b, rootId: root, depth: 3, minutesAgo: 1 });

    const [listed] = await listRoots();
    const byId = new Map(listed.preview.map((p) => [p.id, p]));
    // The root must NOT appear inside its own preview: it is already the
    // thread being rendered, so including it would draw the comment twice.
    expect(byId.has(`app_${root}`)).toBe(false);
    // The whole chain must be present, so `c` and `d` can be nested under
    // `b` instead of being flattened onto the root.
    expect([...byId.keys()].sort()).toEqual(
      [`app_${a}`, `app_${b}`, `app_${c}`, `app_${d}`].sort(),
    );
    expect(byId.get(`app_${a}`)?.parentId).toBe(`app_${root}`);
    expect(byId.get(`app_${b}`)?.parentId).toBe(`app_${a}`);
    expect(byId.get(`app_${c}`)?.parentId).toBe(`app_${b}`);
    expect(byId.get(`app_${d}`)?.parentId).toBe(`app_${b}`);
  });

  it('returns the preview oldest-first so rendering order is stable', async () => {
    // `depth` is not part of the wire shape, so ordering is asserted on the
    // ids themselves: fixtures are inserted oldest-first, so ascending id
    // order is the oldest-first contract the client renders against.
    const root = await add({ body: 'root', userKey: 'rootUser', minutesAgo: 60 });
    const a = await add({ body: 'a', userKey: 'aUser', parentId: root, rootId: root, depth: 1, minutesAgo: 30 });
    const b = await add({ body: 'b', userKey: 'bUser', parentId: a, rootId: root, depth: 2, minutesAgo: 5 });

    const [listed] = await listRoots();
    const ids = listed.preview.map((p) => Number(p.id.replace('app_', '')));
    expect(ids).toEqual([a, b]);
  });

  it('terminates on a self-referential row instead of looping forever', async () => {
    // Defensive: the recursive term must not spin if the shape ever drifts.
    const root = await add({ body: 'root', userKey: 'rootUser', minutesAgo: 60 });
    const a = await add({ body: 'a', userKey: 'aUser', parentId: root, rootId: root, depth: 1, minutesAgo: 30 });
    // A cycle: a's parent becomes itself.
    await database.update(comments).set({ parentId: a }).where(eq(comments.id, a));

    const [listed] = await listRoots();
    expect(listed.preview.length).toBeGreaterThan(0);
  });
});
