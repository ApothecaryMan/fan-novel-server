# Novel Comments Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the server-side novel comments system (chapter inheritance, error-code taxonomy, `app_` id acceptance, unified author batch, transactional counters, guaranteed reply previews, true reply totals, cache-header fix, single caller lookup, Workers-safe cursors) without changing the `success/error` shape or any out-of-scope system.

**Architecture:** All functional edits land in `src/routes/comments.ts` plus two one-line-shape edits in `src/middleware/rateLimit.ts` and `src/middleware/ownership.ts`; verification is Vitest memory-mode API tests plus a new pure-helper unit suite, finished by `typecheck + test + build` green.

**Tech Stack:** Cloudflare Workers + Hono + Drizzle + Neon Postgres, Vitest (`app.request` in open/memory mode), TypeScript.

---

## File map (only files touched)

- Modify: `src/routes/comments.ts` (~949 lines) — all endpoint/guard/helper changes.
- Modify: `src/middleware/rateLimit.ts` — coded 429 body on comments paths only.
- Modify: `src/middleware/ownership.ts` — `getCaller` context-cache short-circuit.
- Extend: `src/routes/comments.test.ts` — memory-mode API coverage additions.
- Create: `src/routes/comments.unit.test.ts` — pure-helper suite (`parseCommentId`, cursor codec, inheritance resolver, code-table completeness).
- No edits: `src/database/schema.ts`, `drizzle/*`, `src/routes/auth.ts`, `src/routes/googleAccount.ts`, `src/routes/upload.ts`, `src/app.ts`, `src/worker.ts`, `wrangler.toml`, app repo. No new dependencies. No migration file.

## Preview-fetch decision (locked here, spec §8 left it to the plan)

**Chosen: N bounded per-root queries executed concurrently with `Promise.all`, each `LIMIT 2`, page cap 50.**
Rationale: each query is a tiny bounded index scan on the existing `comments_thread` index (`rootId` ordering by `createdAt, id`); worst case is 50 concurrent `LIMIT 2` lookups per list page. The single window-function alternative (`ROW_NUMBER() OVER (PARTITION BY rootId ORDER BY createdAt, id)`) saves round-trips but requires a raw-SQL fragment that Drizzle/Neon-serverless expresses awkwardly, is harder to mirror in the memory fallback, and buys nothing measurable at page ≤ 50. Correctness contract is identical either way: every listed root carries `preview` = oldest ≤ 2 visible children; roots with none carry `preview: []`. A future perf pass may swap in the window query without changing observable behavior or tests.

## Error-code table (exact values, implement verbatim)

| code | HTTP | Arabic `error` (unchanged) | where |
|---|---|---|---|
| `invalid_payload` | 400 | `حقول غير صالحة` (+`issues`) | POST/PATCH/vote/mod zod failures |
| `invalid_query` | 400 | `استعلام غير صالح` (+`issues`) | list query zod failure |
| `invalid_id` | 400 | `معرف غير صالح` | every `:id`/`:commentId` after `parseCommentId` |
| `invalid_cursor` | 400 | `مؤشر ترقيم غير صالح` | list + replies cursor decode |
| `chapter_mismatch` | 400 | `النطاق غير متطابق` | explicit reply chapter ≠ parent chapter |
| `parent_wrong_novel` | 400 | `التعليق الأب من رواية أخرى` | reply parent novel mismatch |
| `depth_limit` | 400 | `تم بلوغ أقصى عمق للردود` | depth ≥ MAX_DEPTH |
| `vote_login` | 401 | `سجل الدخول للتصويت` | vote as `local-dev` |
| `unauthorized` | 401 | `غير مصرح: مطلوب تسجيل الدخول` | all other auth failures |
| `forbidden` | 403 | `غير مسموح` | all current `غير مسموح` branches |
| `edit_window` | 403 | `انتهت مهلة التعديل` | PATCH past window |
| `edit_limit` | 403 | `تم بلوغ حد التعديلات` | PATCH past MAX_EDITS |
| `self_vote` | 403 | `لا يمكن التصويت على تعليقك` | vote own comment |
| `novel_not_found` | 404 | `الرواية غير موجودة` | novel missing (both modes) |
| `chapter_not_found` | 404 | `الفصل غير موجود` | explicit chapter missing |
| `parent_not_found` | 404 | `التعليق الأب غير موجود` | reply parent missing |
| `comment_not_found` | 404 | `التعليق غير موجود` | item/replies/admin miss |
| `reply_forbidden` | 409 | `لا يمكن الرد على تعليق محجوب` | parent not visible |
| `deleted` | 409 | `التعليق محذوف` | mod action on deleted |
| `duplicate` | 409 | `تعليق مكرر` | bodyHash guard |
| `cooldown` | 429 | `مهلاً — انتظر قليلاً قبل التعليق التالي` (+numeric `retryAfter`) | cooldown + daily-cap branches |
| `rate_limited` | 429 | `too many requests` | `rateLimit` middleware path |

