# Admin Users Route — Round-Trip and Correctness Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `GET /api/v1/admin/users` from two sequential round trips to one, cut `PUT /api/v1/admin/users/:id` from three to one, and fix four correctness defects found in review — an int8/string `total` divergence between the Node and Workers runtimes, a TOCTOU race that can drop the system to zero admins, a latent 500 when a row is deleted mid-write, and unescaped LIKE metacharacters in the search term.

**Architecture:** No schema change and no migration. The `users` table holds 3 rows and every admin query measures ~0.05 ms, so the database is not a bottleneck; the cost is the *number* of network round trips to Neon from a mobile device. All work is confined to `src/routes/admin.ts` plus one new pure helper module and one new test file.

**Tech Stack:** Hono 4, Drizzle ORM 0.45 (`drizzle-orm/node-postgres` and `drizzle-orm/neon-http`), Zod, Vitest with a throwaway local PostgreSQL cluster.

**Design spec:** `../docs/superpowers/specs/2026-09-26-admin-screen-performance-design.md` §1–§3 (in the `Fan Novel` repo).

---

## Critical context for the implementer

**The test harness already exists and is safe.** `vitest.config.ts` sets `globalSetup: ['./src/test/pgGlobalSetup.ts']`, which boots a throwaway local PostgreSQL cluster. Every `*.postgres.test.ts` file must guard itself against pointing at production by validating `PHASE1_PG_URL`: the host must be `127.0.0.1` or `localhost`, the database must be `phase1_identity_test`, and there must be no query string or hash. Copy that guard verbatim from `src/routes/readingStats.plan.postgres.test.ts:28-40`.

**Do not add any index or migration.** Verified against live production on 2026-09-26: 3 users, 10 MB database, all admin queries 0.038–0.054 ms. Indexes are write amplification for zero gain.

**Two runtimes, one route.** `src/database/db.ts` builds either a `pg.Pool` (Node) or a `neon-http` client (Workers, per `isWorkersRuntime()` in `src/config/env.ts`). They disagree on `int8` parsing. Task 1 exists specifically to make `total` a real `number` on both.

**Test-file location is unconstrained here.** The server's `vitest.config.ts` only sets `exclude`, so any `*.test.ts` under `src/` is collected. The new test file is `src/routes/admin.postgres.test.ts`.

---

### Task 1: Single-round-trip user list with a numeric `total`

Replaces the sequential `rows` query and `count(*)` query in `GET /users` with one window-count query, and makes `total` a `number` on every runtime.

**Files:**
- Create: `src/routes/adminUserSearch.ts`
- Modify: `src/routes/admin.ts:1-70` (imports, `GET /users`)
- Test: `src/routes/admin.postgres.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/routes/admin.postgres.test.ts`. Start with the harness and the first two assertions:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../database/schema.js';
import { users } from '../database/schema.js';
import { signToken } from '../middleware/auth.js';
import { closeDb, initDb } from '../database/db.js';
import { adminRouter } from './admin.js';

const DATABASE_NAME = 'admin_route_test';

