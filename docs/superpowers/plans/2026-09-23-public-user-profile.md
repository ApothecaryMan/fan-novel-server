# Public User Profile Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a public, unauthenticated `GET /api/v1/users/:id/profile` endpoint that returns a PII-free user object plus visible-comment stats, so tapping an avatar in server-novel comments no longer falls back to `comments=0, likes=0`.

**Architecture:** Extend `profileRouter` with one new route registered strictly AFTER `/me/profile` (Hono matches in registration order); dual UUID-first/externalId-second user resolution; a single Drizzle aggregate over `comments` (`COUNT(*)` + `COALESCE(SUM(likes_count),0)` filtered to `user_id = resolved UUID AND status = 'visible'`); a `memUsers` reader exported from `auth.ts` for the no-DB memory fallback; one new `userPublicProfile` entry in the `/api/v1` index. No schema migration, no comments-route change, no rate-limit change.

**Tech Stack:** Hono + Drizzle ORM + Neon Postgres (neon-http on Workers, pg Pool on Node), Vitest with local `app.request` harness, existing `identityDb()` fake extended with a `comments` aggregate.

---

## File map (what changes and why)

| File | Responsibility in this plan |
| --- | --- |
| `src/routes/auth.ts` | Export a read-only `findMemoryUser(raw)` helper over the existing module-level `memUsers` array (externalId match first, then id match). No behavior change to any existing route. |
| `src/routes/profile.ts` | Import `comments`, `getEnv`, `findMemoryUser`; add `UUID_RE` + `toPublicSafe()` (existing `toPublic()` minus `email`); add public `GET '/:id/profile'` handler AFTER the `/me/profile` block. This is the only product-code route change. |
| `src/test/identityDb.ts` | Extend the fake with a `commentRows` store, a `seedComments()` seeder, and a `comments`-table aggregate path in `query()` that honors `user_id` + `status` filters and returns `{ commentsCount, likesReceived }`. No change to `users` behavior. |
| `src/routes/profile.test.ts` | Add a `GET /users/:id/profile` describe block covering resolution, visibility filter, likes sum, PII omission, headers/errors, and memory-fallback zeros. Existing tests stay byte-for-byte. |
| `src/app.ts` | Add `userPublicProfile: 'GET /api/v1/users/:id/profile'` to the `/api/v1` index `endpoints` map. One line, additive only. |
| Untouched (do NOT edit) | `src/database/schema.ts`, `drizzle/*`, `src/routes/comments.ts`, `src/middleware/*`, `src/worker.ts`, `wrangler.toml`, `package.json`. No new dependencies. |

**Key contracts the implementer must not break (from the approved spec):**
- `:id` = trimmed exact match; UUID lookup first, externalId second; empty/whitespace-only → `400 { success:false, code:'invalid_id', error:'invalid user id' }`; no match → `404 { success:false, code:'user_not_found', error:'user not found' }`; malformed UUIDs fall through to externalId lookup, never 400. `username` lookup is out of scope.
- 200 body = `{ success:true, user:{id,externalId,name,username,avatarUrl,bannerUrl,bio,status,role,isAuthor,isTranslator,provider:'google'}, stats:{commentsCount,likesReceived} }` with `email` key ABSENT (not null), `status` mirroring `bio`, `id`/`externalId` canonicalized as `externalId ?? id`.
- Stats = one query `SELECT COUNT(*) AS "commentsCount", COALESCE(SUM("likes_count"),0) AS "likesReceived" FROM comments WHERE user_id = <resolved users.id> AND status='visible'`. Replies included; pending/hidden/deleted excluded.
- Success sends exactly `Cache-Control: public, max-age=60, stale-while-revalidate=60` and no `Vary: Authorization`; 4xx/5xx send NO public cache header.
- DB throw during user OR stats lookup → `noteDbFailure()` + `console.warn` storage event with `requestId` and NO driver text → `503 { success:false, code:'account_unavailable', error:'account storage unavailable' }`.
- No-DB + prod → same 503. No-DB + non-prod → `memUsers` lookup (externalId then id); hit → same public shape with `{commentsCount:0,likesReceived:0}` + public cache header; miss → same 404.
- Existing `/api/v1/users/*` `rateLimit(30)` applies automatically; do NOT touch `src/app.ts` middleware lines.

---

### Task 1: Establish baseline and confirm harness

**Files:** none modified (read-only verification).

- [x] **Step 1: Confirm working tree is clean and spec files are present** (DONE 2026-09-23: tree clean except expected untracked specs/plans, 5 paths present, 7 tests baseline pass, grep exit=1)

Run:
```bash
git status --short && ls docs/superpowers/specs/2026-09-23-public-user-profile-design.md src/routes/profile.ts src/app.ts src/routes/profile.test.ts src/test/identityDb.ts
```
Expected: `git status --short` prints nothing (clean tree); `ls` lists all five paths with no error.

