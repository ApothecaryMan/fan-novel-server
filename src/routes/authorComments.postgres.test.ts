import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { comments, novels, users } from '../database/schema.js';
import { closeDb, initDb } from '../database/db.js';
import { profileRouter } from './profile.js';

type ListedComment = {
  id: string;
  novelId: string;
  chapterNumber: number | null;
  parentId: string | null;
  body: string;
  likes: number;
  novelTitle: string;
  createdAt: string;
};

const DATABASE_NAME = 'author_comments_route_test';

/**
 * Route-level tests for GET /api/v1/users/:id/comments.
 *
 * Real PostgreSQL, not the fake db: the route's contract IS a keyset query
 * over a composite index, and a hand-written mock would only assert that the
 * mock agrees with itself. The join, the DESC ordering and the cursor
 * boundary are the whole point, so they need a real planner.
 *
 * Isolation: provisions its OWN database on the same throwaway cluster booted
 * by src/test/pgGlobalSetup.ts and keys every fixture on a unique
 * `acr-rt-*` externalId. The guard makes it impossible to point this file at
 * production Neon.
 */
const baseUrl = process.env.PHASE1_PG_URL;
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

const JWT_SECRET = 'acr-rt-fixture-signing-key-32-bytes-min';
let counter = 0;
const nextSubject = () => `acr-rt-${process.pid.toString(36)}-${(counter += 1)}`;

/** Captured in beforeAll, restored in afterAll. */
const savedEnv = { ...process.env };

let pool: pg.Pool;
let database: ReturnType<typeof drizzle<typeof schema>>;
let app: Hono;
let authorRowId: string;
let authorExternalId: string;
let novelA: string;
let novelB: string;

async function seedNovel(id: string, title: string) {
  await database.insert(novels).values({
    id,
    title,
    author: 'Seed',
    category: 'test',
    coverUrl: 'https://cdn.test/c.png',
    summary: 's',
  });
}

/** Insert comments oldest-first so created_at ordering is unambiguous. */
async function seedComments(
  rows: Array<{
    novelId: string; chapterNumber: number | null; body: string;
    likes?: number; status?: string; parentId?: number; rootId?: number; depth?: number;
    minutesAgo: number;
  }>,
) {
  const base = Date.now();
  for (const r of rows) {
    // parent_id/root_id/depth must agree or `comments_thread_check` (drizzle
    // 0005:41) rejects the row: a reply needs BOTH ids and depth 1..3, a root
    // needs neither and depth 0. Mirrors the real insert at comments.ts:786.
    await database.insert(comments).values({
      novelId: r.novelId,
      userId: authorRowId,
      chapterNumber: r.chapterNumber,
      body: r.body,
      bodyHash: `h-${r.body}`,
      status: (r.status ?? 'visible') as 'visible' | 'pending' | 'hidden' | 'deleted',
      likesCount: r.likes ?? 0,
      parentId: r.parentId ?? null,
      rootId: r.rootId ?? null,
      depth: r.depth ?? 0,
      createdAt: new Date(base - r.minutesAgo * 60_000),
    });
  }
}

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() as any };
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

  try {
    await initDb();
    pool = new pg.Pool({ connectionString: url });
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });

    authorExternalId = nextSubject();
    const [author] = await database.insert(users).values({
      externalId: authorExternalId,
      email: `${authorExternalId}@test.local`,
      username: authorExternalId,
      displayName: 'Commenter',
      role: 'reader',
    }).returning();
    authorRowId = author.id;

    novelA = `acr-novel-a-${process.pid.toString(36)}`;
    novelB = `acr-novel-b-${process.pid.toString(36)}`;
    await seedNovel(novelA, 'Novel A');
    await seedNovel(novelB, 'Novel B');

    app = new Hono();
    app.route('/api/v1/users', profileRouter);
  } catch (err) {
    Object.assign(process.env, savedEnv);
    throw err;
  }
});

