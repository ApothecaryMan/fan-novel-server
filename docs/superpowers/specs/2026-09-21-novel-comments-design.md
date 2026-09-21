# Novel Comments Fix: Design

**Date:** 2026-09-21
**Status:** Approved brainstorm scope (approach A + preview-query + cache-header fixes); audited design specification (specification only, no product code)
**Repositories:** server `/home/x1carbon/Projects/fan-novel-server` (primary, edited)
**Runtime:** Cloudflare Workers + Hono + Drizzle + Neon Postgres
**Scope:** Server-side comments fix only. No app-repo changes.

## Goal

Fix the novel comments system so that chapter-scoped comments never vanish after an app restart, every write/read failure returns a distinct machine-readable error code with its existing Arabic message, comment authors always resolve with their live `users.avatar_url` wherever they appear (list roots, reply previews, replies pages, moderation responses, admin queue), and the read/write hot paths are correct under load (transactional counters, guaranteed two-reply previews, true reply totals, Workers-safe cursors, single caller lookup per request, non-leaking cache headers) — all without breaking the existing `success/error` response shape or requiring an urgent mobile-app update.

## Non-Goals

- Any Redis work: no Redis-backed rate limits, no Redis caching layer, no shared-cooldown store. The in-memory `rateLimit` Map limitation is documented as a known multi-instance skew, not fixed here.
- Any index migration: no new GIN index, no change to `comments_roots_new`, `comments_roots_top`, `comments_thread`, `comments_parent`, `comments_user` indexes, no new migration file. The uncovered `status`-filter scan is accepted and documented.
- Any new avatar object-storage endpoint: no R2 avatar upload route, no cover-blob reuse for avatars, no MIME/size pipeline for avatars. `avatar_url` stays an `https` URL string set via Google login fill-or-heal or `PATCH /me`.
- Any mobile-app changes: no edits to the app repository. The server accepts both `123` and `app_123` id formats so existing clients keep working.
- Any change to comment moderation policy itself: `EDIT_WINDOW_MS` (15 min), `MAX_EDITS` (5), cooldown durations (30s / 10s admin), `DAILY_CAP` (100), `REPORTS_TO_PENDING` (3), `MAX_DEPTH` (3), `shouldHoldForModeration` heuristics, and rate-limit budgets (POST 5/min, vote/report/edit 30/10/30) are unchanged.
- Any change to novels, chapters, auth/session shape, sync, uploads (covers), decorations, billing, or Cloudflare configuration.
- Executing any live-Neon command, migration, deployment, or live test as part of this specification-only change.

## Context

- Comment storage (`src/database/schema.ts:185-212`): `comments` rows carry `novelId` (FK to `novels.id`, cascade delete), nullable `chapterNumber` (NULL = novel-level comment), `userId` (FK to `users.id`, set-null), `parentId`/`rootId`/`depth` threading, `body`/`bodyHash`, `status` (`visible|pending|hidden|deleted`), and denormalized `likesCount`/`repliesCount`/`reportsCount`/`editCount`. Votes live in `commentVotes` with a `(commentId, userId)` unique guard; moderation actions append to `commentModLog`.
- Routes (`src/routes/comments.ts`, ~949 lines): novel-scoped `GET` list, `GET` count, `GET` replies, `POST` create; item `PATCH`/`DELETE`/`vote`/`report`/`hide`/`restore`/`approve`; admin queue `GET /api/v1/admin/comments` and hard-delete. A memory fallback (`MEM` map + `MEM_VOTES`) serves open-LAN/dev mode when the DB is unavailable.
- Response id format: `toApi` serializes `id: app_<n>`, `parentId: app_<n>|null`, `rootId: app_<n>|null` (lines 107-124), but every item route parses with `Number(param)` (lines 668, 712, 768, 822, 928), so the app's own `app_123` values return 400 `معرف غير صالح` on edit/delete/vote/report/moderation.
- Identity (`src/middleware/ownership.ts:getCaller`): resolves the Bearer `sub` (externalId) to a `users` row with one `SELECT`; `isAdmin` from `role`, `canWrite` from admin/author/translator flags. Comments call it up to 3 times per request (`resolveWriter` + `requireNovelMod` + liked-by-me batch).
- Avatars: `users.avatarUrl` is a plain `text` URL column, written only by Google-login fill-or-heal (`src/routes/googleAccount.ts:89`) and `PATCH /me` (`src/routes/auth.ts:187,221`); R2/upload (`src/routes/upload.ts`) is covers-only. The list endpoint builds its author lookup from root-page UIDs only (line 407) and reuses it for reply previews (line 444), so preview authors miss; `modTransition` builds an empty lookup (line 881) so moderated comments never carry avatars.
- Cursors (`encodeCursor`/`decodeCursor`, lines 59-72) use Node `Buffer` base64url, which breaks on Workers (`src/worker.ts`); the pure-helper tests in `src/routes/comments.test.ts:13-19` pin the current Buffer behavior.
- Cache: list and count responses set `Cache-Control: public, max-age=60, stale-while-revalidate=60` (lines 375, 452, 481) even though list bodies embed per-caller `myVote` and moderators can request non-visible statuses — a shared-cache leak.