- [x] **Step 2: Run the existing profile test file as a baseline**

Run:
```bash
npx vitest run src/routes/profile.test.ts
```
Expected: all tests pass (currently 6 tests: 5 level-engine + 2 profile describes — output ends with `Test Files  1 passed` and `Tests  7 passed` or similar; key line: no failures). If this fails, stop and report — do not continue.

- [x] **Step 3: Confirm the public route does not exist yet**

Run:
```bash
grep -rn ":id/profile\|userPublicProfile" src/routes/profile.ts src/app.ts src/routes/profile.test.ts; echo "exit=$?"
```
Expected: no matches, final line `exit=1` (grep found nothing). This proves the feature is absent before you start.

---

### Task 2: Export a memory-user reader from `src/routes/auth.ts`

**Files:**
- Modify: `src/routes/auth.ts` (one insertion after the `memUsers` declaration, line 15).

Why: `profile.ts` needs to resolve memory-fixture users when `!isDbAvailable()` in non-prod, but `memUsers` is module-private to `auth.ts`. Exporting a read-only finder is the smallest seam (no route behavior changes, no export of the mutable array itself).

- [x] **Step 1: Add the `findMemoryUser` export**

Exact old string (lines 14-15 of `src/routes/auth.ts`):
```ts
// Explicit development/test fixtures only. Never consult these in production.
const memUsers: any[] = [];
```

Exact new string:
```ts
// Explicit development/test fixtures only. Never consult these in production.
const memUsers: any[] = [];

// Read-only memory-fixture lookup for the public profile route (non-prod, no DB).
// externalId match first (dev fixtures are keyed by externalId, with id === externalId),
// then id match; returns the stored object (do NOT mutate) or null.
export function findMemoryUser(raw: string): any | null {
  return memUsers.find((u) => u.externalId === raw) ?? memUsers.find((u) => u.id === raw) ?? null;
}
```

- [x] **Step 2: Verify the edit compiles in isolation**

Run:
```bash
npx tsc --noEmit 2>&1 | head -20; echo "typecheck_exit=$?"
```
Expected: no output lines mentioning `auth.ts`, final line `typecheck_exit=0`. (Full typecheck runs again in Task 7; this is an early signal.)

- [x] **Step 3: Verify no existing auth behavior changed**

Run:
```bash
git diff --stat && git diff src/routes/auth.ts | head -40
```
Expected: `git diff --stat` shows only `src/routes/auth.ts` with `1 insertion`-style output (exactly ~9 added lines, 0 removed); the diff shows only the `findMemoryUser` addition and no other hunk.

---

### Task 3: Extend the `identityDb()` fake with a `comments` aggregate

**Files:**
- Modify: `src/test/identityDb.ts` (full-file replacement below).

Why: the approved spec (§"Test harness") states the current fake returns `[]` for any non-`users` table and throws `unexpected test query` for unknown `users` columns. The new route's stats query (`db.select({commentsCount: count(), likesReceived: sql...}).from(comments).where(and(eq(comments.userId,...), eq(comments.status,'visible')))`) needs a fake that filters seeded comment rows and returns the aggregate. This task changes TEST SCAFFOLDING ONLY — no product code.

Design notes the implementer must preserve:
- `users` behavior (matches/insert/update/fail/unavailable/reset) is byte-for-byte unchanged.
- `select()` now captures its fields argument so `query()` can detect the aggregate shape (`'commentsCount' in fields`).
- Comment filtering parses the Drizzle-generated SQL generically: every `"comments"."<col>"` occurrence maps positionally to `query.params[i]`. Only `user_id` and `status` are honored; any other filter shape still works (unmatched columns are ignored, never throw).
- `likesReceived` uses `?? 0` per row so `null` likes are null-safe, and an empty filtered set yields `{ commentsCount: 0, likesReceived: 0 }` (mirrors SQL `COALESCE`).
- `fail(value)` poisons comment queries too (via the shared `check()`), so the 503 test can reuse `fake().fail(new Error(...))`.
- `reset()` clears comment rows and all mocks.

- [x] **Step 1: Replace `src/test/identityDb.ts` with the extended version**