/**
 * Route-level tests for the admin user list and grant write path.
 *
 * Isolation: provisions its OWN database on the same throwaway cluster booted
 * by src/test/pgGlobalSetup.ts and keys every fixture on a unique
 * `admin-rt-*` externalId. The guard below makes it physically impossible to
 * point this file at production Neon.
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

const JWT_SECRET = 'admin-rt-fixture-signing-key-32-bytes-min';
let counter = 0;
const nextSubject = () => `admin-rt-${process.pid.toString(36)}-${(counter += 1)}`;

let pool: pg.Pool;
let database: ReturnType<typeof drizzle<typeof schema>>;
let app: Hono;
let adminToken: string;

async function createUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const externalId = nextSubject();
  const [row] = await database.insert(users).values({
    externalId,
    email: `${externalId}@test.local`,
    username: externalId,
    displayName: `User ${externalId}`,
    role: 'reader',
    isAuthor: false,
    isTranslator: false,
    ...overrides,
  }).returning();
  return row;
}

beforeAll(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE_NAME]);
  if (existing.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
  await admin.end();

  await initDb(url);
  pool = new pg.Pool({ connectionString: url });
  database = drizzle(pool, { schema });
  await migrate(database, { migrationsFolder: './drizzle' });

  const saved = { ...process.env };
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.GOOGLE_WEB_CLIENT_ID = 'web-client';
  process.env.ADMIN_EMAILS = 'admin@test.local';
  adminToken = signToken({ sub: 'admin-subject', email: 'admin@test.local' });
  Object.assign(process.env, saved);

  app = new Hono();
  app.route('/api/v1/admin', adminRouter);
});

afterAll(async () => {
  if (pool) await pool.end();
  await closeDb();
});

describe.skipIf(!url)('GET /api/v1/admin/users (isolated PostgreSQL)', () => {
  it('returns total as a number, not a string', async () => {
    await createUser();
    await createUser();
    const res = await app.request('/api/v1/admin/users?page=1&limit=20', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.total).toBe('number');
    expect(Number.isInteger(json.total)).toBe(true);
    expect(json.total).toBeGreaterThanOrEqual(2);
  });

  it('reports total 0 for a page past the end of the result set', async () => {
    await createUser({ displayName: 'paging-fixture' });
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&q=paging-fixture', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const first = await res.json();
    expect(first.total).toBe(1);

    const beyond = await app.request('/api/v1/admin/users?page=9&limit=100&q=paging-fixture', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const json = await beyond.json();
    expect(json.total).toBe(0);
    expect(json.data).toEqual([]);
  });
});
```

If `signToken` has a different signature in `src/middleware/auth.ts`, read that file and match it. Confirm the same for `initDb`/`closeDb` in `src/database/db.ts` and for how `googleAccount.postgres.test.ts` builds an authenticated Hono app — copy that file's auth wiring rather than inventing one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/routes/admin.postgres.test.ts`
Expected: the first test FAILS. Before the fix `total` is produced by `count()`'s `.mapWith(Number)`, so it is a number and the first test may pass; the second test FAILS or the file errors on the missing import if `adminRouter` is not yet exported in the shape you used. Record the actual failure text before continuing.

- [ ] **Step 3: Write the failing test for the single-round-trip guarantee**

Add to the same `describe` block. This asserts the query count, which is the actual point of the task. The pool is created inside `src/database/db.ts`, so instrument `pg.Pool.prototype.query` for the duration of one request rather than trying to hook Drizzle:

```ts
  it('resolves the page and the total in one database round trip', async () => {
    const original = pg.Pool.prototype.query;
    const seen: string[] = [];
    pg.Pool.prototype.query = function patched(this: pg.Pool, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as any)?.text;
      if (typeof text === 'string' && text.includes('from "users"')) seen.push(text);
      return original.apply(this, args as []);
    } as typeof pg.Pool.prototype.query;
    try {
      const res = await app.request('/api/v1/admin/users?page=1&limit=20', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect((await res.json()).success).toBe(true);
    } finally {
      pg.Pool.prototype.query = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('count(*) over()');
  });
```

Restore the prototype in a `finally` so a failing assertion cannot leak the patch into other tests in the file.

- [ ] **Step 4: Run to verify the new test fails**

Run: `npm test -- src/routes/admin.postgres.test.ts`
Expected: FAIL with `expected 2 to be length 1` — the current implementation issues two `from "users"` queries.

- [ ] **Step 5: Implement the window count**

In `src/routes/admin.ts`, add `sql` to the Drizzle import:

```ts
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
```

Add a module-level constant near `publicUser`:

```ts
/**
 * `count(*) over()` returns int8, which node-postgres parses as a STRING when
 * the pool has no custom type parsers (see db.ts: bare `new pg.Pool(...)`),
 * while neon-http returns int8 as a JSON number. Without `.mapWith(Number)`
 * the same endpoint would answer `total` as a string on Node and a number on
 * Workers. `count()` from drizzle-orm maps to Number for us; a raw window
 * count does not, so we map it explicitly.
 */