## Proposed Architecture

### 1. Chapter scoping: inherit on reply, keep novel-only default on list

- **Decision: list without `?chapter=` keeps meaning novel-level only** (`chapterNumber IS NULL`). Rationale: changing the default to "all chapters" would silently merge chapter-72 threads into the novel wall, alter existing `total` semantics, and surprise clients that already pass `?chapter=72` on chapter screens. The vanishing-comments bug is fixed on the write side (inheritance) plus client guidance, not by redefining the default.
- **Decision: reply inherits the parent's chapter when `chapterNumber` is omitted; an explicit `chapterNumber` that mismatches the parent still returns 400.** The memory fallback already implements inheritance (`chapterNumber: chapterNumber ?? parent.chapterNumber`, line 610); the DB insert path is aligned to it: `effectiveChapter = chapterNumber ?? parent.chapterNumber ?? null`. Root posts keep current behavior (explicit value stored, omitted stored as NULL).
- **Decision: `GET .../comments/count` keeps the same default** (no `?chapter` = novel-level) for consistency with the list endpoint. Both endpoints document the rule: "omit `chapter` = novel wall; pass `chapter=N` = chapter N wall; replies always live in their parent's scope."
- Validation order on POST stays: novel exists → chapter exists (when explicit) → cooldown → duplicate → parent/thread resolution with inherited scope. A reply to a chapter-72 root without `chapterNumber` therefore validates against chapter 72 (the inherited value) instead of failing scope match.

### 2. Failure taxonomy: distinct `code` on every failure, same Arabic strings, same shape