Write the COMPLETE file (overwrite). Full contents:
```ts
import { vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { comments, users } from '../database/schema.js';

type Row = typeof users.$inferSelect;

export interface FakeCommentSeed {
  userId: string | null;
  status: string;
  likesCount?: number | null;
}

export function identityDb() {
  const rows: Row[] = [];
  const commentRows: { userId: string | null; status: string; likesCount: number | null }[] = [];
  let unavailable = false;
  let failure: unknown = null;
  let nextInsertError: unknown = null;
  const dialect = new PgDialect();
  function matches(row: Row, condition?: SQL) {
    if (!condition) return true;
    const query = dialect.sqlToQuery(condition);
    const column = /"users"\."([a-z_]+)"/.exec(query.sql)?.[1];
    const key = ({ google_subject: 'googleSubject', external_id: 'externalId', id: 'id',
      username: 'username', email: 'email', role: 'role' } as Record<string, keyof Row>)[column ?? ''];
    if (!key) throw new Error('unexpected test query');
    return row[key] === query.params[0];
  }
  // Parse a comments WHERE clause generically: each `"comments"."<col>"`
  // maps positionally to the same-index query param (drizzle emits $1, $2... in order).
  function commentFilter(condition?: SQL): { userId?: string | null; status?: string } {
    if (!condition) return {};
    const query = dialect.sqlToQuery(condition);
    const cols = [...query.sql.matchAll(/"comments"\."([a-z_]+)"/g)].map((m) => m[1]);
    const out: { userId?: string | null; status?: string } = {};
    cols.forEach((col, i) => {
      if (col === 'user_id') out.userId = query.params[i] as string | null;
      if (col === 'status') out.status = query.params[i] as string;
    });
    return out;
  }
  function check() { if (failure) throw failure; }
  function query(table: unknown, condition?: SQL, fields?: unknown): any {
    const execute = async () => {
      check();
      if (table === users) return rows.filter((r) => matches(r, condition));
      if (table === comments) {
        const filter = commentFilter(condition);
        const visible = commentRows.filter((cm) =>
          (filter.userId === undefined || cm.userId === filter.userId) &&
          (filter.status === undefined || cm.status === filter.status));
        if (fields !== null && typeof fields === 'object' && fields !== undefined &&
          ('commentsCount' in (fields as Record<string, unknown>) ||
           'likesReceived' in (fields as Record<string, unknown>))) {
          const commentsCount = visible.length;
          const likesReceived = visible.reduce((sum, cm) => sum + (cm.likesCount ?? 0), 0);
          return [{ commentsCount, likesReceived }];
        }
        return visible;
      }
      return [];
    };
    const builder = {
      where: (value: SQL) => query(table, value, fields),
      limit: (_value: number) => execute(),
      orderBy: (_value: unknown) => builder,
      then: (resolve: (value: any[]) => unknown, reject?: (reason: unknown) => unknown) => execute().then(resolve, reject),
    };
    return builder;
  }
  const insert = vi.fn((table: unknown) => ({ values: (value: Partial<Row>) => {
    const execute = async () => {
      check();
      if (nextInsertError) { const error = nextInsertError; nextInsertError = null; throw error; }
      if (table !== users) return [];
      const row = { id: crypto.randomUUID(), email: null, googleSubject: null, externalId: null,
        username: null, displayName: null, passwordHash: null, avatarUrl: null, bannerUrl: null, bio: null,
        role: 'reader', isAuthor: false, isTranslator: false, createdAt: new Date(), updatedAt: new Date(), ...value } as Row;
      for (const key of ['externalId', 'googleSubject', 'email', 'username'] as const) {
        if (row[key] !== null && rows.some((existing) => existing[key] === row[key])) throw { code: '23505' };
      }
      rows.push(row); return [row];
    };
    return { returning: execute, onConflictDoNothing: async () => {
      try { return await execute(); } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        return [];
      }
    } };
  } }));
  const update = vi.fn((_table: unknown) => ({ set: (patch: Partial<Row>) => ({ where: (condition: SQL) => {
    const execute = async () => {
      check();
      const targets = rows.filter((row) => matches(row, condition));
      for (const target of targets) {
        for (const key of ['email', 'username'] as const) {
          if (patch[key] != null && rows.some((other) => other !== target && other[key] === patch[key])) throw { cause: { code: '23505' } };
        }
      }
      targets.forEach((target) => Object.assign(target, patch)); return targets;
    };
    return { returning: execute, then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) => execute().then(resolve, reject) };
  } }) }));
  const database = { select: vi.fn((fields?: unknown) => ({ from: (table: unknown) => query(table, undefined, fields) })), insert, update };
  function seedComments(list: FakeCommentSeed[]) {
    for (const item of list) {
      commentRows.push({ userId: item.userId, status: item.status, likesCount: item.likesCount ?? 0 });
    }
  }
  return { rows, commentRows, seedComments, db: database, isDbAvailable: () => !unavailable, noteDbFailure: vi.fn(),
    unavailable: (value: boolean) => { unavailable = value; },
    fail: (value: unknown) => { failure = value; },
    failNextInsert: (value: unknown) => { nextInsertError = value; },
    reset: () => { rows.length = 0; commentRows.length = 0; unavailable = false; failure = null; nextInsertError = null;
      insert.mockClear(); update.mockClear(); database.select.mockClear(); },
  };
}

export const productionBindings = {
  NODE_ENV: 'production', SYNC_OPEN: 'false', DATABASE_URL: 'postgresql://local:local@localhost/fixture',
  JWT_SECRET: 'fixture-production-signing-key-32-bytes-minimum', GOOGLE_WEB_CLIENT_ID: 'web-client', ADMIN_EMAILS: 'admin@test.com',
};
```