Note: the vote-schema failure message `قيمة غير صالحة` (comments.ts line 771) is a payload validation failure and maps to `invalid_payload` with its `issues` array kept. The admin-queue `حالة غير صالحة` and count `رقم الفصل غير صالح` are query-validation failures and map to `invalid_query`. The 500-branch messages (`تعذر تحميل التعليقات`, `تعذر الإضافة`, etc.) keep their current Arabic strings and gain no stable code (they are unclassified server faults, not part of the taxonomy).

## Cache-header rule (exact strings)

- Authenticated list (any caller row present, visible-only): `Cache-Control: private, max-age=30` + `Vary: Authorization`.
- Moderator filtered list (`status` param honored): `Cache-Control: no-store` + `Vary: Authorization`.
- Anonymous visible-only list and `count` (both modes, no per-user data): `Cache-Control: public, max-age=60, stale-while-revalidate=60` (unchanged), no `Vary` required.

---

### Task 1: Baseline green

**Goal:** Record a passing baseline before touching code.
**Files:** none (read-only).
**Key changes:** none.

- [x] **Step 1: Run typecheck** (done: exit 0, 2026-09-21)

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [x] **Step 2: Run comments tests** (done: 7 passed, 2026-09-21)

Run: `npx vitest run src/routes/comments.test.ts`
Expected: all suites pass (`Test Files  1 passed`, `Tests` all passed).

**Done criteria:** Both commands exit 0; note the passing test count for later comparison.

---

### Task 2: Workers-safe cursor codec + `parseCommentId` pure helpers

**Goal:** Replace Node `Buffer` cursors with a Web-standard codec (identical wire format) and add the single id parser used by every route.
**Files:** Modify `src/routes/comments.ts` lines 57-72 (cursor section) + add helper next to it.
**Key changes:** `encodeCursor`, `decodeCursor`, new `parseCommentId(raw: unknown): number | null`.

- [x] **Step 1: Replace cursor helpers with the Web-standard implementation** (done: a47459a)

Old strings (exact, lines 59-72):
```ts
export function encodeCursor(c: RootsCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): RootsCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.t !== 'number' || typeof parsed?.i !== 'number') return null;
    if (parsed.s !== undefined && typeof parsed.s !== 'number') return null;
    return parsed as RootsCursor;
  } catch {
    return null;
  }
}
```
New strings:
```ts
function base64UrlEncodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToText(raw: string): string {
  let s = raw.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 1) throw new Error('bad length');
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(c: RootsCursor): string {
  return base64UrlEncodeText(JSON.stringify(c));
}

export function decodeCursor(raw: string): RootsCursor | null {
  try {
    const parsed = JSON.parse(base64UrlDecodeToText(raw));
    if (typeof parsed?.t !== 'number' || typeof parsed?.i !== 'number') return null;
    if (parsed.s !== undefined && typeof parsed.s !== 'number') return null;
    return parsed as RootsCursor;
  } catch {
    return null;
  }
}

/** Accept `123` or `app_123`; anything else -> null. Single-strip only. */
export function parseCommentId(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  const stripped = s.startsWith('app_') ? s.slice(4) : s;
  if (!/^[1-9]\d*$/.test(stripped)) return null;
  const n = Number(stripped);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}
```
Rules pinned: trims whitespace; strips exactly one `app_` prefix (`app_app_1` → `invalid_id`); rejects `0`, negatives, fractions (`12.5`), empty, non-numeric, unsafe integers.

- [x] **Step 2: Typecheck** (done: exit 0)

Run: `npx tsc --noEmit`
Expected: exit 0.

- [x] **Step 3: Run existing pure-helper tests (must still pass — wire format unchanged)** (done: pass)

Run: `npx vitest run src/routes/comments.test.ts -t "cursor round-trips"`
Expected: PASS (pre-fix vectors decode identically).

**Done criteria:** `tsc` clean; existing cursor test passes unmodified; no `Buffer` reference remains in `src/routes/comments.ts` (verify with `grep -n Buffer src/routes/comments.ts` returning nothing).

---

### Task 3: New pure-helper unit suite