- **Decision: every error body keeps `{ success: false, error: <existing Arabic string> }` and gains a stable `code` field; success bodies keep `{ success: true, ... }` unchanged.** No existing `error` string is reworded, so client string matching keeps working.
- Codes (exact values the plan author implements):
  - `cooldown` — 429 with `retryAfter` seconds (existing `retryAfter` field kept). Covers both the 30s/10s post cooldown and the daily-cap 3600s branch; the Arabic message stays `مهلاً — انتظر قليلاً قبل التعليق التالي`.
  - `rate_limited` — 429 from the `rateLimit` middleware path (currently bare `{ error: 'too many requests' }`). The middleware response for comments routes gains `{ success: false, code: 'rate_limited', error: 'too many requests' }` so the app can distinguish it from `cooldown`.
  - `duplicate` — 409 `تعليق مكرر` (last-3 `bodyHash` guard, unchanged window).
  - `invalid_id` — 400 `معرف غير صالح` (malformed id after prefix normalization).
  - `invalid_cursor` — 400 `مؤشر ترقيم غير صالح`.
  - `invalid_payload` — 400 `حقول غير صالحة` (zod failures; existing `issues` array kept).
  - `invalid_query` — 400 `استعلام غير صالح` (list query zod failure; `issues` kept).
  - `novel_not_found` — 404 `الرواية غير موجودة`.
  - `chapter_not_found` — 404 `الفصل غير موجود`.
  - `chapter_mismatch` — 400 `النطاق غير متطابق` (explicit reply chapter ≠ parent chapter).
  - `parent_not_found` — 404 `التعليق الأب غير موجود`.
  - `parent_wrong_novel` — 400 `التعليق الأب من رواية أخرى`.
  - `reply_forbidden` — 409 `لا يمكن الرد على تعليق محجوب`.
  - `depth_limit` — 400 `تم بلوغ أقصى عمق للردود`.
  - `comment_not_found` — 404 `التعليق غير موجود`.
  - `forbidden` — 403 `غير مسموح` (all current `غير مسموح` branches share this code).
  - `edit_window` — 403 `انتهت مهلة التعديل`; `edit_limit` — 403 `تم بلوغ حد التعديلات`; `deleted` — 409 `التعليق محذوف`.
  - `self_vote` — 403 `لا يمكن التصويت على تعليقك`; `vote_login` — 401 `سجل الدخول للتصويت`.
  - `unauthorized` — 401 `غير مصرح: مطلوب تسجيل الدخول`.
- **Decision: accept both `123` and `app_123` on every `:id` param** (item PATCH/DELETE/vote/report, replies `:commentId`, mod hide/restore/approve, admin hard-delete) via a single pure helper `parseCommentId(raw): number | null` that trims, strips one `app_` prefix, and requires a positive safe integer. `Number()` parsing is removed from all comment routes. Non-numeric, zero, negative, fractional, and double-prefixed values yield `invalid_id`.
- **Decision: FK-safe novel check with clean 404.** `novelExists` no longer masks DB errors as `true`. On lookup failure it returns a third state (`unknown`) and the caller returns 503 `تعذر التحقق` rather than attempting the write (which today 500s on the FK violation when the novel row is missing). Successful lookup of a missing novel returns 404 `novel_not_found`. The memory fallback still accepts any novel id.

### 3. Avatar completeness: one batch, live reads, honest snapshot rule