- [x] **Step 2: Typecheck the fake**

Run:
```bash
npx tsc --noEmit 2>&1 | head -20; echo "typecheck_exit=$?"
```
Expected: no lines mentioning `identityDb.ts`; final line `typecheck_exit=0`.

- [x] **Step 3: Run existing profile tests to prove the fake change is non-breaking**

Run:
```bash
npx vitest run src/routes/profile.test.ts
```
Expected: `Test Files  1 passed`, `Tests  7 passed` (same count as Task 1 baseline — no new tests yet, no regressions).

---

### Task 4: Implement `GET /:id/profile` in `src/routes/profile.ts`

**Files:**
- Modify: `src/routes/profile.ts` (two edits: import block, then new route appended AFTER line 182).

This is the core product change. Read these exact requirements before touching the file:
- Route MUST be registered after the `/me/profile` block (Hono matches in registration order; `/:id/profile` would otherwise swallow the literal `me` segment). Append at end of file.
- No `requireAuth` middleware on the new route.
- `comments` table import added to the existing schema import; `getEnv` imported from `../config/env.js`; `findMemoryUser` imported from `./auth.js`. (`db`, `isDbAvailable`, `noteDbFailure`, `and`, `count`, `eq`, `sql` are already imported.)
- `toPublic()` stays UNTOUCHED (private route uses it verbatim). Add a separate `toPublicSafe()` that strips `email` via destructure (allow-list by removal at the boundary, so future `toPublic` fields still flow through except `email`).

- [x] **Step 1: Update the import block**

Exact old string:
```ts
import { Hono } from 'hono';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { readingHistory, readingSessions, userLibrary, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
```

Exact new string:
```ts
import { Hono } from 'hono';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { comments, readingHistory, readingSessions, userLibrary, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import { findMemoryUser } from './auth.js';
```

- [x] **Step 2: Append the public route AFTER the `/me/profile` block (end of file)**

Append this EXACT code after line 182 (`});` closing the `/me/profile` handler). Do not insert it anywhere else:
```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public projection: identical to toPublic() except the `email` key is ABSENT
// (destructured away, never null) so publicly cacheable bodies cannot leak PII.
function toPublicSafe(u: any) {
  const { email: _email, ...rest } = toPublic(u);
  return rest;
}

// GET /api/v1/users/:id/profile — public author card for comment avatar taps.
// No auth. :id accepts users.id (UUID) or users.externalId (google_<sub>, dev_<email>).
// Registered AFTER /me/profile so Hono never routes the literal `me` here.
profileRouter.get('/:id/profile', async (c) => {
  const raw = String(c.req.param('id') ?? '').trim();
  if (!raw) return c.json({ success: false, code: 'invalid_id', error: 'invalid user id' }, 400);
  // Memory fallback (no DB): non-prod resolves dev fixtures with zeroed stats;
  // production without storage fails closed.
  if (!isDbAvailable()) {
    if (getEnv().isProd) {
      return c.json({ success: false, code: 'account_unavailable', error: 'account storage unavailable' }, 503);
    }
    const mem = findMemoryUser(raw);
    if (!mem) return c.json({ success: false, code: 'user_not_found', error: 'user not found' }, 404);
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, user: toPublicSafe(mem), stats: { commentsCount: 0, likesReceived: 0 } });
  }
  try {
    let row: any = null;
    // UUID-first: comment author chips carry the users.id UUID (dominant tap path).
    // A UUID-shaped externalId still resolves via the externalId fallthrough below.
    if (UUID_RE.test(raw)) {
      [row] = await db.select().from(users).where(eq(users.id, raw)).limit(1);
    }
    if (!row) {
      [row] = await db.select().from(users).where(eq(users.externalId, raw)).limit(1);
    }
    if (!row) return c.json({ success: false, code: 'user_not_found', error: 'user not found' }, 404);
    // Single aggregate over the RESOLVED uuid; visible rows only (replies included,
    // pending/hidden/deleted excluded; orphaned user_id IS NULL rows never match).
    const [statsRow] = await db.select({
      commentsCount: count(),
      likesReceived: sql<number>`COALESCE(SUM(${comments.likesCount}), 0)`,
    }).from(comments).where(and(eq(comments.userId, row.id), eq(comments.status, 'visible')));
    const commentsCount = Number(statsRow?.commentsCount ?? 0);
    const likesReceived = Number(statsRow?.likesReceived ?? 0);
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, user: toPublicSafe(row), stats: { commentsCount, likesReceived } });
  } catch (error) {
    noteDbFailure();
    console.warn(JSON.stringify({ event: 'profile.storage', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
    return c.json({ success: false, code: 'account_unavailable', error: 'account storage unavailable' }, 503);
  }
});
```