const totalOver = sql<number>`count(*) over()`.mapWith(Number);
```

Replace the body of `GET /users` (currently `src/routes/admin.ts:36-70`) so the try block becomes:

```ts
  try {
    const rows = await db
      .select({ ...adminUserColumns, total: totalOver })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit)
      .offset((page - 1) * limit);
    // A window function is not evaluated when OFFSET runs past the end, so an
    // out-of-range page yields no rows and therefore no total. Contract: an
    // empty page reports total 0, and the client treats that as end-of-list.
    const total = rows[0]?.total ?? 0;
    return c.json({
      success: true,
      total,
      data: rows.map(({ total: _total, ...row }) => publicUser(row)),
    });
  } catch (err) {
    console.error('[admin] users failed', err); noteDbFailure();
    return c.json({ error: 'فشل الجلب' }, 500);
  }
```

Three deliberate details:

- `adminUserColumns` is added in Task 5. Until then, define it as a temporary `const adminUserColumns = { id: users.id, email: users.email, ... }` in Task 1 listing every column `publicUser` reads, so Task 5 is a no-op refactor. `publicUser` reads exactly: `id`, `externalId`, `email`, `username`, `displayName`, `avatarUrl`, `bannerUrl`, `bio`, `role`, `isAuthor`, `isTranslator`, `createdAt`.
- `where` may be `undefined` when no filter is supplied. Drizzle accepts `.where(undefined)`, so no conditional is needed.
- `desc(users.id)` is added as a tie-break so `ORDER BY` is total and OFFSET pagination cannot skip or duplicate rows when two users share a `created_at`. This costs nothing without indexes and is a genuine correctness fix.

The `count` import is already removed; drizzle's `count()` maps to Number, and Task 4 re-adds the helper it needs.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/routes/admin.postgres.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin.ts src/routes/admin.postgres.test.ts
git commit -m "perf(admin): resolve user page and total in one round trip

count(*) over() replaces the sequential count(*) query, halving the
network round trips per page load. Mapped with Number because int8
parses as a string on the node-postgres pool and a number on neon-http.
Adds desc(users.id) as an ORDER BY tie-break so OFFSET pagination is
stable, and defines the empty-page total:0 contract."
```

---

### Task 2: Escape LIKE metacharacters in the admin search

`q` is interpolated raw into `%${q}%`. A user typing `%` produces `ILIKE '%%%'`, which matches every row in the table. PostgreSQL's LIKE uses backslash as its default escape character, so escaping with a backslash is sufficient and no `ESCAPE` clause is needed.

**Files:**
- Create: `src/routes/adminUserSearch.ts`
- Modify: `src/routes/admin.ts:49-53` (search clause), `:1-10` (import)
- Test: `src/routes/adminUserSearch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/routes/adminUserSearch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeLikePattern } from './adminUserSearch.js';

describe('escapeLikePattern', () => {
  it('leaves an ordinary term untouched', () => {
    expect(escapeLikePattern('ahmed')).toBe('ahmed');
  });

  it('escapes the percent wildcard so it cannot match every row', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
  });

  it('escapes the underscore wildcard', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('escapes backslashes before escaping wildcards', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('returns an empty string for an empty term', () => {
    expect(escapeLikePattern('')).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/routes/adminUserSearch.test.ts`
Expected: FAIL — `escapeLikePattern` is not exported.

- [ ] **Step 3: Implement**

Create `src/routes/adminUserSearch.ts`:

```ts
/**
 * Escape LIKE metacharacters in a user-supplied search term.
 *
 * The admin user search wraps the term in `%...%` and matches with ILIKE, so
 * an unescaped `%` from the search box would match every row in the table.
 * PostgreSQL's LIKE uses backslash as its default escape character, so
 * prefixing the three metacharacters is sufficient and needs no ESCAPE clause.
 *
 * Pure and dependency-free so it is directly unit testable.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (char) => `\\${char}`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/routes/adminUserSearch.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the route**

In `src/routes/admin.ts`, add:

```ts
import { escapeLikePattern } from './adminUserSearch.js';
```

Replace the search clause (currently `src/routes/admin.ts:49-53`):

```ts
  const searchWhere = q
    ? or(
        ilike(users.email, `%${escapeLikePattern(q)}%`),
        ilike(users.username, `%${escapeLikePattern(q)}%`),
        ilike(users.displayName, `%${escapeLikePattern(q)}%`),
      )
    : undefined;