**Goal:** Pin `parseCommentId`, cursor compatibility, inheritance resolver, and code-table completeness with no I/O.
**Files:** Create `src/routes/comments.unit.test.ts`.
**Key changes:** imports `parseCommentId`, `encodeCursor`, `decodeCursor`, `resolveEffectiveChapter` (added in Task 5 — this task's inheritance cases import it; if Task 5 is not done yet, implement the 6-line resolver here first as specified below and Task 5 reuses it verbatim).

- [x] **Step 1: Create `src/routes/comments.unit.test.ts` with this exact content** (done: 7505279)

```ts
import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor, parseCommentId } from './comments.js';

// resolveEffectiveChapter lives in comments.ts (Task 5). Pure rule:
// explicit != null -> explicit; else parent chapter; else null.
// Mismatch detection is `explicit != null && parent != null && explicit !== parent`.
function expectedEffective(explicit: number | undefined, parent: number | null): number | null {
  return explicit ?? parent ?? null;
}

describe('parseCommentId', () => {
  it('accepts bare and app_ ids', () => {
    expect(parseCommentId('123')).toBe(123);
    expect(parseCommentId('app_123')).toBe(123);
    expect(parseCommentId('  app_7  ')).toBe(7);
  });
  it('rejects garbage', () => {
    for (const bad of ['0', '-3', '12.5', 'abc', 'app_', 'app_0', 'app_-2', 'app_1.5', 'app_app_1', '', '   ', 'app_abc', '99999999999999999999999']) {
      expect(parseCommentId(bad)).toBeNull();
    }
  });
});

describe('cursor codec (Workers-safe, wire-compatible)', () => {
  it('round-trips both shapes', () => {
    expect(decodeCursor(encodeCursor({ t: 1726400000000, i: 42 }))).toEqual({ t: 1726400000000, i: 42 });
    expect(decodeCursor(encodeCursor({ t: 1, i: 2, s: 9 }))).toEqual({ t: 1, i: 2, s: 9 });
  });
  it('decodes a pre-fix Buffer vector', () => {
    // produced by Buffer.from(JSON.stringify({t:1726400000000,i:42})).toString('base64url')
    const preFix = Buffer.from(JSON.stringify({ t: 1726400000000, i: 42 }), 'utf8').toString('base64url');
    expect(decodeCursor(preFix)).toEqual({ t: 1726400000000, i: 42 });
  });
  it('rejects garbage and wrong shapes', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(encodeCursor({ t: 1, i: 2, s: 9 }).slice(0, -2) + '%%')).toBeNull();
  });
});

describe('chapter inheritance resolver', () => {
  it('inherits parent when omitted, keeps explicit, null when neither', () => {
    expect(expectedEffective(undefined, 72)).toBe(72);
    expect(expectedEffective(undefined, null)).toBeNull();
    expect(expectedEffective(5, 72)).toBe(5);
    expect(expectedEffective(72, 72)).toBe(72);
  });
  it('detects mismatch only when explicit disagrees with a known parent scope', () => {
    const mismatch = (explicit: number | undefined, parent: number | null) =>
      explicit != null && parent != null && explicit !== parent;
    expect(mismatch(5, 72)).toBe(true);
    expect(mismatch(72, 72)).toBe(false);
    expect(mismatch(undefined, 72)).toBe(false);
    expect(mismatch(5, null)).toBe(false);
  });
});
```

- [x] **Step 2: Run the new suite** (done: 7 passed)

Run: `npx vitest run src/routes/comments.unit.test.ts`
Expected: `Test Files  1 passed`, all tests passed.

**Done criteria:** New file passes; no I/O or env access in the suite.

---

### Task 4: Coded 429 in `rateLimit` middleware

**Goal:** Comments throttling returns a distinguishable coded body without changing budgets.
**Files:** Modify `src/middleware/rateLimit.ts` line 17.
**Key changes:** 429 body only.

- [x] **Step 1: Edit the throttle branch** (done: b20c281)

Old string (exact):
```ts
    if (cur.count > max) return c.json({ error: 'too many requests' }, 429);
```
New string:
```ts
    if (cur.count > max) {
      if (c.req.path.includes('/comments')) {
        return c.json({ success: false, code: 'rate_limited', error: 'too many requests' }, 429);
      }
      return c.json({ error: 'too many requests' }, 429);
    }
```

- [x] **Step 2: Typecheck** (done: exit 0)

Run: `npx tsc --noEmit`
Expected: exit 0.

**Done criteria:** Non-comments paths byte-identical; comments paths carry `{ success: false, code: 'rate_limited', error: 'too many requests' }` at 429. (Step 2 typecheck done: exit 0, b20c281)

---

### Task 5: Context-cached `getCaller` + chapter-inheritance resolver + FK-safe `novelExists`

**Goal:** One user lookup per request becomes possible; replies inherit scope; missing-novel vs DB-error are distinguishable.
**Files:** Modify `src/middleware/ownership.ts` (`getCaller`), `src/routes/comments.ts` (`resolveEffectiveChapter`, `novelExists`).
**Key changes:** `getCaller` cache short-circuit; new `resolveEffectiveChapter`; `novelExists` tri-state.

- [x] **Step 1: Add cache short-circuit at the top of `getCaller`** (done: 731037b)

Old string (exact, ownership.ts lines 13-15):
```ts
export async function getCaller(c: Context): Promise<Caller> {
  const payload = c.get('authUser') as { sub?: string } | undefined;
```
New string:
```ts
export async function getCaller(c: Context): Promise<Caller> {
  const cached = c.get('caller') as Caller | undefined;
  if (cached) return cached;
  const payload = c.get('authUser') as { sub?: string } | undefined;
```

- [x] **Step 2: Add the inheritance resolver to comments.ts after `parseCommentId`** (done: 731037b)

```ts
/** Reply scope: explicit value wins; omitted inherits the parent chapter; else novel-level null. */
export function resolveEffectiveChapter(
  explicit: number | undefined,
  parentChapter: number | null | undefined,
): number | null {
  return explicit ?? parentChapter ?? null;
}
```

- [x] **Step 3: Make `novelExists` tri-state** (done: 731037b)

Old strings (exact, comments.ts lines 273-285):
```ts
async function novelExists(novelId: string): Promise<boolean> {
  if (isDbAvailable()) {
    try {
      const rows = await db.select({ id: novels.id }).from(novels).where(eq(novels.id, novelId)).limit(1);
      return Boolean(rows[0]);
    } catch (err) {
      console.error('[comments] novel lookup failed', err);
      noteDbFailure();
      return true; // DB error: stay open, let the query decide
    }
  }
  return true; // memory fallback accepts any novel id
}
```
New strings:
```ts
type NovelCheck = 'exists' | 'missing' | 'unknown';
async function novelExists(novelId: string): Promise<NovelCheck> {
  if (isDbAvailable()) {
    try {
      const rows = await db.select({ id: novels.id }).from(novels).where(eq(novels.id, novelId)).limit(1);
      return rows[0] ? 'exists' : 'missing';
    } catch (err) {
      console.error('[comments] novel lookup failed', err);
      noteDbFailure();
      return 'unknown'; // DB error: caller returns 503, never masks as exists
    }
  }
  return 'exists'; // memory fallback accepts any novel id
}
```

- [x] **Step 4: Typecheck** (done: exit 0, zero errors — `!check` on strings is valid TS so old call sites are logically dead until Task 6)

Run: `npx tsc --noEmit`
Expected: exit 0. (Callers of `novelExists` still use boolean at this point — if `tsc` flags them, note the errors; Task 6 rewrites those call sites. Do not fix them here.)

**Done criteria:** `tsc` reports only the known `novelExists` call-site type errors (list endpoint line ~380, POST line ~565), nothing else; `ownership.ts` caches correctly.

---

### Task 6: POST create — inheritance, tri-state novel check, full error codes, transactional insert

**Goal:** Replies without `chapterNumber` land in the parent scope; every POST failure carries its code; insert + counter bumps are atomic.
**Files:** Modify `src/routes/comments.ts` POST handler (lines 555-662).
**Key changes:** `resolveWriter` stays (now cached); `novelExists` tri-state consumption; `effectiveChapter` insert; scope-match against inherited value; transaction wrapper; coded errors.

- [x] **Step 1: Rewrite the POST handler body per this spec** (done: 0071d38)

Apply these exact edits in order:
1. Payload failure (line 559): `c.json({ success: false, error: 'حقول غير صالحة', issues: ... }, 400)` → add `code: 'invalid_payload'`.
2. Novel check (line 565): replace the full line `if (!(await novelExists(novelId))) return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);` with:
```ts
const novelCheck = await novelExists(novelId);
if (novelCheck === 'missing') return c.json({ success: false, code: 'novel_not_found', error: 'الرواية غير موجودة' }, 404);
if (novelCheck === 'unknown') return c.json({ success: false, code: 'novel_not_found', error: 'تعذر التحقق' }, 503);
```
Note: the 503 uses the existing `تعذر التحقق` string with code `novel_not_found` (lookup target was the novel). No new Arabic string.
3. Chapter check (lines 566-568): add `code: 'chapter_not_found'`.
4. Cooldown (line 571): add `code: 'cooldown'`, keep numeric `retryAfter`.
5. Duplicate (line 573): add `code: 'duplicate'`.
6. Parent resolution: after loading `parent`, compute `const effectiveChapter = resolveEffectiveChapter(chapterNumber, parent.chapterNumber ?? null);` then:
   - not found → 404 `{ code: 'parent_not_found', error: 'التعليق الأب غير موجود' }`
   - wrong novel → 400 `{ code: 'parent_wrong_novel', error: 'التعليق الأب من رواية أخرى' }`
   - mismatch (`chapterNumber !== undefined && chapterNumber !== (parent.chapterNumber ?? null)`) → 400 `{ code: 'chapter_mismatch', error: 'النطاق غير متطابق' }`
   - parent not visible (both Row/Mem branches) → 409 `{ code: 'reply_forbidden', error: 'لا يمكن الرد على تعليق محجوب' }`
   - depth → 400 `{ code: 'depth_limit', error: 'تم بلوغ أقصى عمق للردود' }`
   - chapter validation for the reply uses `effectiveChapter` (so an inherited 72 validates against chapter 72).
7. Insert path: store `chapterNumber: effectiveChapter ?? null` for replies (roots keep `chapterNumber ?? null`); wrap insert + the parent/root `repliesCount` bumps in one `db.transaction(async (tx) => {...})` replacing the sequential `db.insert` + looped `db.update` calls (lines 634-650). Memory path (lines 605-627) already inherits correctly — add codes only, no logic change.
8. Catch-all 500s keep their Arabic strings unchanged.

- [x] **Step 2: Targeted verification** (done: 7 passed)

Run: `npx vitest run src/routes/comments.test.ts`
Expected: existing full-flow + cross-novel + spam tests still pass (new `code` fields are additive).

- [x] **Step 3: Typecheck** (done: exit 0)

Run: `npx tsc --noEmit`
Expected: exit 0 (POST call sites resolved).

**Done criteria:** Reply without `chapterNumber` to a chapter-72 root stores 72; explicit mismatch 400s with `chapter_mismatch`; insert + bumps atomic; all POST errors coded per table.

---

### Task 7: `parseCommentId` rollout to every `:id`/`:commentId`

**Goal:** `123` and `app_123` both work on all item/mod/admin/replies params; garbage yields `invalid_id`.
**Files:** Modify `src/routes/comments.ts` lines 493, 668, 712, 768, 822, 891-893, 928.
**Key changes:** replace each `Number(c.req.param(...))` with `parseCommentId`; add `invalid_id` code.

- [x] **Step 1: Apply the rollout** (done: dc8b559)

Exact per-site edits:
1. Replies (line 493-494): `const commentId = Number(c.req.param('commentId')); if (!Number.isInteger(commentId)) return c.json({ success: false, error: 'معرف غير صالح' }, 400);` → `const commentId = parseCommentId(c.req.param('commentId')); if (commentId == null) return c.json({ success: false, code: 'invalid_id', error: 'معرف غير صالح' }, 400);`
2. PATCH (line 668-669), DELETE (712-713), vote (768-769), report (822-823), hard-delete (928-929): same transform on `c.req.param('id')`.
3. Mod routes (lines 891-893): `async (c) => modTransition(c, Number(c.req.param('id')), 'hide')` → validate first:
```ts
commentsRouter.post('/:id/hide', prodGuard(requireAuth), async (c) => {
  const id = parseCommentId(c.req.param('id'));
  if (id == null) return c.json({ success: false, code: 'invalid_id', error: 'معرف غير صالح' }, 400);
  return modTransition(c, id, 'hide');
});
```
(repeat for `restore`, `approve`).
4. Add `code: 'invalid_id'` to the memory-path id checks as well (same message).

- [x] **Step 2: Typecheck + targeted tests** (done: clean, 7 passed, no Number(c.req.param left)

Run: `npx tsc --noEmit && npx vitest run src/routes/comments.test.ts`
Expected: both exit 0 / pass.

**Done criteria:** `grep -n "Number(c.req.param" src/routes/comments.ts` returns nothing; both id formats succeed, garbage 400s with `invalid_id`.

---

### Task 8: Unified `buildAuthorLookup` across all read paths

**Goal:** One batch helper serves list roots + previews + replies page + admin queue + `modTransition`; preview authors stop falling back to `{name:'مستخدم'}`.
**Files:** Modify `src/routes/comments.ts` (author sections lines 406-412, 444, 535-540, 881, 912-917).
**Key changes:** new `buildAuthorLookup(userIds: string[])`; call sites pass the union of UIDs.

- [x] **Step 1: Add the helper after `authorOf` (line 130)** (done: 53c93c6)

```ts
/** Single author batch for every DB read path. Live reads off users table. */
async function buildAuthorLookup(userIds: string[]): Promise<Map<string, { name: string; avatarUrl?: string }>> {
  const lookup = new Map<string, { name: string; avatarUrl?: string }>();
  const uniq = [...new Set(userIds.filter(Boolean))];
  if (!uniq.length) return lookup;
  const urows = await db.select().from(users).where(inArray(users.id, uniq));
  for (const u of urows) lookup.set(u.id, { name: u.displayName || u.username || 'مستخدم', avatarUrl: u.avatarUrl ?? undefined });
  return lookup;
}
```

- [x] **Step 2: Rewire call sites** (done: 53c93c6)

1. List (lines 406-412): replace inline `uids`/`lookup` block with `buildAuthorLookup(page.map((r) => r.userId).filter(Boolean) as string[])` — extended in Task 9 to include preview UIDs (union set); keep roots-only here, Task 9 widens it.
2. Replies (lines 535-540): replace inline block with `buildAuthorLookup(...)`.
3. Admin queue (lines 912-917): replace inline block with `buildAuthorLookup(...)` (no behavior change).
4. `modTransition` (line 881): replace `const lookup = new Map...` (empty) with `const lookup = await buildAuthorLookup(updated.userId ? [updated.userId] : []);`
5. `authorOf` fallback `{name:'مستخدم'}` and deleted-user `{id:'deleted', name:'مستخدم محذوف'}` with no avatar key stay exactly as-is.

- [x] **Step 3: Typecheck + tests** (done: clean, 7 passed)

Run: `npx tsc --noEmit && npx vitest run src/routes/comments.test.ts`
Expected: clean + pass.

**Done criteria:** One `users ... WHERE id IN (...)` query per read path; mod hide/restore/approve responses carry the real author; no orphaned inline author-batch blocks remain. (done: 53c93c6)

---

### Task 9: Preview-per-root guarantee + true replies total (+ widen author union)

**Goal:** Every listed root carries oldest-≤2-visible previews even under skew; replies `total` is the real count.
**Files:** Modify `src/routes/comments.ts` list preview block (lines 423-441) and replies total (line 544).
**Key changes:** per-root bounded fetch (chosen shape); `count(*)` for replies total; author union widened.

- [x] **Step 1: Replace the preview over-fetch block** (done: 8cf6a95)

Old strings (exact, lines 423-441):
```ts
    // reply preview in one query
    const rootIds = page.map((r) => r.id);
    const previews = new Map<number, CommentRow[]>();
    if (rootIds.length) {
      const kids = await db.select().from(comments)
        .where(and(inArray(comments.rootId, rootIds), visibleOnly ? eq(comments.status, 'visible') : sql`true`))
        .orderBy(asc(comments.createdAt), asc(comments.id))
        .limit(rootIds.length * 2 + 10);
      const perRoot = new Map<number, number>();
      for (const k of kids) {
        const rk = k.rootId as number;
        const used = perRoot.get(rk) ?? 0;
        if (used >= 2) continue;
        perRoot.set(rk, used + 1);
        const arr = previews.get(rk) ?? [];
        arr.push(k);
        previews.set(rk, arr);
      }
    }
```
New strings:
```ts
    // preview-per-root guarantee: one bounded LIMIT-2 index lookup per root, concurrent.
    const previews = new Map<number, CommentRow[]>();
    if (rootIds.length) {
      const perRoot = await Promise.all(
        page.map((r) =>
          db.select().from(comments)
            .where(and(eq(comments.rootId, r.id), visibleOnly ? eq(comments.status, 'visible') : sql`true`))
            .orderBy(asc(comments.createdAt), asc(comments.id))
            .limit(2),
        ),
      );
      page.forEach((r, idx) => previews.set(r.id, perRoot[idx]));
    }
```
(`rootIds` const above is now unused — delete the `const rootIds = page.map((r) => r.id);` line; keep the `inArray` import since replies/admin still use it.)

- [x] **Step 2: Widen the list author batch to the union** (done: 8cf6a95)

After `previews` is built, collect `const previewUids = [...previews.values()].flat().map((k) => k.userId).filter(Boolean) as string[];` and build the lookup from roots ∪ previews (move the `buildAuthorLookup` call to after the preview fetch, passing both UID sets). Preview mapping (line 444) then uses this unified lookup instead of the root-only one.

- [x] **Step 3: True replies total** (done: 8cf6a95)

Old string (exact, line 543-544):
```ts
      success: true, total: page.length,
```
New string:
```ts
      success: true, total: Number((await db.select({ n: sql<number>`count(*)::int` }).from(comments).where(base))[0]?.n ?? page.length),
```
Memory fallback (`kids.length`, line 517) unchanged. List `total` (root `count(*)`, line 404) unchanged per spec assumption.

- [x] **Step 4: Typecheck + tests** (done: clean, 7 passed, 8cf6a95)

Run: `npx tsc --noEmit && npx vitest run src/routes/comments.test.ts`
Expected: clean + pass.

**Done criteria:** A root with 10 visible children no longer starves later roots (each listed root has ≤2 oldest previews); replies `total` equals full visible-children count. (done: 8cf6a95)

---

### Task 10: Transactional counters for vote / delete / report (+ mod paths)

**Goal:** Counter writes cannot drift on crash or concurrent toggles.
**Files:** Modify `src/routes/comments.ts` vote (787-812), soft-delete (747-757), report (834-844).
**Key changes:** wrap each read-modify-write in `db.transaction`.

- [x] **Step 1: Vote toggle transaction** (done: d6fd8c0)

Wrap the existing vote-row read + upsert/delete + `likesCount` delta update (lines 793-811) in `await db.transaction(async (tx) => { ... })` with all `db.` calls inside switched to `tx.`. Observable contract unchanged: `score` returned from the updated row; unique guard `(commentId, userId)` + atomic `likesCount + delta` preserved; last-writer-wins on the vote row.

- [x] **Step 2: Soft-delete transaction** (done: d6fd8c0)

Wrap status flip + parent/root `repliesCount` decrements (`GREATEST(0, ... - 1)`, deduped pid set) + `commentModLog` insert (lines 747-757) in one `db.transaction`. Idempotent re-delete (`status === 'deleted'` → success message, no writes) stays before the transaction.

- [x] **Step 3: Report transaction** (done: d6fd8c0)

Replace the read-bump-re-read-flip sequence (lines 837-844) with a single transaction: increment `reportsCount`, then conditional flip to `pending` when `reportsCount >= 3 AND status = 'visible'` evaluated on the just-updated row inside the same txn, then `commentModLog` insert.

- [x] **Step 4: Typecheck + tests** (done: clean, 7 passed, d6fd8c0)

Run: `npx tsc --noEmit && npx vitest run src/routes/comments.test.ts`
Expected: clean + pass.

**Done criteria:** Vote `1 → -1 → 0` converges `likesCount`; delete never drives counters negative; report flips at exactly 3; no counter write occurs outside a transaction on these three paths (POST insert done in Task 6).

---

### Task 11: Single `getCaller` per request + remaining error codes

**Goal:** 1 user lookup per authenticated request; every remaining error carries its code.
**Files:** Modify `src/routes/comments.ts` (`resolveWriter`, `requireNovelMod`, list liked-by-me lines 413-422, `modTransition` line 871, PATCH/DELETE/vote/report/mod/admin error bodies).
**Key changes:** cache caller on context; consume cached value; add codes.

- [x] **Step 1: Cache the caller in `resolveWriter` and `requireNovelMod`** (done: 2139063)

In `resolveWriter` (line 200): after `const caller = await getCaller(c);` add `c.set('caller', caller);` on the success path (before building the return). In `requireNovelMod` (line 305): after `const caller = await getCaller(c);` add the same `c.set('caller', caller);` on success paths. `getCaller` itself short-circuits via Task 5, so the second and third calls in a request (mod check, liked-by-me batch, `modTransition` actor lookup) hit the cache.

- [x] **Step 2: Add codes to every remaining error body** (done: 2139063)

Per the table: list (`invalid_query` + `issues`, `invalid_cursor`; plus tri-state novel check replacing line-380 `if (!(await novelExists(novelId)))` with the same `exists/missing/unknown` → 404 `novel_not_found` / 503 `تعذر التحقق` pattern from Task 6); replies (`invalid_cursor`, `comment_not_found`); count query failure (`invalid_query`); PATCH (`invalid_payload`+`issues`, `comment_not_found`, `forbidden`, `deleted`, `edit_window`, `edit_limit`); DELETE (`comment_not_found`, `forbidden`); vote (`invalid_payload`+`issues` on `قيمة غير صالحة`, `vote_login`, `comment_not_found`, `self_vote`); report (`comment_not_found`); mod (`invalid_payload`, `comment_not_found`, `deleted`, `forbidden`/`unauthorized` via `requireNovelMod` passthrough unchanged); admin (`invalid_query` on `حالة غير صالحة`, `forbidden`); novel-mod 404 already `الرواية غير موجودة` gains `novel_not_found`. Memory branches gain identical codes. No Arabic string reworded; `issues`/`retryAfter` extras kept.

- [x] **Step 3: Typecheck + tests** (done: clean, 7 passed, 2139063)

Run: `npx tsc --noEmit && npx vitest run src/routes/comments.test.ts`
Expected: clean + pass.

**Done criteria:** Authenticated flows issue one users lookup by construction (cache short-circuit in `getCaller` + `c.set('caller', ...)` on every resolve path; verified by inspection that no comments handler calls the users table except through the cached `getCaller`/`buildAuthorLookup`); every error body in the file carries `code`. (done: 2139063, zero codeless 4xx)

---

### Task 12: Cache-header fix on list + count

**Goal:** Personalized responses are never shared-cacheable.
**Files:** Modify `src/routes/comments.ts` lines 375 (mem list), 452 (db list), 472/481 (count).
**Key changes:** conditional `Cache-Control` + `Vary`.

- [x] **Step 1: List headers (both DB and memory branches)** (done: f461978)

Replace the unconditional `c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');` in the list handler with:
```ts
const callerForCache = getEnv().syncOpen ? null : await getCaller(c);
if (wantStatus !== undefined) {
  c.header('Cache-Control', 'no-store');
  c.header('Vary', 'Authorization');
} else if (callerForCache?.row) {
  c.header('Cache-Control', 'private, max-age=30');
  c.header('Vary', 'Authorization');
} else {
  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
}
```
Reuse the already-cached caller (Task 11) — this `getCaller` call hits the context cache, adding no query. Note: the moderator `requireNovelMod` call earlier in the handler already cached the caller.

- [x] **Step 2: Count headers unchanged** (done: untouched, f461978)

Leave both count branches (`public, max-age=60, stale-while-revalidate=60`) exactly as-is — count carries no per-user data. No `Vary` added.

- [x] **Step 3: Typecheck + tests** (done: clean, 7 passed, f461978)

Run: `npx tsc --noEmit && npx vitest run src/routes/comments.test.ts`
Expected: clean + pass.

**Done criteria:** `grep -n "Cache-Control" src/routes/comments.ts` shows `public` only on list-anonymous + count branches, `private, max-age=30` and `no-store` on the personalized branches, each paired with `Vary: Authorization`. (done: f461978)

---

### Task 13: Extend memory-mode API tests

**Goal:** Pin every spec behavior end-to-end through `app.request` in open mode.
**Files:** Extend `src/routes/comments.test.ts` (append new `it` blocks; do not alter existing ones except adding `code` assertions where already exact).
**Key changes:** chapter inheritance, mismatch, both id formats, codes, true total, previews, cache headers, snapshot rule.

- [x] **Step 1: Append these test blocks** (done: df4825e, 11/11 pass)

```ts
it('chapter scope: default novel-only, ?chapter selects, reply inherits', async () => {
  const app = openApp();
  const novel = `ch_${Date.now()}`;
  const root = await (await app.request(`/api/v1/novels/${novel}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'جذر الفصل 72', chapterNumber: 72 }),
  })).json() as any;
  const wall: any = await (await app.request(`/api/v1/novels/${novel}/comments`)).json();
  expect(wall.data.some((c: any) => c.id === root.data.id)).toBe(false);
  const ch: any = await (await app.request(`/api/v1/novels/${novel}/comments?chapter=72`)).json();
  expect(ch.data.some((c: any) => c.id === root.data.id)).toBe(true);
  const rid = Number(String(root.data.id).replace('app_', ''));
  const rep = await (await app.request(`/api/v1/novels/${novel}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'رد موروث', parentId: rid }),
  })).json() as any;
  expect(rep.success).toBe(true);
  expect(rep.data.chapterNumber).toBe(72);
  const ch2: any = await (await app.request(`/api/v1/novels/${novel}/comments?chapter=72`)).json();
  expect(ch2.data[0].preview.length).toBeGreaterThanOrEqual(1);
  const bad = await app.request(`/api/v1/novels/${novel}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'رد مخالف', parentId: rid, chapterNumber: 5 }),
  });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).code).toBe('chapter_mismatch');
});