- [x] **Step 3: Verify route ordering and imports**

Run:
```bash
grep -n "profileRouter.get\|^import\|from './auth.js'\|from '../config/env.js'" src/routes/profile.ts
```
Expected output lines (order matters):
- `profileRouter.get('/me/profile', ...)` appears on a LOWER line number than `profileRouter.get('/:id/profile', ...)`
- import lines include `comments` in the schema import, plus `./auth.js` and `../config/env.js`
- `toPublic(` (the original helper) still present and unmodified.

Run:
```bash
git diff src/routes/profile.ts | grep -c "^+" && git diff src/routes/profile.ts | grep "^-[^-]" | head -10; echo "removed_lines_above(empty_expected)"
```
Expected: added-line count is a positive number (~50); the removed-lines listing is EMPTY (pure addition — `/me/profile` untouched).

- [x] **Step 4: Typecheck**

Run:
```bash
npx tsc --noEmit 2>&1 | head -20; echo "typecheck_exit=$?"
```
Expected: no errors, final line `typecheck_exit=0`.

---

### Task 5: Add the `/api/v1` index entry in `src/app.ts`

**Files:**
- Modify: `src/app.ts` (one line in the `/api/v1` index `endpoints` map).

- [x] **Step 1: Add `userPublicProfile` alongside the unchanged `userProfile` entry**

Exact old string:
```ts
        userProfile: 'GET /api/v1/users/me/profile',
```

Exact new string:
```ts
        userProfile: 'GET /api/v1/users/me/profile',
        userPublicProfile: 'GET /api/v1/users/:id/profile',
```

- [x] **Step 2: Verify the index edit**

Run:
```bash
grep -n "userProfile\|userPublicProfile" src/app.ts
```
Expected:
```
159:        userProfile: 'GET /api/v1/users/me/profile',
160:        userPublicProfile: 'GET /api/v1/users/:id/profile',
```
(line numbers may shift by 0; the requirement is both lines present, `userProfile` value unchanged, `userPublicProfile` immediately after it).

Run:
```bash
git diff src/app.ts
```
Expected: diff shows exactly one added line and zero removed lines; no middleware/rate-limit lines touched.

---

### Task 6: Add public-route coverage to `src/routes/profile.test.ts`

**Files:**
- Modify: `src/routes/profile.test.ts` (two edits: import line, then appended describe block).