```

- [ ] **Step 6: Add a route-level test proving the fix**

Append inside the existing `describe` block in `src/routes/admin.postgres.test.ts`:

```ts
  it('treats a percent wildcard in the search term as a literal', async () => {
    await createUser({ displayName: 'literal-percent-fixture' });
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&q=%25', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const json = await res.json();
    expect(json.total).toBe(0);
  });

  it('still matches a real substring containing no wildcard', async () => {
    await createUser({ displayName: 'needle-in-haystack' });
    const res = await app.request('/api/v1/admin/users?page=1&limit=100&q=needle-in', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const json = await res.json();
    expect(json.total).toBe(1);
  });
```

`%25` is the URL encoding of a literal `%`.

- [ ] **Step 7: Run both test files**

Run: `npm test -- src/routes/admin.postgres.test.ts src/routes/adminUserSearch.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/adminUserSearch.ts src/routes/adminUserSearch.test.ts src/routes/admin.ts src/routes/admin.postgres.test.ts
git commit -m "fix(admin): escape LIKE metacharacters in user search

An unescaped % in the search box produced ILIKE '%%%', matching every row
in the table. Adds a pure escapeLikePattern helper and a route-level test."
```

---

### Task 3: Single-round-trip grant write

`PUT /users/:id` currently does select → update → re-select. Replace the update and re-select with `.returning()`. This also removes a latent 500: if the row is deleted between the update and the re-select, `updated[0]` is `undefined` and `publicUser(undefined)` throws a `TypeError` that the catch turns into a 500 "فشل الحفظ".

**Files:**
- Modify: `src/routes/admin.ts:78-99` (`PUT /users/:id`)
- Test: `src/routes/admin.postgres.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `src/routes/admin.postgres.test.ts`:

```ts
describe.skipIf(!url)('PUT /api/v1/admin/users/:id (isolated PostgreSQL)', () => {
  it('returns the updated user', async () => {
    const target = await createUser({ isAuthor: false });
    const res = await app.request(`/api/v1/admin/users/${target.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAuthor: true }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(target.id);
    expect(json.data.isAuthor).toBe(true);
  });

  it('returns 404 for a user that does not exist', async () => {
    const res = await app.request('/api/v1/admin/users/00000000-0000-4000-8000-000000000000', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAuthor: true }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed body', async () => {
    const target = await createUser();
    const res = await app.request(`/api/v1/admin/users/${target.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'superuser' }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify which tests fail**

Run: `npm test -- src/routes/admin.postgres.test.ts`
Expected: the three new tests PASS against the current implementation, because the existing code is functionally correct for these cases. This step is a characterization baseline, not a failure — record that in the commit message for Task 5. The real defect (the 500 on concurrent delete) is covered in Task 4's file by the concurrency work, and is structurally eliminated by `.returning()` here.

If any of the three FAIL, stop and reconcile the auth wiring before continuing; that means the harness is wrong, not the route.

- [ ] **Step 3: Implement `.returning()`**

Replace the update and re-select in `PUT /users/:id` (currently `src/routes/admin.ts:89-97`):

```ts
    const updated = await db
      .update(users)
      .set({
        isAuthor: parsed.data.isAuthor ?? undefined,
        isTranslator: parsed.data.isTranslator ?? undefined,
        role: parsed.data.role ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    const row = updated[0];
    if (!row) return c.json({ error: 'المستخدم غير موجود' }, 404);
    return c.json({ success: true, data: publicUser(row) });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/routes/admin.postgres.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts src/routes/admin.postgres.test.ts
git commit -m "perf(admin): return the updated user from a single write

Replaces update + re-select with .returning(). Also removes a latent
500: a row deleted between the two statements made publicUser(undefined)
throw, which the catch reported as a save failure. Adds characterization
tests for the write path's 200/404/400 responses."
```

---

### Task 4: Make the last-admin guard atomic

> **REVISED 2026-09-26 after empirical testing. The original approach in this
> task was WRONG and has been replaced.** The original plan folded the admin
> count into the UPDATE's `WHERE` clause. That does not work. An uncorrelated
> subquery is evaluated once as an `InitPlan` against the statement's snapshot,
> which cannot see another transaction's uncommitted UPDATE. Measured on a
> real PostgreSQL instance with two connections forced to interleave
> (`BEGIN` on both, run both UPDATEs, only then `COMMIT` either):
>
> ```
> subquery-in-WHERE:   A updated: 1  B updated: 1  admins remaining: 0   FAILED 3/3
> row-lock-then-count: A updated: 1  B updated: 0  admins remaining: 1   PASSED 3/3
> ```
>
> So the "atomic" single-statement version leaves the system with **zero
> admins** — the exact failure the task exists to prevent. Note that a naive
> `Promise.all([a, b])` test **passes by luck**, because the race window is
> sub-millisecond over a connection pool; it only fails under a forced
> interleaving. Any test for this must force the interleaving or it proves
> nothing.

**Files:**
- Modify: `src/routes/admin.ts:84-88` (the demotion guard), `:1-10` (imports)
- Test: `src/routes/admin.postgres.test.ts`

- [ ] **Step 1: Write the failing test, forcing the interleaving**

The route must be exercised through its own database transaction, so the test
drives two concurrent transactions on two explicit clients: `BEGIN` both, run
the demotion on each, and commit only after both have evaluated their guard.

Use `Promise.allSettled`, not `Promise.all`: the losing demotion is *supposed*
to reject with 409, and `Promise.all` would throw before the assertions run.

Do **not** reproduce the original plan's `database.update(users).set({ role:
'reader' })` reset line: it demotes every admin including the fixture row
`getCaller` resolves, so every subsequent request in the file 403s.

- [ ] **Step 2: Implement the fix — lock, then count, then update, in one transaction**

The invariant needs the count and the write serialised, which means a row
lock, which means a transaction. Replace the read-then-update guard with:

```ts
    if (parsed.data.role === 'reader' && target.role === 'admin') {
      // Lock the whole admin set before counting. An uncorrelated count
      // subquery in the WHERE clause does NOT work here: it is evaluated once
      // against the statement's snapshot and cannot see a concurrent
      // transaction's uncommitted demotion, so two racing demotions both
      // observe two admins and both succeed, leaving zero admins. The row lock
      // serialises them, so the loser re-reads the count after the winner
      // commits. Verified 3/3 against a forced interleaving.
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select id from ${users} where role = 'admin' for update`);
        const counted = await tx.select({ n: count() }).from(users).where(eq(users.role, 'admin'));
        const admins = Number(counted[0]?.n ?? 0);
        if (admins <= 1) return null;
        const [demoted] = await tx
          .update(users)
          .set({ role: 'reader', updatedAt: new Date() })
          .where(eq(users.id, id))
          .returning();
        return demoted ?? null;
      });
      if (!result) return c.json({ error: 'لا يمكن إزالة آخر أدمن' }, 409);
      return c.json({ success: true, data: publicUser(result) });
    }
```

Note the early return: the demotion path completes here and must not fall
through to the generic update below, which would issue a second write.

- [ ] **Step 3: Run the forced-interleaving regression test**

Run: `npm test -- src/routes/admin.postgres.test.ts`
Expected: PASS, and the forced-interleaving test must FAIL if you revert to
the subquery-in-WHERE form. Verify that by reverting temporarily.

- [ ] **Step 4: Full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts src/routes/admin.postgres.test.ts
git commit -m "fix(admin): serialise the last-admin guard with a row lock

The guard counted admins and then updated with no lock, so two concurrent
demotions could both observe two admins, both succeed, and leave the
system with zero admins.

Folding the count into the UPDATE's WHERE clause does NOT fix this: an
uncorrelated subquery is evaluated once against the statement snapshot
and cannot see a concurrent uncommitted UPDATE. Measured against a real
PostgreSQL instance with the interleaving forced, that form leaves zero
admins 3 times out of 3. Locks the admin rows first, inside a
transaction, so the loser re-reads the count after the winner commits."
```

### Task 5: Explicit column projection

`select()` hydrates every `users` column, including `passwordHash` and all 14 `readingStats*` billing columns, and then `publicUser` throws almost all of them away. This is hygiene and payload reduction, not a latency fix: `publicUser` already whitelists, so no hash reaches the client, and at 200–500 ms per round trip the network dominates. Keep the projection aligned with `publicUser`, not with what the admin screen happens to render — other consumers exist.

`GET /requests` has the same shape at `src/routes/admin.ts:108-110`, where a join hydrates a full `users` row per pending request.

**Files:**
- Modify: `src/routes/admin.ts:23-31` (`publicUser`), `:36-40` (column list), `:108-117` (`GET /requests`)

- [ ] **Step 1: Define the shared projection**

Immediately above `publicUser` in `src/routes/admin.ts`:

```ts
/**
 * The exact set of user columns `publicUser` projects. Selecting explicitly
 * keeps passwordHash and the readingStats* billing columns from being
 * hydrated and serialized only to be discarded. Keep this list and
 * `publicUser` in sync — `publicUser` is the contract, this is the read path.
 */
const adminUserColumns = {
  id: users.id,
  externalId: users.externalId,
  email: users.email,
  username: users.username,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  bannerUrl: users.bannerUrl,
  bio: users.bio,
  role: users.role,
  isAuthor: users.isAuthor,
  isTranslator: users.isTranslator,
  createdAt: users.createdAt,
} as const;
```

- [ ] **Step 2: Use it in `GET /users`**

If Task 1 defined a temporary local `adminUserColumns`, delete that local definition so the module-level one is used. Confirm the `GET /users` select reads:

```ts
    const rows = await db
      .select({ ...adminUserColumns, total: totalOver })
```

- [ ] **Step 3: Use it in `GET /requests`**

Replace `src/routes/admin.ts:108-110` with an explicit nested projection:

```ts
    const rows = await db
      .select({
        req: {
          id: roleRequests.id,
          userId: roleRequests.userId,
          kind: roleRequests.kind,
          status: roleRequests.status,
          reason: roleRequests.reason,
          decidedBy: roleRequests.decidedBy,
          decidedAt: roleRequests.decidedAt,
          createdAt: roleRequests.createdAt,
        },
        user: {
          id: users.id,
          externalId: users.externalId,
          email: users.email,
          username: users.username,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          bannerUrl: users.bannerUrl,
          bio: users.bio,
          role: users.role,
          isAuthor: users.isAuthor,
          isTranslator: users.isTranslator,
          createdAt: users.createdAt,
        },
      })
      .from(roleRequests)
      .leftJoin(users, eq(roleRequests.userId, users.id))
      .where(eq(roleRequests.status, status))
      .orderBy(desc(roleRequests.createdAt))
      .limit(200);
```

- [ ] **Step 4: Verify the requests response shape is unchanged**

Read `GrantRequest` in `src/database/schema.ts` and confirm every field the current `...r.req` spread emits is present in the explicit `req` projection above. If `roleRequests` has any column not listed, add it — a dropped column is a silent client regression. The client's `adminRequests` in the app repo returns each row to `app/admin/index.tsx`, which reads `id`, `kind`, `userId`, and `user`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.ts
git commit -m "perf(admin): project only the columns publicUser returns

select() hydrated passwordHash and 14 readingStats* billing columns per
row, then discarded them. Payload and hydration hygiene, not a latency
fix — the round trip dominates. Applies to GET /users and GET /requests."
```

---

## Verification

Run all of these before calling the plan done:

```bash
npm test
npx tsc --noEmit
```

Then confirm by inspection:

- `grep -c "from \"users\"" src/routes/admin.ts` — `GET /users` issues exactly one users query.
- `grep -n "count(\*) over()" src/routes/admin.ts` — present, with `.mapWith(Number)`.
- `grep -n "select()" src/routes/admin.ts` — no bare full-table selects remain in the two list routes.
- `git diff main --stat` shows no migration files and no `drizzle/` changes.

Do **not** run any migration or apply anything to the production Neon database. This plan changes no schema.

Report the measured test counts and the two verification greps to the user before starting the companion app-side plan.