it('accepts both id formats; garbage yields invalid_id', async () => {
  const app = openApp();
  const novel = `ids_${Date.now()}`;
  const posted: any = await (await app.request(`/api/v1/novels/${novel}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'جذر للمعرفات' }),
  })).json();
  const bare = String(posted.data.id).replace('app_', '');
  for (const id of [bare, posted.data.id]) {
    const reps = await app.request(`/api/v1/novels/${novel}/comments/${id}/replies`);
    expect(reps.status).toBe(200);
    const edit = await app.request(`/api/v1/comments/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `تعديل ${id} ${Date.now()}` }),
    });
    expect(edit.status).toBe(200);
  }
  const bad = await app.request(`/api/v1/novels/${novel}/comments/app_abc/replies`);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).code).toBe('invalid_id');
});

it('error bodies carry codes; replies total is true; previews capped at 2', async () => {
  const app = openApp();
  const novel = `tot_${Date.now()}`;
  const posted: any = await (await app.request(`/api/v1/novels/${novel}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'جذر العد' }),
  })).json();
  const rid = Number(String(posted.data.id).replace('app_', ''));
  const ts = Date.now();
  for (let i = 0; i < 5; i++) {
    await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `رد ${i} ${ts}`, parentId: rid }),
    });
  }
  const reps: any = await (await app.request(`/api/v1/novels/${novel}/comments/${rid}/replies?limit=2`)).json();
  expect(reps.total).toBe(5);
  expect(reps.data.length).toBe(2);
  const list: any = await (await app.request(`/api/v1/novels/${novel}/comments?limit=10`)).json();
  const mine = list.data.find((c: any) => c.id === posted.data.id);
  expect(mine.preview.length).toBeLessThanOrEqual(2);
  const dup = await app.request(`/api/v1/novels/${novel}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: `رد 4 ${ts}`, parentId: rid }),
  });
  expect(dup.status).toBe(409);
  expect(((await dup.json()) as any).code).toBe('duplicate');
  const cur = await app.request(`/api/v1/novels/${novel}/comments?cursor=nope`);
  expect(((await cur.json()) as any).code).toBe('invalid_cursor');
});

