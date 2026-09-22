# Comments Speed + Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the native comments list hot path from ~55 HTTPS round trips to ~5 per page and show the TOTAL comment count on the reader HUD badge for server novels, with no silent contract break.

**Architecture:** Server: one window-function preview query (S1), one merged count query (S3), first-page-only root total on list (S2) with the count endpoint as the source of truth for later pages. App: lazy idle badge count reused by the drawer (A1), idle-prefetch + stale-while-revalidate drawer (A2), abort of stale in-flight lists (A3).

**Tech Stack:** Server: Cloudflare Workers + Hono + Drizzle + Neon Postgres (neon-http: every query = HTTPS round trip, `db.transaction()` UNSUPPORTED — never use it), Vitest, TypeScript. App: Expo React Native, Vitest (`npm test`, 37 files / 382 tests baseline), `npm run typecheck`.

---

## Repos and absolute paths

- Server repo: `/home/x1carbon/Projects/fan-novel-server`
- App repo: `/home/x1carbon/Projects/Fan Novel`
- Server file: `/home/x1carbon/Projects/fan-novel-server/src/routes/comments.ts` (list handler lines ~369-490, count handler lines ~492-519)
- Server tests: `/home/x1carbon/Projects/fan-novel-server/src/routes/comments.test.ts`
- App files:
  - `/home/x1carbon/Projects/Fan Novel/app/reader/[chapterId].tsx` (site badge effect lines ~125-161, badge render lines ~384-402, drawer mount lines ~542-558)
  - `/home/x1carbon/Projects/Fan Novel/src/components/reader/CommentsDrawer.tsx` (native load effect lines ~274-343, `totalCount` lines ~192-217)
  - `/home/x1carbon/Projects/Fan Novel/src/features/comments/nativeApi.ts` (`req` lines ~90-146, `listRoots` 158-178, `count` 202-209)
  - CREATE: `/home/x1carbon/Projects/Fan Novel/src/features/comments/nativeCommentsCache.ts`
  - CREATE: `/home/x1carbon/Projects/Fan Novel/src/features/comments/nativeCommentsCache.test.ts`

## Prior work (do NOT rewrite)

- Prior spec: `/home/x1carbon/Projects/fan-novel-server/docs/superpowers/specs/2026-09-21-novel-comments-design.md`
- Prior plan (done, deployed): `/home/x1carbon/Projects/fan-novel-server/docs/superpowers/plans/2026-09-21-novel-comments.md`
- Known outage lesson: `db.transaction()` throws on neon-http — all writes are sequential `db.` calls. This plan touches READ paths only; no transactions anywhere.

## Locked contract decisions (do not relitigate)

- **S2 decision (locked here): total on first page only.** `GET .../comments` returns the real root `total` when no `cursor` param is present (first page) and `total: null` on subsequent pages. The response field `total` STAYS PRESENT (number|null) so no parser breaks; only the value contract changes. The drawer NEVER shows a wrong number: on `total: null` pages it falls back to (1) the first-page cached total, else (2) the badge count from `GET .../comments/count`, else (3) the running local count. The count endpoint (`{ total, roots }`) stays byte-identical and remains the badge source of truth.
- **Badge shows TOTAL** (user decision): the HUD badge for `internal:published` chapters shows `count.total` (all comments in scope), not roots. Matches the drawer header, which already adds pending extras onto the server total.
- **Preview contract unchanged:** every listed root carries `preview` = oldest ≤2 visible children (ordered by `createdAt ASC, id ASC`); roots with none carry `preview: []`.

## Explicit non-goals (defer with rationale)

- Folding `novelExists` into the main query (extra round trip is 1 of ~5, not worth the join complexity).
- Status covering index / any migration (moderator-only filter, bounded by page size; needs its own spec + runbook).
- Longer anonymous edge-cache (cache headers already correct per prior plan; changing TTL is a product call).
- SELECT-column narrowing (no measured payload problem; `select()` shape change risks serializer drift).
- App edit/delete/report UI (no design approved).
- Server idempotency key (needs cross-cutting spec; manual-repost + duplicate-guard convergence stays).

---

### Task 1 (SERVER): Baseline green

**Goal:** Record a passing baseline before touching code.
**Files:** none (read-only).

- [x] **Step 1: Run server typecheck** (done: exit 0, 2026-09-22)

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npx tsc --noEmit
```
Expected: exit 0, no output.

- [x] **Step 2: Run server comments tests** (done: 11 passed, 2026-09-22)

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npx vitest run src/routes/comments.test.ts
```
Expected: all tests pass. Note the exact passing count for later comparison.

**Done criteria:** Both commands exit 0; count noted.
**Commit:** none (read-only).

---

### Task 2 (SERVER S1): Add preview-skew regression test

**Goal:** Pin the exact observable contract the window query must preserve: a root with MANY children must not starve a later root's preview.
**Files:**
- Modify: `/home/x1carbon/Projects/fan-novel-server/src/routes/comments.test.ts` (append one `it` block; do not alter existing blocks)

- [x] **Step 1: Append this exact test block** (done: 9c258b4) (insert after the existing `'error bodies carry codes; replies total is true; previews capped at 2'` block, before the cache-header test):

```ts
it('preview skew: a root with many children does not starve later roots', async () => {
  const app = openApp();
  const novel = `skew_${Date.now()}`;
  const mk = (body: string) =>
    app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  const r1: any = await (await mk('skew root one')).json();
  const r2: any = await (await mk('skew root two')).json();
  const id1 = Number(String(r1.data.id).replace('app_', ''));
  const id2 = Number(String(r2.data.id).replace('app_', ''));
  const ts = Date.now();
  for (let i = 0; i < 10; i++) {
    await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `skew child ${i} ${ts}`, parentId: id1 }),
    });
  }
  await app.request(`/api/v1/novels/${novel}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: `skew lone ${ts}`, parentId: id2 }),
  });
  const list: any = await (await app.request(`/api/v1/novels/${novel}/comments?limit=10`)).json();
  expect(list.success).toBe(true);
  const got1 = list.data.find((c: any) => c.id === r1.data.id);
  const got2 = list.data.find((c: any) => c.id === r2.data.id);
  expect(got1).toBeDefined();
  expect(got2).toBeDefined();
  // oldest ≤2 visible children each, ordered oldest-first
  expect(got1.preview.length).toBe(2);
  expect(got2.preview.length).toBe(1);
  expect(got2.preview[0].body).toBe(`skew lone ${ts}`);
  const times1 = got1.preview.map((k: any) => new Date(k.createdAt).getTime());
  expect(times1[0]).toBeLessThanOrEqual(times1[1]);
});
```

NOTE: the loop posts exactly 10 replies to root one, plus 1 reply to root
two (2 roots + 11 children total). The 10 children on root one are the skew
load that would starve root two under the old `LIMIT(roots*2+10)`
implementation.

- [x] **Step 2: Run the extended suite** (done: 12 passed, 9c258b4)

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npx vitest run src/routes/comments.test.ts
```
Expected: all tests pass including the new skew block (count = baseline + 1).