Test data rules (follow exactly — these mirror the spec's Testing Strategy §1-6):
- UUID fixture `A1_UUID = '11111111-1111-4111-8111-111111111111'` (valid UUID shape so the UUID-first path is exercised) with `externalId: 'google_sub1'`, `email: 'author1@test.com'`.
- Visibility test seeds visible ×2 (one root-like, one reply-like — both are plain comment rows), pending ×1, hidden ×1, deleted ×1 → `commentsCount === 2`.
- Likes test uses visible rows with `likesCount` 3 and 5 plus a hidden row with `likesCount` 100 → `likesReceived === 8`. A second author with zero visible rows yields `{0, 0}`.
- PII test asserts BOTH `expect(body.user).not.toHaveProperty('email')` AND that the serialized text does not contain the author's email string.
- Header test asserts the EXACT string `public, max-age=60, stale-while-revalidate=60` on 200.
- Empty-id test: Hono does not route `GET /users//profile`, so the 400 path is exercised at the unit level by requesting the encoded-whitespace id `GET /users/%20/profile` (decodes/trims to empty → 400 `invalid_id`).
- 503 test uses `fake().fail(new Error('secret-driver-detail'))` then asserts status 503, `code: 'account_unavailable'`, and that the body text contains neither `secret-driver-detail` nor the author's email.
- Memory-fallback test: set non-prod env + unavailable DB, seed a memory fixture via the auth login flow with NO idToken (`POST /auth/google` with `{ email }` only → `dev_<email>` fixture), then GET by externalId and assert 200 with zeroed stats; unknown id in the same mode → 404. NOTE: switching `__WORKER_ENV__` mid-file requires re-importing routers is NOT needed (routers read env per-request via `getEnv()`); but `setWorkerEnv` + `holder.fake.unavailable(true)` must be restored after the test so later tests see production bindings. The test below saves/restores inline.

- [x] **Step 1: Extend the test imports**

Exact old string:
```ts
import { identityDb, productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';
```

Exact new string:
```ts
import { identityDb, productionBindings } from '../test/identityDb.js';
import { getEnv, setWorkerEnv } from '../config/env.js';
import { users } from '../database/schema.js';
```

- [x] **Step 2: Append the public-profile describe block at end of file**

Append this EXACT block after the final `});` of the file:
```ts
describe('GET /users/:id/profile (public)', () => {
  const A1_UUID = '11111111-1111-4111-8111-111111111111';
  const A1_EXTERNAL = 'google_sub1';
  const A1_EMAIL = 'author1@test.com';
  const B_UUID = '22222222-2222-4222-8222-222222222222';

  async function seedAuthorA() {
    await fake().db.insert(users).values({ id: A1_UUID, externalId: A1_EXTERNAL,
      email: A1_EMAIL, displayName: 'Author One', username: 'authorone',
      avatarUrl: 'https://cdn.test/a1.png', bannerUrl: null, bio: 'hello bio',
      role: 'reader', isAuthor: true, isTranslator: false }).returning();
  }

  it('resolves the same author by UUID and by externalId with identical identity', async () => {
    await seedAuthorA();
    fake().seedComments([{ userId: A1_UUID, status: 'visible', likesCount: 1 }]);
    const byUuid = await app.request(`/users/${A1_UUID}/profile`);
    const byExt = await app.request(`/users/${A1_EXTERNAL}/profile`);
    expect(byUuid.status).toBe(200);
    expect(byExt.status).toBe(200);
    const a: any = await byUuid.json();
    const b: any = await byExt.json();
    expect(a).toMatchObject({ success: true, stats: { commentsCount: 1, likesReceived: 1 } });
    expect(b.user).toEqual(a.user);
    expect(a.user).toMatchObject({ id: A1_EXTERNAL, externalId: A1_EXTERNAL,
      name: 'Author One', username: 'authorone', role: 'reader',
      isAuthor: true, isTranslator: false, provider: 'google', status: 'hello bio', bio: 'hello bio' });
  });

  it('counts visible only (pending/hidden/deleted excluded, replies included)', async () => {
    await seedAuthorA();
    fake().seedComments([
      { userId: A1_UUID, status: 'visible', likesCount: 0 },
      { userId: A1_UUID, status: 'visible', likesCount: 0 },
      { userId: A1_UUID, status: 'pending', likesCount: 0 },
      { userId: A1_UUID, status: 'hidden', likesCount: 0 },
      { userId: A1_UUID, status: 'deleted', likesCount: 0 },
    ]);
    const res = await app.request(`/users/${A1_UUID}/profile`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.stats.commentsCount).toBe(2);
  });

  it('sums likes over visible rows only and zeroes COALESCE for authors with none visible', async () => {
    await seedAuthorA();
    await fake().db.insert(users).values({ id: B_UUID, externalId: 'google_subB',
      email: 'b@test.com', displayName: 'B', role: 'reader' }).returning();
    fake().seedComments([
      { userId: A1_UUID, status: 'visible', likesCount: 3 },
      { userId: A1_UUID, status: 'visible', likesCount: 5 },
      { userId: A1_UUID, status: 'hidden', likesCount: 100 },
      { userId: B_UUID, status: 'hidden', likesCount: 7 },
    ]);
    const a: any = await (await app.request(`/users/${A1_UUID}/profile`)).json();
    expect(a.stats).toEqual({ commentsCount: 2, likesReceived: 8 });
    const b: any = await (await app.request(`/users/${B_UUID}/profile`)).json();
    expect(b.stats).toEqual({ commentsCount: 0, likesReceived: 0 });
  });

  it('never exposes email (key absent, address absent from serialized body)', async () => {
    await seedAuthorA();
    fake().seedComments([]);
    const res = await app.request(`/users/${A1_EXTERNAL}/profile`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.user).not.toHaveProperty('email');
    expect(JSON.stringify(body)).not.toContain(A1_EMAIL);
    expect(Object.keys(body.user).sort()).toEqual(['avatarUrl', 'bannerUrl', 'bio',
      'externalId', 'id', 'isAuthor', 'isTranslator', 'name', 'provider', 'role', 'status', 'username']);
  });

  it('sends the exact public cache header on success; 404 for unknown ids', async () => {
    await seedAuthorA();
    fake().seedComments([]);
    const res = await app.request(`/users/${A1_UUID}/profile`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=60');
    expect(res.headers.get('Vary')).toBeNull();
    const unknownUuid = await app.request('/users/33333333-3333-4333-8333-333333333333/profile');
    expect(unknownUuid.status).toBe(404);
    expect(await unknownUuid.json()).toEqual({ success: false, code: 'user_not_found', error: 'user not found' });
    const unknownExt = await app.request('/users/google_nonexistent/profile');
    expect(unknownExt.status).toBe(404);
    expect(await unknownExt.json()).toEqual({ success: false, code: 'user_not_found', error: 'user not found' });
    expect(unknownUuid.headers.get('Cache-Control')).not.toContain('public');
  });

  it('400 invalid_id for whitespace-only id; 503 without leak on storage failure', async () => {
    const empty = await app.request('/users/%20/profile');
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ success: false, code: 'invalid_id', error: 'invalid user id' });
    await seedAuthorA();
    fake().fail(new Error('secret-driver-detail'));
    const res = await app.request(`/users/${A1_UUID}/profile`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('secret-driver-detail');
    expect(text).not.toContain(A1_EMAIL);
    expect(await JSON.parse(text)).toEqual({ success: false, code: 'account_unavailable', error: 'account storage unavailable' });
    expect(fake().noteDbFailure).toHaveBeenCalled();
  });

  it('memory fallback in non-prod returns zeros for known fixtures and 404 for unknown', async () => {
    vi.stubGlobal('__WORKER_ENV__', { ...productionBindings, NODE_ENV: 'development', DATABASE_URL: undefined });
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', DATABASE_URL: undefined } as any);
    expect(getEnv().isProd).toBe(false);
    fake().unavailable(true);
    try {
      const created = await app.request('/auth/google', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'mem@test.com', name: 'Mem Fixture' }) });
      expect(created.status).toBe(200);
      const res = await app.request('/users/dev_mem@test.com/profile');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toMatchObject({ success: true, stats: { commentsCount: 0, likesReceived: 0 } });
      expect(body.user).not.toHaveProperty('email');
      expect(body.user.externalId).toBe('dev_mem@test.com');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=60');
      const miss = await app.request('/users/dev_ghost@test.com/profile');
      expect(miss.status).toBe(404);
      expect(await miss.json()).toEqual({ success: false, code: 'user_not_found', error: 'user not found' });
    } finally {
      fake().unavailable(false);
      vi.stubGlobal('__WORKER_ENV__', undefined);
      setWorkerEnv(productionBindings);
    }
  });

  it('private /me/profile still works byte-for-byte (regression)', async () => {
    const { token }: any = await (await loginAs('regress-1', 'regress@test.com')).json();
    const res = await app.request('/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.user.email).toBe('regress@test.com');
    expect(body.stats).toMatchObject({ library: 0, history: 0, sessions: 0 });
  });
});
```

- [x] **Step 3: Run the profile test file**

Run:
```bash
npx vitest run src/routes/profile.test.ts
```
Expected: `Test Files  1 passed`, `Tests  15 passed` (7 pre-existing + 8 new). If any new test fails, fix the product/fake code — do NOT weaken the assertion.

- [x] **Step 4: Confirm the email-absence guarantee via serialized grep on a live test response**

Run:
```bash
npx vitest run src/routes/profile.test.ts 2>&1 | tail -8
```
Expected: tail shows `Test Files  1 passed` and `Tests  15 passed` with `Errors  0`-style clean output (no `FAIL`, no `AssertionError`).

---

### Task 7: Full verification — typecheck, whole suite, build

**Files:** none modified (verification only).

- [x] **Step 1: Typecheck the whole repo**

Run:
```bash
npm run typecheck
```
Expected: exits `0` with no error output.

- [x] **Step 2: Run the FULL test suite**

Run:
```bash
npm test
```
Expected: every test file passes, exits `0`. Key output lines: `Test Files  <N> passed` (all files, zero failed), `Tests  <M> passed` (zero failed). If any unrelated suite fails, `git stash` your changes and re-run to prove it is pre-existing; then unstash and report.

- [x] **Step 3: Build**

Run:
```bash
npm run build
```
Expected: exits `0`, `dist/` emitted (check `ls dist/routes/profile.js` exists).

- [x] **Step 4: Static contract audit (grep checks)**

Run:
```bash
grep -n "profileRouter.get" src/routes/profile.ts && grep -n "userPublicProfile\|userProfile" src/app.ts && grep -n "Cache-Control" src/routes/profile.ts && grep -n "findMemoryUser" src/routes/auth.ts src/routes/profile.ts && grep -n "TODO\|TBD\|\.\.\.\|implement X\|placeholder" src/routes/profile.ts src/routes/auth.ts src/app.ts src/test/identityDb.ts src/routes/profile.test.ts; echo "placeholder_grep_exit=$?"
```
Expected:
- two `profileRouter.get` lines with `/me/profile` first,
- both `userProfile` and `userPublicProfile` in `src/app.ts`,
- `Cache-Control` with the exact `public, max-age=60, stale-while-revalidate=60` string in `src/routes/profile.ts`,
- `findMemoryUser` defined in `auth.ts` and imported/used in `profile.ts`,
- final line `placeholder_grep_exit=1` (no placeholders found — grep found nothing).

---

### Task 8: Manual smoke check (dev server + curl) and commit

**Files:** none modified except the git commit.

- [x] **Step 1: Start the dev server and hit the public endpoint without any token**

Run (needs a `DATABASE_URL` for the DB path; without one the server runs in memory mode — either is fine for the smoke check, note which):
```bash
npm run build && (node dist/index.js & echo $! > /tmp/opencode/profilesmoke.pid) && sleep 3 && curl -s http://localhost:4000/api/v1/ | grep -o "userPublicProfile[^,]*" && curl -s http://localhost:4000/api/v1/users/google_nonexistent/profile; echo; kill $(cat /tmp/opencode/profilesmoke.pid)
```
Expected:
- index line prints `userPublicProfile: 'GET /api/v1/users/:id/profile'` (proves Task 5 is live),
- unknown-user body prints exactly `{"success":false,"code":"user_not_found","error":"user not found"}` with HTTP 404 (verify with `-w "%{http_code}"` if in doubt),
- server stops cleanly after `kill` (no orphan process; check `ps aux | grep dist/index` is empty).

Manual DB-path curl examples for the reviewer (run against a dev DB with a known user; replace `<UUID>`):
```bash
# by UUID (comment-tap path) — expect 200, no email key, stats present:
curl -s http://localhost:4000/api/v1/users/<UUID>/profile | head -c 800; echo
# by externalId — expect identical user object:
curl -s http://localhost:4000/api/v1/users/google_<sub>/profile | head -c 800; echo
# cache header — expect exactly: public, max-age=60, stale-while-revalidate=60
curl -si http://localhost:4000/api/v1/users/<UUID>/profile | grep -i "cache-control"
# empty id is not routable via curl (Hono 404 on /users//profile); the 400 invalid_id
# path is covered by the %20 test in Task 6, not by curl.
```

- [x] **Step 2: Final diff review**

Run:
```bash
git status --short && git diff --stat
```
Expected: exactly five modified files — `src/routes/auth.ts`, `src/routes/profile.ts`, `src/app.ts`, `src/test/identityDb.ts`, `src/routes/profile.test.ts`. No changes to `src/database/schema.ts`, `drizzle/*`, `src/routes/comments.ts`, `src/middleware/*`, `wrangler.toml`, `package.json`. If anything else shows up, revert it.

- [x] **Step 3: Commit**

Run:
```bash
git add src/routes/auth.ts src/routes/profile.ts src/app.ts src/test/identityDb.ts src/routes/profile.test.ts && git commit -m "feat: add public GET /api/v1/users/:id/profile with comment stats"
```
Expected: commit created; `git log --oneline -1` shows the message; `git status --short` is clean.

---

## Self-review audit (done by plan author before handoff)

1. **Spec coverage:** every spec section has a task — §1 route/auth/ordering/cache → Task 4 steps 2-3 + Task 6 header test + Task 7 grep; §2 dual resolution/400 rule/no-username → Task 4 step 2 code + Task 6 resolution/400 tests; §3 response shape/PII/aggregate → Task 4 `toPublicSafe` + stats query + Task 6 PII/likes/visibility tests; §4 error codes/shapes/503 pattern → Task 4 catch block + Task 6 error test; §5 memory fallback → Task 2 helper + Task 4 branch + Task 6 memory test; §6 index entry → Task 5. Non-goals (no comments/auth-behavior/schema/rate-limit changes) are pinned in the file map and Task 8 diff check.
2. **Placeholder scan:** Task 7 step 4 greps for `TODO|TBD|\.\.\.|implement X|placeholder` across all touched files and requires exit 1 (no hits). All code blocks above are complete and copy-pasteable; no "similar to" references — the test block repeats full seeding per test.
3. **Type consistency:** names are uniform across tasks — `findMemoryUser(raw: string): any | null`, `toPublicSafe(u: any)`, `UUID_RE`, `A1_UUID/A1_EXTERNAL/A1_EMAIL/B_UUID`, fake API `seedComments(list: FakeCommentSeed[])` + `commentRows`, stats keys `commentsCount`/`likesReceived`, error codes `invalid_id`/`user_not_found`/`account_unavailable`. The fake's aggregate detection keys (`commentsCount`/`likesReceived`) match the product query's select aliases exactly.
4. **Fixes applied during this audit:** (a) specified `%20`-encoded whitespace id for the 400 test instead of an unroutable `//` path; (b) required `Vary` null-assertion on success per spec "no Vary: Authorization"; (c) made the likes test seed a hidden row with `likesCount: 100` to prove the status filter applies to the SUM, not just the COUNT; (d) scoped the memory test's env/unavailable mutation with try/finally restore so later tests keep production bindings; (e) added the `removed-lines` check in Task 4 to prove `/me/profile` is untouched.