it('list cache header is public in anonymous open mode', async () => {
  const app = openApp();
  const res = await app.request(`/api/v1/novels/cache_${Date.now()}/comments`);
  expect(res.headers.get('cache-control')).toContain('public');
});
```

- [x] **Step 2: Run the extended suite** (done: 11 passed)

Run: `npx vitest run src/routes/comments.test.ts`
Expected: all tests pass, including the 4 new blocks.

**Done criteria:** Inheritance, mismatch code, dual id formats, `invalid_id`, `duplicate`, `invalid_cursor`, true total (5 vs page 2), preview ≤ 2, public cache header — all pinned.

---

### Task 14: Full regression + final gates

**Goal:** Prove nothing broke and all three gates are green.
**Files:** none (verification only).
**Key changes:** none.

- [x] **Step 1: Run the full test suite** (done: 145 passed, 7 skipped, exit 0)

Run: `npm test`
Expected: all test files pass, zero failures.

- [x] **Step 2: Run typecheck** (done: exit 0)

Run: `npm run typecheck`
Expected: exit 0.

- [x] **Step 3: Run build** (done: exit 0, dist/ emitted)

Run: `npm run build`
Expected: exit 0, `dist/` emitted.

**Done criteria:** `npm test`, `npm run typecheck`, `npm run build` all exit 0. Pre-existing tests (full-flow memory, invalid-cursor, cross-novel-parent, link-spam-pending) pass with new `code` fields present.

---

## Scope guard (do not implement)

No Redis work, no index migration / new migration file, no avatar upload endpoint, no app-repo edits, no changes to novels/chapters/auth shape/sync/uploads/decorations/billing/Cloudflare config, no live-Neon commands. Tunables unchanged: `EDIT_WINDOW_MS` 15min, `MAX_EDITS` 5, cooldowns 30s/10s, `DAILY_CAP` 100, `REPORTS_TO_PENDING` 3, `MAX_DEPTH` 3, rate budgets POST 5/min vote/report/edit 30/10/30.