**Done criteria:** New skew test passes against the CURRENT per-root implementation (proves it pins the contract, not the implementation).
**Commit:**
```bash
git add src/routes/comments.test.ts
git commit -m "test(comments): pin preview-skew contract (busy root must not starve later roots)"
```

---

### Task 3 (SERVER S1): Replace N per-root preview queries with ONE window-function query

**Goal:** List page goes from (1 novel + 1 roots + 1 count + 1 authors + 1 votes + up-to-50 previews) round trips to (same minus previews, plus 1).
**Files:**
- Modify: `/home/x1carbon/Projects/fan-novel-server/src/routes/comments.ts` lines 463-468

- [x] **Step 1: Apply the exact edit** (done: ef7d78e + row-normalization amendment)

Old string (exact, lines 463-468):
```ts
    // reply preview: per-root bounded fetch (oldest ≤2 visible each; no cross-root starvation)
    const previews = new Map<number, CommentRow[]>();
    if (page.length) {
      const perRoot = await Promise.all(page.map((r) => db.select().from(comments).where(and(eq(comments.rootId, r.id), visibleOnly ? eq(comments.status, 'visible') : sql`true`)).orderBy(asc(comments.createdAt), asc(comments.id)).limit(2)));
      page.forEach((r, idx) => previews.set(r.id, perRoot[idx]));
    }
```

New string:
```ts
    // reply preview: ONE round trip via window function (neon-http: each
    // query = HTTPS). Oldest ≤2 visible children per listed root.
    const previews = new Map<number, CommentRow[]>();
    if (page.length) {
      const ids = page.map((r) => r.id);
      const statusFilter = visibleOnly ? sql`AND c."status" = 'visible'` : sql``;
      const result = await db.execute(sql`
        SELECT c.* FROM (
          SELECT c.*,
            ROW_NUMBER() OVER (PARTITION BY c."root_id" ORDER BY c."created_at" ASC, c."id" ASC) AS rn
          FROM "comments" c
          WHERE c."root_id" IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          ${statusFilter}
        ) c WHERE c.rn <= 2 ORDER BY c."created_at" ASC, c."id" ASC
      `);
      const rows = (result as unknown as { rows?: CommentRow[] }).rows ?? (result as unknown as CommentRow[]);
      for (const r of page) previews.set(r.id, []);
      for (const k of rows as CommentRow[]) {
        const rk = k.rootId as unknown as number;
        // cap at 2 per root even if the DB shape ever drifts
        if ((previews.get(rk) ?? []).length < 2) previews.get(rk)!.push(k);
      }
    }
```

Rules for this edit:
- Keep the `sql` import (already imported line 3). `asc`, `eq`, `and` stay used elsewhere — do NOT remove imports.
- Drizzle column mapping is `rootId -> "root_id"`, `createdAt -> "created_at"`, `status -> "status"`, `id -> "id"`, table `"comments"` (verified against `/home/x1carbon/Projects/fan-novel-server/src/database/schema.ts` lines 186-207). If `tsc` complains about the `result.rows` shape, adjust ONLY the two `rows` extraction lines; do not restructure the SQL.
- Memory fallback (lines ~407-414) is UNCHANGED — it already implements oldest-2 correctly.