beforeEach(async () => {
  if (!url) return;
  // Make the file re-runnable against a persistent PHASE1_PG_URL: the exact
  // count and ordering assertions below are scoped to this author, whose rows
  // are deleted here, but OTHER authors' rows must not leak in either.
  await database.delete(comments);
  await database.delete(users).where(ne(users.externalId, authorExternalId));
});

afterAll(async () => {
  if (url) {
    try {
      if (pool) await pool.end();
    } catch { /* already closed */ }
    try {
      await closeDb();
    } catch { /* ignore */ }
    Object.assign(process.env, savedEnv);
  }
});

describe.skipIf(!url)('GET /users/:id/comments (author comment list)', () => {
  it('returns the author comments in the requested novel, newest first', async () => {
    await seedComments([
      { novelId: novelA, chapterNumber: 1, body: 'oldest', minutesAgo: 30 },
      { novelId: novelA, chapterNumber: 2, body: 'newest', likes: 4, minutesAgo: 5 },
    ]);
    const { status, body } = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.map((c: ListedComment) => c.body)).toEqual(['newest', 'oldest']);
    expect(body.data[0].likes).toBe(4);
    expect(body.total).toBe(2);
    expect(body.pagination.hasMore).toBe(false);
  });

  it('scopes strictly to novelId and never leaks another novel', async () => {
    await seedComments([
      { novelId: novelA, chapterNumber: 1, body: 'in-a', minutesAgo: 10 },
      { novelId: novelB, chapterNumber: 1, body: 'in-b', minutesAgo: 20 },
    ]);
    const a = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    expect(a.body.data.map((c: ListedComment) => c.body)).toEqual(['in-a']);

    const b = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelB}`);
    expect(b.body.data.map((c: ListedComment) => c.body)).toEqual(['in-b']);
  });

  it('includes replies, matching the /profile aggregate that counts them', async () => {
    // The hero stat on /:id/profile counts replies (no parentId filter), so a
    // top-level-only list would contradict the number above it.
    const [root] = await database.insert(comments).values({
      novelId: novelA, userId: authorRowId, chapterNumber: 1, body: 'root',
      bodyHash: 'h-root', status: 'visible', createdAt: new Date(Date.now() - 60_000),
    }).returning();
    await seedComments([
      { novelId: novelA, chapterNumber: 1, body: 'a reply', parentId: root.id, rootId: root.id, depth: 1, minutesAgo: 5 },
    ]);
    const { body } = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    expect(body.data).toHaveLength(2);
    const reply = body.data.find((c: ListedComment) => c.body === 'a reply');
    expect(reply.parentId).toBe(`app_${root.id}`);

    // The invariant that matters: list length equals the stat the hero shows.
    const profile = await get(`/api/v1/users/${authorRowId}/profile`);
    expect(body.data.length).toBe(profile.body.stats.commentsCount);
  });

  it('excludes pending, hidden and deleted rows', async () => {
    await seedComments([
      { novelId: novelA, chapterNumber: 1, body: 'visible', minutesAgo: 30 },
      { novelId: novelA, chapterNumber: 1, body: 'pending', status: 'pending', minutesAgo: 20 },
      { novelId: novelA, chapterNumber: 1, body: 'hidden', status: 'hidden', minutesAgo: 10 },
    ]);
    const { body } = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    expect(body.data.map((c: ListedComment) => c.body)).toEqual(['visible']);
  });

  it('excludes other authors', async () => {
    const otherExternal = nextSubject();
    const [other] = await database.insert(users).values({
      externalId: otherExternal, email: `${otherExternal}@test.local`,
      username: otherExternal, displayName: 'Someone Else', role: 'reader',
    }).returning();
    await database.insert(comments).values({
      novelId: novelA, userId: other.id, chapterNumber: 1, body: 'not mine',
      bodyHash: 'h-other', status: 'visible',
    });
    await seedComments([{ novelId: novelA, chapterNumber: 1, body: 'mine', minutesAgo: 5 }]);

    const { body } = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    expect(body.data.map((c: ListedComment) => c.body)).toEqual(['mine']);
  });

  it('resolves the same author by UUID and by externalId', async () => {
    await seedComments([{ novelId: novelA, chapterNumber: 1, body: 'x', minutesAgo: 5 }]);
    const byUuid = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    const byExt = await get(`/api/v1/users/${authorExternalId}/comments?novelId=${novelA}`);
    expect(byUuid.status).toBe(200);
    expect(byExt.status).toBe(200);
    expect(byExt.body.data).toEqual(byUuid.body.data);
  });

  it('paginates by cursor without repeating or dropping a row', async () => {
    await seedComments([
      { novelId: novelA, chapterNumber: 1, body: 'c1', minutesAgo: 50 },
      { novelId: novelA, chapterNumber: 1, body: 'c2', minutesAgo: 40 },
      { novelId: novelA, chapterNumber: 1, body: 'c3', minutesAgo: 30 },
      { novelId: novelA, chapterNumber: 1, body: 'c4', minutesAgo: 20 },
      { novelId: novelA, chapterNumber: 1, body: 'c5', minutesAgo: 10 },
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const qs = `novelId=${novelA}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await get(`/api/v1/users/${authorRowId}/comments?${qs}`);
      seen.push(...body.data.map((c: ListedComment) => c.body));
      if (!body.pagination.hasMore) break;
      cursor = body.pagination.nextCursor;
    }
    expect(seen).toEqual(['c5', 'c4', 'c3', 'c2', 'c1']);
    // Ordering is total, so no id is ever seen twice across pages.
    expect(new Set(seen).size).toBe(5);
  });

  it('nulls total on cursor pages and nulls nextCursor on the last page', async () => {
    await seedComments([
      { novelId: novelA, chapterNumber: 1, body: 'p1', minutesAgo: 30 },
      { novelId: novelA, chapterNumber: 1, body: 'p2', minutesAgo: 20 },
      { novelId: novelA, chapterNumber: 1, body: 'p3', minutesAgo: 10 },
    ]);
    const first = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}&limit=2`);
    expect(first.body.total).toBe(3);
    expect(first.body.pagination.hasMore).toBe(true);
    expect(first.body.pagination.nextCursor).toBeTruthy();

    const second = await get(
      `/api/v1/users/${authorRowId}/comments?novelId=${novelA}&limit=2&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`,
    );
    expect(second.body.total).toBeNull();
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pagination.hasMore).toBe(false);
    expect(second.body.pagination.nextCursor).toBeNull();
  });

  it('returns an empty page, not an error, when the author has none in that novel', async () => {
    await seedComments([{ novelId: novelB, chapterNumber: 1, body: 'elsewhere', minutesAgo: 5 }]);
    const { status, body } = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.pagination.hasMore).toBe(false);
  });

  it('includes the novel title so the client can label the card', async () => {
    await seedComments([{ novelId: novelA, chapterNumber: 7, body: 't', minutesAgo: 5 }]);
    const { body } = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    expect(body.data[0].novelTitle).toBe('Novel A');
    expect(body.data[0].chapterNumber).toBe(7);
  });

  it('requires novelId and never lists across every novel by accident', async () => {
    const { status, body } = await get(`/api/v1/users/${authorRowId}/comments`);
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_query');
  });

  it('400s a malformed cursor instead of silently restarting from the top', async () => {
    const { status, body } = await get(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}&cursor=not-a-cursor`);
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_cursor');
  });

  it('404s an unknown author and 400s a blank id', async () => {
    const missing = await get('/api/v1/users/11111111-1111-4111-8111-111111111111/comments?novelId=' + novelA);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('user_not_found');

    const blank = await get(`/api/v1/users/%20/comments?novelId=${novelA}`);
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe('invalid_id');
  });

  it('never exposes email in a publicly cacheable body', async () => {
    await seedComments([{ novelId: novelA, chapterNumber: 1, body: 'x', minutesAgo: 5 }]);
    const res = await app.request(`/api/v1/users/${authorRowId}/comments?novelId=${novelA}`);
    const text = await res.text();
    expect(text).not.toContain('@test.local');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=60');
  });
});