- **Decision: a single `buildAuthorLookup(userIds)` helper serves every DB read path** — list roots + preview children + replies page + admin queue + `modTransition`. Each route collects the union of UIDs it is about to serialize (roots plus all preview/reply rows plus the just-written/updated row's author) and issues one `SELECT ... WHERE id IN (...)`. Preview mapping switches from the root-only lookup to this unified lookup, fixing the `{name:'مستخدم'}` fallback on other users' reply images. `modTransition` populates the lookup from the updated row's `userId` instead of returning an empty map, so hide/restore/approve responses carry the real author.
- **Decision: DB reads are live; memory fallback is a documented snapshot.** Every DB serialization reads `users.displayName || users.username || 'مستخدم'` and `users.avatarUrl ?? undefined` at request time, so a `PATCH /me` avatar change is visible on the next comments fetch with no extra work. `MEM` rows keep the writer's name/avatar captured at POST time (snapshot) — this is declared behavior for open-LAN/dev mode, not a bug to chase, because the memory store has no user table to join.
- **Decision: no avatar upload endpoint in this spec; client guidance instead.** `avatar_url` remains an `https` URL string. The spec directs clients: after a Google profile-picture change, re-login (fill-or-heal refreshes a missing avatar) or `PATCH /me { avatarUrl }`; when `author.avatarUrl` is absent/null, render the default avatar. `authorOf` keeps the `{name:'مستخدم'}` fallback for orphaned userIds with no `avatarUrl` key (never an empty string).
- `resolveWriter` keeps sourcing the POST/PATCH response author chip from the caller's own row (one lookup, no extra query); all other rows in the same response come from the batch.

### 4. Optimization and correctness changes

- **Decision: transactional counters via single-statement atomic updates.** Insert-then-bump (POST reply), vote toggle + `likesCount` delta, soft-delete + `repliesCount` decrement, and report + `reportsCount` increment (+ conditional pending flip) each run inside one Drizzle transaction so a crash between statements cannot drift counters. The exact SQL shape (transaction wrapper vs. CTE) is the plan author's choice; the observable contract is: counters always reflect committed children/votes, and concurrent vote toggles converge (unique guard + atomic delta, last-writer-wins on the vote row).
- **Decision: preview-per-root guarantee — exactly the oldest 2 visible children per listed root, fetched correctly.** The current `LIMIT(roots*2+10)` + in-memory trim under-fetches under load (a root with many children starves later roots). Replacement: per-root bounded fetch (one query per root capped at 2, or a `LATERAL`/window-function equivalent — plan author's choice, bounded by `page.length ≤ 50`, so worst case 50 tiny index lookups against the existing `comments_thread` index). Behavior contract: every listed root carries `preview: oldest ≤2 visible children`; roots with no visible children carry `preview: []`.
- **Decision: replies endpoint returns the real total.** `total` becomes `SELECT count(*) WHERE rootId = threadId AND status = 'visible'` instead of `page.length`. The memory fallback already returns the true count (`kids.length`, line 517) and is unchanged.
- **Decision: remove `public` from personalized responses.** List responses embed `myVote` (per-caller) and can expose non-visible statuses to moderators, so `Cache-Control: public` is a leak. New rule: authenticated list responses send `Cache-Control: private, max-age=30` (moderator filtered views send `no-store`); anonymous/visible-only list and `count` responses keep a public cacheable header (`public, max-age=60, stale-while-revalidate=60`). `Vary: Authorization` is added wherever `private` is sent. Exact header strings are pinned in the test plan.
- **Decision: single `getCaller` per request.** Each handler resolves the caller once, stashes it on the context (`c.set('caller', ...)`), and `resolveWriter`/`requireNovelMod`/liked-by-me all consume the cached value. Observable effect: 1 user lookup per authenticated request instead of 2-3; behavior (401/403/404 decisions) unchanged.
- **Decision: Workers-safe cursor codec.** Replace Node `Buffer` with a Web-standard base64url implementation (`btoa`/`atob` + UTF-8 `TextEncoder`/`TextDecoder`, or equivalent) for `encodeCursor`/`decodeCursor`. Wire format stays `base64url(JSON({t, i, s?}))` so existing cursors issued before the fix continue to decode. `decodeCursor` keeps returning `null` on garbage (400 `invalid_cursor`).
- **Explicitly deferred with rationale:** (a) Redis rate limits/caching — needs infrastructure and cross-instance semantics beyond this bugfix; the per-instance Map skew is documented, budgets unchanged. (b) Status-covering index migration — the `status` filter scan is bounded by page size and moderator-only; a migration needs its own spec + runbook. (c) Avatar object storage — no abuse pipeline (MIME/size/auth) exists for user uploads; URL-string avatars satisfy the reported bug.

### 5. API behavior changes per endpoint

- `GET /api/v1/novels/:novelId/comments?chapter&cursor&limit&sort&status`: default scope documented as novel-level; `chapter=N` selects chapter scope. Preview array guaranteed (oldest ≤2 visible per root) with real authors. `total` = root count in scope (existing `count(*)` kept; per-page recount accepted). Errors gain `code` (`invalid_query`, `invalid_cursor`). Cache: private/no-store when personalized, public only for anonymous visible-only reads.
- `GET /api/v1/novels/:novelId/comments/count?chapter`: same scope default; `{ total, roots }` unchanged; errors gain `code`. Cache header unchanged (public; no per-user data).
- `GET /api/v1/novels/:novelId/comments/:commentId/replies`: `:commentId` accepts both formats (`invalid_id` otherwise). `total` becomes the true visible-children count. Authors via unified batch. Cursor codec unchanged in wire format.
- `POST /api/v1/novels/:novelId/comments`: reply without `chapterNumber` inherits parent scope; explicit mismatch → 400 `chapter_mismatch`. Failures coded: `cooldown` (+`retryAfter`), `rate_limited`, `duplicate`, `novel_not_found`, `chapter_not_found`, `parent_not_found`, `parent_wrong_novel`, `chapter_mismatch`, `reply_forbidden`, `depth_limit`. Counters transactional. Response author chip from writer row; avatar = writer's live `avatarUrl`.
- `PATCH /api/v1/comments/:id`, `DELETE /api/v1/comments/:id`, `POST /api/v1/comments/:id/vote`, `POST /api/v1/comments/:id/report`, `POST /api/v1/comments/:id/hide|restore|approve`, `DELETE /api/v1/admin/comments/:id/hard`: all accept both id formats. Vote/report/delete/mod counter writes transactional. `modTransition` responses include the real author via unified lookup. All errors coded per §2.
- `GET /api/v1/admin/comments?status&limit`: authors via unified batch (already correct; refactored to share the helper, no behavior change).

### 6. Data flow

- Write path: auth → `getCaller` (once, cached) → zod validation → `novelExists` (FK-safe tri-state) → optional `chapterExists` → cooldown + duplicate guards → parent/thread resolution with chapter inheritance → single transaction (insert + counter bumps / vote toggle + like delta / status flip + mod-log append) → response with writer-row author chip.
- Read path: query validation → cursor decode (Workers-safe) → scope predicate (`chapterNumber = N` vs `IS NULL`) + status predicate → page fetch (`limit+1` for `hasMore`) → unified author batch (roots ∪ previews ∪ replies) → liked-by-me batch (single cached caller) → preview-per-root fetch (bounded) → response with `private`/`public` cache header per personalization.
- Avatar flow: Google login fill-or-heal or `PATCH /me` writes `users.avatar_url` → every DB comment serialization re-reads it in the author batch → clients fall back to a default avatar on null. Memory mode bypasses the user table and serves POST-time snapshots.

### 7. Error handling

- Shape preserved: `{ success: false, error, code, ...extras }` where extras are only the pre-existing `issues` (zod), `retryAfter` (cooldown), and pagination-adjacent fields already sent. No stack traces, no driver diagnostics, no 500-with-details.
- Ordering guarantee: validation errors (400) precede auth (401) precede permission (403) precede existence (404) precede conflict/cooldown/duplicate (409/429), so a request with two problems reports the earliest-stage one deterministically.
- DB-unavailable behavior: memory fallback paths keep their current status codes and gain the same `code` values; `novelExists-unknown` in DB mode returns 503 `تعذر التحقق` instead of masking.
- Rate-limit vs. cooldown disambiguation is the point of the `cooldown`/`rate_limited` split: the app retries cooldowns after `retryAfter` and backs off on `rate_limited` without showing the generic failure that masked the second-POST 429 in the reported bug.

### 8. Avatar policy

- Source of truth: `users.avatar_url` (nullable text URL). Live on every DB read; snapshot in memory mode.
- Writers: Google login heals only when the stored value is missing; `PATCH /me` sets/clears explicitly (null clears). No server-side fetch, proxy, or resize of avatar bytes.
- Readers: `author: { id, name, avatarUrl? }`; `avatarUrl` omitted (not empty string) when null; `name` falls back `displayName || username || 'مستخدم'`; deleted-user rows serialize `{ id: 'deleted', name: 'مستخدم محذوف' }` with no avatar key.
- Client guidance (documented, not enforced): refresh the avatar after a Google picture change via re-login or `PATCH /me`; render a default avatar when `avatarUrl` is absent.

## Files To Change

The following are implementation-design targets, **not changes authorized by this document-writing task**:

| File | Proposed change and acceptance criteria |
| --- | --- |
| `src/routes/comments.ts` | Chapter inheritance on reply (`effectiveChapter`); `parseCommentId` on all `:id`/`:commentId` params; `code` on every error per §2; FK-safe `novelExists` tri-state; unified `buildAuthorLookup` used by list/previews/replies/mod/admin; transactional counter writes (insert+bump, vote, delete, report); preview-per-root fetch replacing `LIMIT(roots*2+10)` trim; true replies total; `private`/`no-store` cache headers on personalized reads + `Vary: Authorization`; single cached `getCaller` per request; Workers-safe cursor codec. Acceptance: all endpoint behaviors in §5 hold. |
| `src/middleware/rateLimit.ts` | Comments-path 429 body gains `{ success: false, code: 'rate_limited', error: 'too many requests' }` without changing budgets or window. Acceptance: a throttled comments POST returns the coded body. |
| `src/middleware/ownership.ts` | Support context-cached caller (`c.get('caller')` short-circuit) consumed by comments handlers; `getCaller` semantics otherwise unchanged. Acceptance: one user lookup per comments request (assertable via query counter/spy in tests). |
| `src/routes/comments.test.ts` (extend) | Memory-mode API tests: chapter inheritance (reply without chapter lands in parent scope and lists under `?chapter=N`), explicit-mismatch 400 with `chapter_mismatch`, both id formats on edit/delete/vote/report/replies, `code` on cooldown/duplicate/invalid-id paths, replies true total, preview length ≤2 per root, cache-header assertions, avatar snapshot rule. |
| `src/routes/comments.unit.test.ts` (new) | Pure-helper tests: `parseCommentId` matrix (`123`, `app_123`, garbage), Workers-safe cursor round-trip incl. pre-fix vectors and garbage rejection, chapter-inheritance resolver, error-code table completeness (every Arabic message maps to exactly one code). No I/O. |

`src/database/schema.ts`, `drizzle/*`, `src/routes/auth.ts`, `src/routes/googleAccount.ts`, `src/routes/upload.ts`, `src/app.ts`, `src/worker.ts`, `wrangler.toml`, and the entire app repository need no functional edits. No dependency addition is required.

## Testing Strategy

Use Vitest with local Hono `app.request` in open/memory mode plus pure-helper suites; DB-path tests use the existing isolated-PostgreSQL harness pattern (no live Neon, no real Google credentials, no production storage).

Required cases:

1. Chapter scoping: root POST with `chapterNumber: 72` then list without `?chapter` excludes it; list with `?chapter=72` includes it; reply with `parentId` and no `chapterNumber` inherits 72 and appears under `?chapter=72`; reply with explicit mismatched chapter returns 400 `chapter_mismatch`; chapter-less list/count default stays novel-only.
2. Failure taxonomy: force cooldown (second immediate POST) → 429 `cooldown` with numeric `retryAfter`; duplicate body → 409 `duplicate`; `app_<id>` and `<id>` both succeed on PATCH/DELETE/vote/replies; garbage id → 400 `invalid_id`; garbage cursor → 400 `invalid_cursor`; missing novel (DB mode, seeded absence) → 404 `novel_not_found`, never 500; every error body keeps its Arabic `error` string and carries the exact `code` from §2.
3. Avatars: seed two users with distinct `avatarUrl`s; list shows both root and preview-reply avatars (no `{name:'مستخدم'}` fallback for existing users); replies page shows avatars; `modTransition` hide/restore response carries the real author; `PATCH /me` avatar change is reflected on the next list fetch (live rule); memory mode keeps POST-time snapshot.
4. Correctness: reply POST bumps parent+root `repliesCount` exactly once each (deduped when parent is root); vote toggle `1 → -1 → 0` converges `likesCount`; delete decrements without going negative; report threshold flips to `pending` at 3; preview arrays hold the oldest ≤2 visible children per root even when one root has many children; replies `total` equals the full visible-children count, not the page length.
5. Caching/caller/cursor: authenticated list sends `private` (or `no-store` for moderator-filtered views) with `Vary: Authorization`; anonymous visible-only list and count keep `public`; caller lookup executes once per request; pre-fix cursor strings still decode; malformed cursors 400.
6. Regression: the existing full-flow memory test (post/reply/list/replies/edit/vote-guard/delete/count), invalid-cursor, cross-novel-parent, and link-spam-pending cases keep passing with the new `code` fields present.

Implementation acceptance requires `npm run typecheck`, `npm test`, and `npm run build`, all exiting 0. This specification commit runs none of these.

## Risks And Mitigations

1. **Chapter-inheritance change routes a reply into a scope the client never displays.** A client that posts replies without `chapterNumber` and lists only the novel wall would see replies "disappear" into the chapter scope. *Mitigation:* inheritance matches the parent's scope by construction (a reply is always listed alongside its root under the same `?chapter=` the client used to fetch the root); the scope rule is documented per endpoint; tests pin list-with-chapter visibility for inherited replies.
2. **Per-root preview fetch multiplies queries (up to 50 tiny lookups per list page).** *Mitigation:* each lookup is a bounded (LIMIT 2) index scan on the existing `comments_thread` index with page-size cap 50; no new index or migration; the over-fetch bug it replaces was already issuing a wide scan plus wrong results, so p99 cost is comparable and correctness is strictly better.
3. **Transactional writes contend under vote storms (unique-guard + counter in one txn).** *Mitigation:* transactions are single-row, short-lived, and rely on the existing `(commentId, userId)` unique constraint for convergence; no long-held locks, no new retry storms introduced; budgets (rate limits) already bound per-client write rates.
4. **`code` additions break a strict client parser.** *Mitigation:* additive-only change — no field removed, no Arabic string reworded, no status code renumbered; `success/error` shape preserved; both id formats accepted so old clients need no update; tests assert the old fields byte-for-byte alongside the new `code`.
5. **Cursor codec rewrite invalidates outstanding cursors.** *Mitigation:* wire format pinned (`base64url(JSON({t,i,s?}))`); the new codec is verified against pre-fix vectors in tests; garbage still maps to the same 400, so worst case is a client restarting pagination, not an error leak.

## Decision Summary

- List/count without `?chapter=` stays novel-level (`chapterNumber IS NULL`); replies inherit the parent's chapter when omitted, explicit mismatch still 400.
- Every failure carries a stable machine-readable `code` alongside its unchanged Arabic message and HTTP status; `cooldown` (with `retryAfter`) and `rate_limited` are distinct; `success/error` shape preserved.
- All `:id`/`:commentId` params accept both `123` and `app_123` via `parseCommentId`; malformed ids yield `invalid_id`.
- `novelExists` becomes FK-safe tri-state: missing novel → clean 404, DB error → 503, never a masked 500.
- One unified author batch covers roots, previews, replies, mod, and admin responses; DB reads are live off `users.avatar_url`, memory mode is a documented POST-time snapshot; `modTransition` returns the real author.
- Counters (insert+bump, vote toggle, delete, report) are transactional; previews guarantee oldest-2-visible per root; replies `total` is the true count.
- Personalized list responses drop `public` (`private`/`no-store` + `Vary: Authorization`); anonymous visible-only list and count keep `public`.
- One `getCaller` per request (context-cached); cursor codec becomes Workers-safe with identical wire format.
- Deferred with rationale: no Redis, no index migration, no avatar upload endpoint.

## Assumptions And Open Questions

- Assumed: cooldown/daily-cap/depth/edit-window/report-threshold values and rate-limit budgets are product-fixed and unchanged by this spec.
- Assumed: `app_` is the only id prefix in the wild; double-prefixed (`app_app_1`) values are treated as `invalid_id`, not unwrapped twice.
- Assumed: per-request `count(*)` on the list endpoint is acceptable (unchanged); only the replies-`total` lie and the preview over-fetch are fixed.
- Open question for the plan phase (not a spec gap): preview fetch shape — N bounded per-root queries vs. a single window-function query; either satisfies the contract, the plan author picks one.
- Open question for a later phase: whether clients adopt the new `code`/`retryAfter` fields for tailored UI (countdown on cooldown, backoff on rate-limit) — server behavior is complete without it.