> **AMENDMENT 2026-09-22 (applied in ef7d78e):** the `rows`-extraction + loop above is SUPERSEDED. `db.execute()` returns raw driver rows (snake_case keys, no Drizzle camelCase mapping; bigint as string|number; timestamps as strings on neon-http), so `k.rootId` would be `undefined` → TypeError → HTTP 500 on any page with previews (memory-mode tests can't catch this). The committed code normalizes each raw row to `CommentRow` (exact key map, `Number()` for bigint ids, `new Date()` for timestamps) and pushes only when `rk != null && previews.has(rk) && length < 2`. SQL text unchanged.

- [x] **Step 2: Typecheck** (done: exit 0, ef7d78e)

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npx tsc --noEmit
```
Expected: exit 0. (done: exit 0, ef7d78e)

**Done criteria:** `tsc` clean; the `Promise.all(page.map` preview block is gone (`grep -n "perRoot" src/routes/comments.ts` returns nothing); memory branch untouched.
**Commit:**
```bash
git add src/routes/comments.ts
git commit -m "perf(comments): single window-function query for reply previews (ROW_NUMBER PARTITION BY root_id, rn<=2)"
```

---

### Task 4 (SERVER S1): Verify previews unmodified

**Goal:** Prove the window query preserves the exact observable contract.
**Files:** none (verification only).

- [x] **Step 1: Run comments tests UNMODIFIED** (done: 12 passed, no test edits)

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npx vitest run src/routes/comments.test.ts
```
Expected: all pass, including the Task 2 skew test, with zero test-file edits since Task 2.

- [x] **Step 2: Confirm no other test file references previews** (done: only comments.test.ts)

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
grep -rn "preview" --include="*.test.ts" src/ | cut -c1-120
```
Expected: hits only in `src/routes/comments.test.ts` (the skew + capped-at-2 blocks).

**Done criteria:** Tests green unmodified; no hidden preview assertions elsewhere.
**Commit:** none (verification only; if the skew test FAILS here, fix the Task 3 SQL — do not weaken the test — then re-run before committing Task 3's fix as `fixup!` on the Task 3 commit message above).

---

### Task 5 (SERVER S3): Merge count endpoint's two count(*) into ONE

**Goal:** `GET .../comments/count` goes from 2 round trips to 1, byte-identical response.
**Files:**
- Modify: `/home/x1carbon/Projects/fan-novel-server/src/routes/comments.ts` (count DB branch; line numbers below are pre-Task-3 — locate blocks by their exact strings, since Task 3 shifts later lines down)

- [x] **Step 1: Apply the exact edit** (done: b522b7d; note: file-wide count(*) grep = 5 hits incl. pre-existing cooldown/list/replies uses — count DB branch now one select)

Old string (exact, lines 509-511):
```ts
    const [{ n: total }] = await db.select({ n: sql<number>`count(*)::int` }).from(comments).where(base);
    const [{ n: roots }] = await db.select({ n: sql<number>`count(*)::int` }).from(comments)
      .where(and(base, sql`${comments.parentId} IS NULL`));
```

New string:
```ts
    const [{ total, roots }] = await db.select({
      total: sql<number>`count(*)::int`,
      roots: sql<number>`count(*) filter (where ${comments.parentId} is null)::int`,
    }).from(comments).where(base);
```

Then update the response line (exact old, line 513):
```ts
    return c.json({ success: true, data: { total: Number(total ?? 0), roots: Number(roots ?? 0) } });
```
That line is UNCHANGED in text — verify it still reads exactly that (the destructured names now come from the single-row select). No edit needed if it matches; if the variable names differ after your edit, fix them to `total`/`roots` so the response stays byte-identical.

- [x] **Step 2: Typecheck + count-path tests** (done: exit 0, 12 passed, b522b7d)

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npx tsc --noEmit && npx vitest run src/routes/comments.test.ts
```
Expected: exit 0 + all pass.

**Done criteria:** One `select` in the count DB branch (`grep -n "count(\*)" src/routes/comments.ts` shows exactly 2 hits: the merged count line + the replies-true-total line); response shape `{ success: true, data: { total, roots } }` byte-identical; memory branch untouched.
**Commit:**
```bash
git add src/routes/comments.ts
git commit -m "perf(comments): single COUNT(*) FILTER query on count endpoint (byte-identical response)"
```

---

### Task 6 (SERVER S2): First-page-only root total on list endpoint

**Goal:** Eliminate the per-page root `count(*)` (1 round trip on EVERY page) while keeping the field present and the drawer truthful.
**Files:**
- Modify: `/home/x1carbon/Projects/fan-novel-server/src/routes/comments.ts`:
  - (a) memory branch `total: all.length` return (pre-Task-3 line ~421 — before the Task 3 edit point, unaffected)
  - (b) DB branch root `count(*)` (pre-Task-3 line ~451 — before the Task 3 edit point, unaffected)
  - (c) DB branch `total: Number(n ?? page.length)` return (pre-Task-3 line ~484 — AFTER the Task 3 edit point, shifted down by the window-query block; locate by exact string)

- [ ] **Step 1: Edit the DB branch — count only on first page**

Old string (exact, line 451):
```ts
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(comments).where(base);
```

New string:
```ts
    // S2: root total only on the first page (no cursor). Later pages return
    // total: null; clients fall back to the first-page cached total or the
    // count endpoint. Saves 1 HTTPS round trip per scroll page on neon-http.
    let rootTotal: number | null = null;
    if (!cursor) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(comments).where(base);
      rootTotal = Number(n ?? page.length);
    }
```

Old string (exact fragment, line 484):
```ts
    return c.json({ success: true, total: Number(n ?? page.length), data, pagination: { limit, nextCursor, hasMore } });
```

New string:
```ts
    return c.json({ success: true, total: rootTotal, data, pagination: { limit, nextCursor, hasMore } });
```

- [ ] **Step 2: Edit the memory branch identically (same contract in dev/open mode)**

Old string (exact fragment, line 421):
```ts
    return c.json({ success: true, total: all.length, data, pagination: { limit, nextCursor, hasMore: nextCursor !== null } });
```

New string:
```ts
    return c.json({ success: true, total: cursor ? null : all.length, data, pagination: { limit, nextCursor, hasMore: nextCursor !== null } });
```

- [ ] **Step 3: Typecheck + tests**

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npx tsc --noEmit && npx vitest run src/routes/comments.test.ts
```
Expected: exit 0 + pass. NOTE: if any existing test asserts `total` on a cursor page, it will fail — that is EXPECTED here. Do NOT weaken the test to `expect.anything()`; update the assertion to the new contract (`total: null` on cursor pages, real total on first page) and note it in the commit message body as `contract: list total is first-page-only (null on cursor pages)`.

**Done criteria:** First-page list returns numeric `total`; cursor-page list returns `total: null`; count endpoint still returns both numbers; no other response field changed.
**Commit:**
```bash
git add src/routes/comments.ts src/routes/comments.test.ts
git commit -m "perf(comments): list total only on first page (null on cursor pages; use count endpoint)"
```

---

### Task 7 (APP A1): Create shared native comments badge/page cache

**Goal:** One module both the HUD badge and the drawer use, so the count is fetched once per chapter and the drawer can skip its own count fetch when the badge value is fresh.
**Files:**
- Create: `/home/x1carbon/Projects/Fan Novel/src/features/comments/nativeCommentsCache.ts` (full contents below)
- Create: `/home/x1carbon/Projects/Fan Novel/src/features/comments/nativeCommentsCache.test.ts` (full contents below)

- [ ] **Step 1: Create `nativeCommentsCache.ts` with this EXACT content**

```ts
// Shared cache for native comment counts + first pages.
// Pure + dependency-free (vitest-safe under node): the reader HUD badge
// writes it, the CommentsDrawer reads it (and refreshes it on load).
// Identity key: `${novelId}::${chapter ?? 'novel'}` — mirrors the server
// scope rule (omit chapter = novel wall; chapter=N = chapter N wall).

export const NATIVE_BADGE_TTL_MS = 60_000;
export const NATIVE_PAGE_TTL_MS = 60_000;

export interface NativeBadgeEntry {
  total: number;
  roots: number;
  at: number;
  novelId: string;
  chapter: number | undefined;
}

export interface NativePageEntry<T = unknown> {
  page: T;
  at: number;
  novelId: string;
  chapter: number | undefined;
}

const badges = new Map<string, NativeBadgeEntry>();
const pages = new Map<string, NativePageEntry<any>>();

/** Scope key: novel-wall when the chapter is nullish. */
export function scopeKeyFor(chapter: number | null | undefined): string {
  return chapter == null ? 'novel' : `ch:${chapter}`;
}

/** Cache key for a novel+chapter scope. */
export function cacheKeyFor(novelId: string, chapter: number | null | undefined): string {
  return `${novelId}::${scopeKeyFor(chapter)}`;
}

/** Fresh badge entry for this scope, or null when missing/stale. */
export function getFreshBadge(
  novelId: string,
  chapter: number | null | undefined,
  now = Date.now(),
  ttlMs = NATIVE_BADGE_TTL_MS,
): NativeBadgeEntry | null {
  const hit = badges.get(cacheKeyFor(novelId, chapter));
  if (!hit) return null;
  if (now - hit.at > ttlMs) return null;
  return hit;
}

/** Store a badge reading (from the count endpoint: TOTAL + roots). */
export function setBadge(
  novelId: string,
  chapter: number | null | undefined,
  total: number,
  roots: number,
  now = Date.now(),
): NativeBadgeEntry {
  const entry: NativeBadgeEntry = { total, roots, at: now, novelId, chapter: chapter ?? undefined };
  badges.set(cacheKeyFor(novelId, chapter), entry);
  return entry;
}

/** Fresh first-page entry for this scope, or null when missing/stale. */
export function getFreshPage<T>(
  novelId: string,
  chapter: number | null | undefined,
  now = Date.now(),
  ttlMs = NATIVE_PAGE_TTL_MS,
): NativePageEntry<T> | null {
  const hit = pages.get(cacheKeyFor(novelId, chapter));
  if (!hit) return null;
  if (now - hit.at > ttlMs) return null;
  return hit as NativePageEntry<T>;
}

/** Store a first-page list result for instant drawer open (SWR seed). */
export function setPage<T>(
  novelId: string,
  chapter: number | null | undefined,
  page: T,
  now = Date.now(),
): void {
  pages.set(cacheKeyFor(novelId, chapter), {
    page,
    at: now,
    novelId,
    chapter: chapter ?? undefined,
  });
}

/** Test/hook helper: clear all entries. */
export function clearNativeCommentsCache(): void {
  badges.clear();
  pages.clear();
}
```

- [ ] **Step 2: Create `nativeCommentsCache.test.ts` with this EXACT content**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cacheKeyFor,
  clearNativeCommentsCache,
  getFreshBadge,
  getFreshPage,
  scopeKeyFor,
  setBadge,
  setPage,
  NATIVE_BADGE_TTL_MS,
} from './nativeCommentsCache';

beforeEach(() => {
  clearNativeCommentsCache();
});

describe('nativeCommentsCache', () => {
  it('scopes novel-wall vs chapter walls separately', () => {
    expect(scopeKeyFor(null)).toBe('novel');
    expect(scopeKeyFor(undefined)).toBe('novel');
    expect(scopeKeyFor(72)).toBe('ch:72');
    expect(cacheKeyFor('n1', null)).not.toBe(cacheKeyFor('n1', 72));
  });
  it('badge read/write round-trips while fresh, expires after TTL', () => {
    const t0 = 1_000_000;
    setBadge('n1', 72, 42, 7, t0);
    expect(getFreshBadge('n1', 72, t0)?.total).toBe(42);
    expect(getFreshBadge('n1', 72, t0 + NATIVE_BADGE_TTL_MS)?.total).toBe(42);
    expect(getFreshBadge('n1', 72, t0 + NATIVE_BADGE_TTL_MS + 1)).toBeNull();
    // wrong scope misses
    expect(getFreshBadge('n1', 5, t0)).toBeNull();
    expect(getFreshBadge('n1', null, t0)).toBeNull();
  });
  it('page seed round-trips while fresh, expires after TTL', () => {
    const t0 = 2_000_000;
    const page = { total: 3, data: [{ id: 'app_1' }] };
    setPage('n1', 72, page, t0);
    expect(getFreshPage('n1', 72, t0)?.page).toEqual(page);
    expect(getFreshPage('n1', 72, t0 + 60_001)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the new app tests**

Run (in `/home/x1carbon/Projects/Fan Novel`):
```bash
npx vitest run src/features/comments/nativeCommentsCache.test.ts
```
Expected: `Test Files  1 passed`, 3 tests passed.

**Done criteria:** New module + tests green; no other app file touched yet.
**Commit (in `/home/x1carbon/Projects/Fan Novel`):**
```bash
git add src/features/comments/nativeCommentsCache.ts src/features/comments/nativeCommentsCache.test.ts
git commit -m "feat(app): shared native comments badge/page cache (HUD + drawer, 60s TTL)"
```

---

### Task 8 (APP A1): HUD badge shows native TOTAL for internal:published chapters

**Goal:** Server novels render the TOTAL count on the HUD badge (user decision), fetched lazily at idle exactly like the site count, icon-only on failure.
**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/app/reader/[chapterId].tsx`

- [ ] **Step 1: Add the native badge effect + state (mirrors the site-count pattern)**

Old string (exact, lines 129-131):
```tsx
  const [siteCommentCount, setSiteCommentCount] = useState<number | null>(null);
  useEffect(() => {
    setSiteCommentCount(null);
```

This is the START of the site-count effect (lines 129-161). Do NOT modify that effect. AFTER its closing (`}, [loading, src, chapterUrl]);` line 161), insert this new block verbatim:

```tsx
  // Native comment TOTAL badge (server novels only): lazy, after the
  // chapter is on screen, same idle pattern as the site count above.
  // Shows count.total (TOTAL, per product decision), icon-only on failure.
  // Writes the shared cache so the drawer can skip its own count fetch.
  const [nativeCommentCount, setNativeCommentCount] = useState<number | null>(null);
  useEffect(() => {
    setNativeCommentCount(null);
    if (loading || src !== 'internal:published' || !commentsNovelId) return;
    const chapterNum =
      chapter?.chapterNumber ?? hudChapter?.chapterNumber ?? null;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      void (async () => {
        try {
          const { nativeCommentsApi } = await import('../../src/features/comments/nativeApi');
          const { setBadge, getFreshBadge } = await import('../../src/features/comments/nativeCommentsCache');
          const fresh = getFreshBadge(commentsNovelId, chapterNum);
          if (!cancelled && fresh) {
            setNativeCommentCount(fresh.total);
            return;
          }
          const c = await nativeCommentsApi.count(
            commentsNovelId,
            chapterNum ?? undefined,
          );
          if (cancelled) return;
          setBadge(commentsNovelId, chapterNum, c.total, c.roots);
          setNativeCommentCount(c.total);
        } catch {
          /* badge stays icon-only */
        }
      })();
    };
    let idleId: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
      idleId = (globalThis as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => unknown }).requestIdleCallback(run, { timeout: 2000 });
    } else {
      timer = setTimeout(run, 600);
    }
    return () => {
      cancelled = true;
      if (typeof (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback === 'function' && idleId !== undefined) {
        (globalThis as { cancelIdleCallback: (id: unknown) => void }).cancelIdleCallback(idleId);
      }
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [loading, src, commentsNovelId, chapter?.chapterNumber, hudChapter?.chapterNumber]);
```

Placement + dependency notes (follow exactly):
- Insert AFTER line 161 (`}, [loading, src, chapterUrl]);`) and BEFORE line 163 comment. The new effect reads `commentsNovelId`, `chapter`, `hudChapter` — all defined above line 125, so no TDZ issue. `chapter`/`hudChapter` come from `session` (lines 71-84); depend on their `.chapterNumber` scalars (not the objects) to avoid refetch loops.
- Dynamic `import()` (not top-level) because `nativeApi` lazily pulls `services/api` + auth store, which cannot be parsed in the node test env.
- `chapterNum ?? undefined`: the count endpoint omits `chapter` for the novel wall (server default), matching list/count scope rule.

- [ ] **Step 2: Render the native count in the badge (site novels unchanged)**

Old string (exact, lines 391-401):
```tsx
            <View style={[styles.hudBadge, { borderColor: colors.hudText }]}>
              <MessageCircle size={13} color={colors.hudText} />
              {siteCommentCount !== null && (
                <Text
                  style={[styles.hudBadgeText, { color: colors.hudText }]}
                  numberOfLines={1}
                >
                  {siteCommentCount}
                </Text>
              )}
            </View>
```

New string:
```tsx
            <View style={[styles.hudBadge, { borderColor: colors.hudText }]}>
              <MessageCircle size={13} color={colors.hudText} />
              {(siteCommentCount ?? nativeCommentCount) !== null && (
                <Text
                  style={[styles.hudBadgeText, { color: colors.hudText }]}
                  numberOfLines={1}
                >
                  {(siteCommentCount ?? nativeCommentCount) as number}
                </Text>
              )}
            </View>
```

Why `??` is safe here: site mode and native mode are mutually exclusive (a source either exposes `getComments` or is `internal:published`, never both — CommentsDrawer lines 147-151). One of them is always null, so `??` selects the live one and stays icon-only when both are null.

- [ ] **Step 3: App typecheck**

Run (in `/home/x1carbon/Projects/Fan Novel`):
```bash
npm run typecheck
```
Expected: exit 0.

**Done criteria:** Server-novel chapters show TOTAL after idle; failure/loading stays icon-only; site novels pixel-identical; `tsc` clean.
**Commit (in `/home/x1carbon/Projects/Fan Novel`):**
```bash
git add app/reader/[chapterId].tsx
git commit -m "feat(app): HUD badge shows native TOTAL count for server novels (lazy idle, icon-only on failure)"
```

---

### Task 9 (APP A1): Drawer reuses fresh badge count (skips its own count fetch)

**Goal:** Opening the drawer within 60s of the badge fetch costs ONE list query (no duplicate count query); the drawer header still shows TOTAL.
**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/src/components/reader/CommentsDrawer.tsx` (native load effect, lines 278-343)

- [ ] **Step 1: Apply the exact edit to the native load effect**

Old string (exact, lines 281-291):
```tsx
      const chapter = chapterNumber ?? undefined;
      let cancelled = false;
      setNativeLoading(true);
      setThreads([]);
      setNativeCount(null);
      // chapterKeyFor(null) === 'novel': novel-wall scope, matching the
      // list/count default (chapter: undefined) used below.
      const scopeKey = chapterKeyFor(chapterNumber ?? null);
      Promise.all([
        nativeCommentsApi.listRoots(novelId, { chapter }),
        nativeCommentsApi.count(novelId, chapter),
      ])
```

Single FINAL replacement — implement exactly this (the effect callback stays
synchronous; the body runs in an inner async IIFE because `await` at effect
top level is illegal):

```tsx
      const chapter = chapterNumber ?? undefined;
      let cancelled = false;
      setNativeLoading(true);
      // chapterKeyFor(null) === 'novel': novel-wall scope, matching the
      // list/count default (chapter: undefined) used below.
      const scopeKey = chapterKeyFor(chapterNumber ?? null);
      // A1 reuse: the HUD badge already fetched TOTAL at idle (Task 8). When
      // fresh (<60s, same novel+chapter), seed the header instantly and skip
      // the count round trip. Dynamic import keeps this file vitest-safe.
      void (async () => {
        let seeded: number | null = null;
        try {
          const mod = await import('../../features/comments/nativeCommentsCache');
          seeded = mod.getFreshBadge(novelId, chapterNumber ?? null)?.total ?? null;
        } catch {
          seeded = null;
        }
        if (cancelled) return;
        // Always reset threads on open (stale chapter data must never show);
        // the Task-10 page seed below re-fills instantly when cached.
        setThreads([]);
        if (seeded !== null) setNativeCount(seeded);
        else setNativeCount(null);
        const countPromise: Promise<{ total: number; roots: number } | null> =
          seeded !== null ? Promise.resolve(null) : nativeCommentsApi.count(novelId, chapter);
        try {
          const [page, c] = await Promise.all([
            nativeCommentsApi.listRoots(novelId, { chapter }),
            countPromise,
          ]);
          if (cancelled) return;
          let roots = nativePageToTree(page.data);
          try {
            const pendings = loadNativePending(novelId, scopeKey);
            if (pendings.length > 0) {
              const m = mergeNativeWithPending(roots, pendings);
              roots = m.roots;
              for (const a of m.approved) {
                try {
                  deleteNativePending(novelId, scopeKey, a.localId);
                } catch {
                  /* best-effort */
                }
              }
            }
          } catch {
            /* pending store is best-effort; server tree still shows */
          }
          setThreads(roots);
          if (c) {
            setNativeCount(c.total);
            try {
              const mod = await import('../../features/comments/nativeCommentsCache');
              mod.setBadge(novelId, chapterNumber ?? null, c.total, c.roots);
            } catch {
              /* cache is best-effort */
            }
          } else if (page.total !== null && page.total !== undefined) {
            // S2: first-page list carries the root total — adopt it.
            setNativeCount(page.total);
          }
          // else: seeded value already showing; keep it.
        } catch (e) {
          if (cancelled) return;
          console.warn('[native-comments] load failed', {
            novelId,
            chapter: chapter ?? null,
            status: (e as { status?: number })?.status ?? 0,
          });
          M3Toast.info(t(nativeErrorKey((e as { status?: number })?.status)));
        } finally {
          if (!cancelled) setNativeLoading(false);
        }
      })();
```

This REPLACES lines 281-328: delete EVERYTHING from `const chapter = ...` through
the end of the `.finally(...)` closing (the full
`Promise.all([listRoots, count]).then(merge-pendings/setThreads/setNativeCount).catch(warn+toast).finally(setNativeLoading)`
chain, just before `const iv = setInterval`), and put the new block in its
place. The 60s count re-poll interval (lines 329-338) and cleanup (`cancelled = true; clearInterval(iv);`) STAY EXACTLY AS-IS. The pending-merge block is preserved verbatim inside the IIFE. The `totalCount` memo (lines 192-217) is UNCHANGED — `nativeCount` seeded from the badge flows through the same path.

- [ ] **Step 2: Update `NativePage` for nullable S2 total**

In `/home/x1carbon/Projects/Fan Novel/src/features/comments/nativeApi.ts`, old string (exact, lines 75-80):
```ts
export interface NativePage {
  total: number;
  data: NativeComment[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

New string:
```ts
export interface NativePage {
  /** Root total on first pages; null on cursor pages (S2: use badge/count). */
  total: number | null;
  data: NativeComment[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

And `listRoots` return mapping (exact, lines 172-177):
```ts
    return {
      total: json.total ?? 0,
      data: json.data ?? [],
      nextCursor: json.pagination?.nextCursor ?? null,
      hasMore: json.pagination?.hasMore ?? false,
    };
```

New string:
```ts
    return {
      total: json.total ?? null,
      data: json.data ?? [],
      nextCursor: json.pagination?.nextCursor ?? null,
      hasMore: json.pagination?.hasMore ?? false,
    };
```

Check every other consumer of `page.total` / `NativePage.total` for type errors: `grep -rn "\.total" src/features/comments/ src/components/reader/CommentsDrawer.tsx`. Known consumers: drawer `setNativeCount(page.total)` (now guarded by null check in Step 1), `nativeThreadToNodes` (no total), `CommentsList siteTotal` (site-only, untouched). Fix any `tsc` complaint by null-guarding at the use site — never by coercing `?? 0` at the boundary (that would reintroduce a wrong zero on cursor pages).

- [ ] **Step 3: App typecheck**

Run (in `/home/x1carbon/Projects/Fan Novel`):
```bash
npm run typecheck
```
Expected: exit 0.

**Done criteria:** Drawer opens with badge-fresh TOTAL instantly (no count fetch); cold open fetches list+count in parallel as before and writes the cache; cursor pages never zero the header; `tsc` clean.
**Commit (in `/home/x1carbon/Projects/Fan Novel`):**
```bash
git add src/components/reader/CommentsDrawer.tsx src/features/comments/nativeApi.ts
git commit -m "feat(app): drawer reuses fresh HUD badge count; nullable list total (S2 contract)"
```

---

### Task 10 (APP A2): Idle-prefetch first comments page + stale-while-revalidate drawer

**Goal:** After chapter load, the first native comments page is prefetched at idle; opening the drawer renders cached threads instantly, then refreshes in the background.
**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/app/reader/[chapterId].tsx` (add prefetch to the Task 8 effect's `run`)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/components/reader/CommentsDrawer.tsx` (seed from page cache on open)

- [ ] **Step 1: Extend the Task 8 `run` to also prefetch the first page**

In the Task 8 `run` closure (the `void (async () => {...})()` inside `[chapterId].tsx`), AFTER the `setBadge(...)` / `setNativeCommentCount(c.total)` lines, append:

```tsx
          // A2: idle-prefetch the first roots page so drawer open is instant.
          try {
            const { setPage, getFreshPage } = await import('../../src/features/comments/nativeCommentsCache');
            if (!getFreshPage(commentsNovelId, chapterNum)) {
              const first = await nativeCommentsApi.listRoots(commentsNovelId, {
                chapter: chapterNum ?? undefined,
                limit: 20,
              });
              if (!cancelled) setPage(commentsNovelId, chapterNum, first);
            }
          } catch {
            /* prefetch is best-effort; drawer loads on open */
          }
```

Notes: `nativeCommentsApi` is already dynamically imported in that closure — reuse the binding, do not import twice. `cancelled` is in scope. Limit 20 matches the drawer's default page size. On failure the drawer falls back to its normal open-load (no user-visible change).

- [ ] **Step 2: Drawer seeds threads from the page cache, then refreshes (SWR)**

Replace the WHOLE IIFE opening through the reset block from Task 9 (exact old —
must match the Task 9 result verbatim, including the reset comment):

```tsx
      void (async () => {
        let seeded: number | null = null;
        try {
          const mod = await import('../../features/comments/nativeCommentsCache');
          seeded = mod.getFreshBadge(novelId, chapterNumber ?? null)?.total ?? null;
        } catch {
          seeded = null;
        }
        if (cancelled) return;
        // Always reset threads on open (stale chapter data must never show);
        // the Task-10 page seed below re-fills instantly when cached.
        setThreads([]);
        if (seeded !== null) setNativeCount(seeded);
        else setNativeCount(null);
```

New (badge seed + page seed integrated; the clear happens BEFORE the seed
fill so the stale page is never wiped after rendering):

```tsx
      void (async () => {
        let seeded: number | null = null;
        let seedThreads: CommentNode[] | null = null;
        try {
          const mod = await import('../../features/comments/nativeCommentsCache');
          seeded = mod.getFreshBadge(novelId, chapterNumber ?? null)?.total ?? null;
          const cached = mod.getFreshPage<import('../../features/comments/nativeApi').NativePage>(
            novelId,
            chapterNumber ?? null,
          );
          if (cached && Array.isArray(cached.page?.data)) {
            // nativePageToTree is already statically imported at the top of
            // this file (lines 64-68) — reuse it, no new import.
            seedThreads = nativePageToTree(cached.page.data);
          }
        } catch {
          seeded = null;
          seedThreads = null;
        }
        if (cancelled) return;
        // Always reset first (stale chapter data must never show), then
        // re-fill from the stale page instantly when cached.
        setThreads([]);
        if (seeded !== null) setNativeCount(seeded);
        else setNativeCount(null);
        // SWR: render the stale page instantly (no spinner flash), then the
        // network load below replaces it. Pending-merge still runs on the
        // fresh load, so optimistic nodes are never clobbered by the seed:
        // the seed is server data only, pendings attach on refresh.
        if (seedThreads && seedThreads.length > 0) {
          setThreads(seedThreads);
          setNativeLoading(false);
        }
```

(`CommentNode` is already statically imported at the top of this file, line
36-39. `cached.page?.data` — `getFreshPage<T>` returns `NativePageEntry<T> |
null`; the optional chain keeps `tsc` happy when the entry is absent.)

Then, after the fresh load commits (`setThreads(roots);` inside the try), write
the fresh page back to the cache. Old (exact, from Task 9):
```tsx
          setThreads(roots);
          if (c) {
```

New:
```tsx
          setThreads(roots);
          try {
            const mod = await import('../../features/comments/nativeCommentsCache');
            mod.setPage(novelId, chapterNumber ?? null, page);
          } catch {
            /* cache is best-effort */
          }
          if (c) {
```

(`page` is the `NativePage` from `listRoots` — in scope in the IIFE's try
block. Reuse the existing dynamic-import style for the cache module; the
tree helper stays on its static import.)

- [ ] **Step 3: App typecheck + tests**

Run (in `/home/x1carbon/Projects/Fan Novel`):
```bash
npm run typecheck && npm test
```
Expected: exit 0; all suites pass (382 baseline + 3 new cache tests = 385).

**Done criteria:** Cold chapter load prefetches badge+page at idle; drawer opens instantly on cached threads with background refresh; failures degrade to current behavior; `tsc` + tests green.
**Commit (in `/home/x1carbon/Projects/Fan Novel`):**
```bash
git add app/reader/[chapterId].tsx src/components/reader/CommentsDrawer.tsx
git commit -m "feat(app): idle-prefetch first comments page; drawer opens stale-instant + background refresh"
```

---

### Task 11 (APP A3): Abort stale in-flight list requests on drawer reopen/refresh

**Goal:** Rapid drawer reopen/refresh never resolves out of order (older slower response clobbering newer threads).
**Files:**
- Modify: `/home/x1carbon/Projects/Fan Novel/src/features/comments/nativeApi.ts` (`req`, `listRoots`, `count`)
- Modify: `/home/x1carbon/Projects/Fan Novel/src/components/reader/CommentsDrawer.tsx` (effect cleanup aborts)

- [ ] **Step 1: Thread an optional AbortSignal through `req`/`listRoots`/`count`**

In `nativeApi.ts`, old (exact, lines 90-94):
```ts
async function req(
  path: string,
  init?: RequestInit,
  opts?: { allowAnonymous?: boolean; timeoutMs?: number },
): Promise<any> {
```

New:
```ts
async function req(
  path: string,
  init?: RequestInit,
  opts?: { allowAnonymous?: boolean; timeoutMs?: number; signal?: AbortSignal },
): Promise<any> {
```

Old (exact, lines 109-121):
```ts
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 15000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
```

New:
```ts
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 15000);
  if (opts?.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
```

Old (exact, lines 158-160):
```ts
  async listRoots(
    novelId: string,
    opts: { chapter?: number; cursor?: string; limit?: number; sort?: NativeSort } = {},
  ): Promise<NativePage> {
```

New:
```ts
  async listRoots(
    novelId: string,
    opts: { chapter?: number; cursor?: string; limit?: number; sort?: NativeSort; signal?: AbortSignal } = {},
  ): Promise<NativePage> {
```

Old (exact, lines 162-171):
```ts
    const json = await req(
      `/api/v1/novels/${encodeURIComponent(novelId)}/comments${qs({
        chapter: opts.chapter,
        cursor: opts.cursor,
        limit: opts.limit ?? 20,
        sort: opts.sort ?? 'new',
      })}`,
      undefined,
      { allowAnonymous: true },
    );
```

New:
```ts
    const json = await req(
      `/api/v1/novels/${encodeURIComponent(novelId)}/comments${qs({
        chapter: opts.chapter,
        cursor: opts.cursor,
        limit: opts.limit ?? 20,
        sort: opts.sort ?? 'new',
      })}`,
      undefined,
      { allowAnonymous: true, signal: opts.signal },
    );
```

Old (exact, line 202):
```ts
  async count(novelId: string, chapter?: number): Promise<{ total: number; roots: number }> {
```

New:
```ts
  async count(
    novelId: string,
    chapter?: number,
    signal?: AbortSignal,
  ): Promise<{ total: number; roots: number }> {
```

Old (exact, lines 203-206):
```ts
    const json = await req(
      `/api/v1/novels/${encodeURIComponent(novelId)}/comments/count${qs({ chapter })}`,
      undefined,
      { allowAnonymous: true },
    );
```

New:
```ts
    const json = await req(
      `/api/v1/novels/${encodeURIComponent(novelId)}/comments/count${qs({ chapter })}`,
      undefined,
      { allowAnonymous: true, signal },
    );
```

Abort-error mapping: `req`'s catch maps aborts via `transportCode(e)` (already handles `AbortError` as timeout/network — verify by reading `nativeErrors.ts` `transportCode`; if it does NOT special-case abort names, add NO new mapping — the drawer's catch already treats unknown codes with the generic toast, and the `cancelled` flag suppresses all handling. Do not invent a new error code.)

- [ ] **Step 2: Drawer aborts in-flight load on effect cleanup**

In `CommentsDrawer.tsx` native effect: add a ref at component top-level (next to `loadingMoreId`, line 154). Old (exact, line 154):
```tsx
    const [loadingMoreId, setLoadingMoreId] = useState<string | null>(null);
```

New:
```tsx
    const [loadingMoreId, setLoadingMoreId] = useState<string | null>(null);
    // A3: aborts the in-flight native list/count when the drawer reopens,
    // chapter changes, or the effect cleans up — stale responses can never
    // clobber newer threads (plus the `cancelled` flag as second guard).
    const nativeLoadAbortRef = useRef<AbortController | null>(null);
```

In the native load effect body (Task 9/10 IIFE version), immediately AFTER the
`if (!isOpen || !isNativeMode || !novelId) return;` guard and BEFORE the
`const chapter = ...` line, insert (exact new lines):

```tsx
      nativeLoadAbortRef.current?.abort();
      const aborter = new AbortController();
      nativeLoadAbortRef.current = aborter;
      const loadSignal = aborter.signal;
```

Pass `loadSignal` into both calls inside the IIFE:
- `nativeCommentsApi.listRoots(novelId, { chapter })` → `nativeCommentsApi.listRoots(novelId, { chapter, signal: loadSignal })`
- `nativeCommentsApi.count(novelId, chapter)` → `nativeCommentsApi.count(novelId, chapter, loadSignal)`

And in the effect cleanup (exact old, lines 339-342):
```tsx
      return () => {
        cancelled = true;
        clearInterval(iv);
      };
```

New:
```tsx
      return () => {
        cancelled = true;
        aborter.abort();
        if (nativeLoadAbortRef.current === aborter) nativeLoadAbortRef.current = null;
        clearInterval(iv);
      };
```

The abort fires a rejection inside the IIFE's try → caught by the existing catch → `if (cancelled) return` suppresses toast/warn. No new error UI. The 60s count poll is NOT aborted (it has its own lifecycle); only the open-load is.

- [ ] **Step 3: App typecheck + tests**

Run (in `/home/x1carbon/Projects/Fan Novel`):
```bash
npm run typecheck && npx vitest run src/features/comments/
```
Expected: exit 0; all comment suites pass.

**Done criteria:** Reopening the drawer mid-load aborts the old request; no toast on abort; no out-of-order thread clobber; `tsc` clean.
**Commit (in `/home/x1carbon/Projects/Fan Novel`):**
```bash
git add src/features/comments/nativeApi.ts src/components/reader/CommentsDrawer.tsx
git commit -m "fix(app): abort stale native comments list/count on drawer reopen"
```

---

### Task 12: Final regression — BOTH repos green (no deploy)

**Goal:** Prove nothing broke end-to-end. No deploy step — the coordinator deploys separately.
**Files:** none (verification only).

- [ ] **Step 1: Server full gates**

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npm test
```
Expected: all test files pass, zero failures.

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
npm run typecheck && npm run build
```
Expected: both exit 0, `dist/` emitted.

- [ ] **Step 2: App full gates**

Run (in `/home/x1carbon/Projects/Fan Novel`):
```bash
npm test
```
Expected: all suites pass — 37 files baseline + `nativeCommentsCache.test.ts` = 38 files, 382 + 3 = 385 tests, zero failures.

Run (in `/home/x1carbon/Projects/Fan Novel`):
```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 3: Contract grep audit (server)**

Run (in `/home/x1carbon/Projects/fan-novel-server`):
```bash
grep -n "Promise.all(page.map" src/routes/comments.ts; grep -n "count(\*)" src/routes/comments.ts; grep -n "total:" src/routes/comments.ts | head
```
Expected:
- First grep returns nothing (N+1 previews gone).
- Second grep shows exactly 2 hits: merged count-FILTER line + replies true-total line (list root count(*) gone from per-page path — it now lives inside the `if (!cursor)` block; confirm by reading the surrounding lines).
- Third grep shows `total: rootTotal` (list), `total: cursor ? null : all.length` (memory), `{ total, roots }` (count, unchanged), replies total (unchanged).

**Done criteria:** `npm test`, `npm run typecheck` (both repos) and server `npm run build` all exit 0; grep audit matches expectations.
**Commit:** none (verification only).

---

## Audit fixes applied during self-review

(Recorded by the plan author before handoff.)

1. **Task 9 rewrite-in-place:** the first draft contained three superseded iterations (parallel-promise version, `.then`-patch version, and two meta notes) plus an illegal top-level `await` in a sync effect. Deleted all drafts; the task now specifies ONE final sync-effect + inner-IIFE replacement with exact old/new strings.
2. **Task 9/10 thread-reset contradiction:** Task 9's seeded path skipped `setThreads([])`, which would have shown stale-chapter threads; Task 10's page seed would then have been wiped by a later clear. Fixed: Task 9 always resets threads on open; Task 10 integrates the page seed AFTER the reset in a single replacement block whose old string matches Task 9 verbatim.
3. **Task 10 hedge removal:** the seed step dynamically imported `nativeToTree` with an `either is correct` hedge. Replaced with the file's existing static `nativePageToTree` import (lines 64-68) — one correct path, no implementer choice.
4. **Task 8 typo:** stray `+` prefix on the `/* badge stays icon-only */` line removed.
5. **Task 2 test cleanup:** removed the redundant root-post call inside the skew loop (it created 10 noise roots and confused the test's intent); the loop now posts exactly 10 replies to root one + 1 to root two, with a corrected explanatory NOTE.
6. **Tasks 5/6 line-number drift:** Task 3's window-query block shifts all later server line numbers down; Tasks 5 and 6 now state which references are pre-Task-3 and instruct locating blocks by exact strings.
7. **Task 11 insertion-point ambiguity:** clarified the abort-controller setup goes immediately after the effect's early-return guard (not at file top), and repaired a duplicated instruction sentence introduced during the Task 9 cleanup.
8. **S2 contract coordination verified:** server `total: null` on cursor pages is matched on the app side (nullable `NativePage.total`, `?? null` boundary mapping, null-guarded drawer fallbacks: first-page total → badge seed → keep prior). No `?? 0` coercion anywhere on the cursor path, so the header can never show a wrong zero.
9. **Verification commands checked per repo:** server `npx tsc --noEmit` / `npx vitest run <file>` / `npm test` / `npm run build`; app `npm run typecheck` / `npm test` / `npx vitest run <file>` — all match the `scripts` blocks in both `package.json` files. No deploy step included (coordinator deploys separately).
