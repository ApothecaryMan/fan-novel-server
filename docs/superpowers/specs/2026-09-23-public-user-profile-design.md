# Public User Profile Endpoint: Design

**Date:** 2026-09-23
**Status:** Approved brainstorm scope (approach: new public `GET /api/v1/users/:id/profile`); audited design specification (specification only, no product code)
**Repositories:** server `/home/x1carbon/Projects/fan-novel-server` (primary, edited)
**Runtime:** Cloudflare Workers + Hono + Drizzle + Neon Postgres
**Scope:** Server-side public profile endpoint only. No app-repo changes.

## Goal

Add a public, unauthenticated `GET /api/v1/users/:id/profile` endpoint so that tapping a user avatar in server-novel comments (or anywhere else) resolves that author's live public identity plus two totals — visible comment count and total likes received — instead of the mobile app falling back to `comments=0, likes=0` because the only existing profile route (`GET /api/v1/users/me/profile`) requires the viewer's own Bearer token and the comments list only ships `author { id, name, avatarUrl }` with no counts.

## Non-Goals

- Any change to the existing private `GET /api/v1/users/me/profile` response shape, auth requirement, or level/library/history/session stats. It keeps working byte-for-byte.
- Any change to comments routes (`src/routes/comments.ts`): no new counts embedded in `authorOf`/`toApi`/`buildAuthorLookup`, no change to list/count/replies/vote/report/moderation behavior, cache headers, or id format.
- Any new auth, follow, block, messaging, or activity-feed feature; no follower counts, no novel lists, no reading history exposure for other users.
- Any PII exposure: `email` (and any token/session data) is never returned on the public route.
- Any migration, schema change, new index, or dependency addition. The `comments_user` index on `(user_id, created_at, id)` already covers the aggregate filter.
- Any Redis work, R2/avatar-upload work, or change to rate-limit budgets (the existing `/api/v1/users/*` 30-window applies unchanged).
- Any mobile-app changes and no live-Neon command, migration run, deployment, or live test as part of this specification-only change.

## Context

- Private profile (`src/routes/profile.ts:129-182`): `profileRouter.get('/me/profile', requireAuth, ...)` resolves the caller's Bearer `sub` to a `users` row via `WHERE external_id = sub`, then fans out to `userLibrary` / `readingHistory` / `readingSessions` counters plus level/streak math. Its `toPublic(u)` helper (lines 129-138, mirrored in `src/routes/auth.ts:30-39`) returns `{ id: externalId ?? id, externalId: externalId ?? id, email, name: displayName ?? null, username, avatarUrl, bannerUrl, bio, status: bio ?? null, role, isAuthor, isTranslator, provider: 'google' }`. Note the inherited quirk `status` mirrors `bio`; the public route preserves this mapping unchanged (out of scope to fix here).
- Routing (`src/app.ts:37,118`): `app.use('/api/v1/users/*', rateLimit(30))` already covers any new sub-path; `app.route('/api/v1/users', profileRouter)` mounts the router. The `/api/v1` index lists `userProfile: 'GET /api/v1/users/me/profile'` (line 159) and needs a second entry.
- Identity columns (`src/database/schema.ts:6-22`): `users.id` is a random UUID primary key; `users.externalId` is unique and holds values like `google_<verified sub>` (production) or `dev_<email>` (dev fixtures). Comments store the resolved UUID (`comments.userId` references `users.id`, set-null on delete) and serialize it as `author.id` (`authorOf`, `src/routes/comments.ts:157-171`). Therefore the mobile app may hold **either** form: a raw UUID (from a comment author chip) or an externalId (from its own session). The new route must accept both.
- Comment stats source (`src/database/schema.ts:187-214`): `comments` rows carry `userId`, `status` (`visible|pending|hidden|deleted`), and denormalized `likesCount`. `likesReceived` is defined as `COALESCE(SUM(likes_count), 0)` over the author's **visible** rows — not a join against `commentVotes` (which would double-count vote rows and miss the denormalized convergence contract). `commentsCount` is `COUNT(*)` over the same filtered set, so replies are included (every reply is a comment row).
- Anonymous cache precedent (`src/routes/comments.ts:420,529,549,559`): anonymous visible-only reads send `Cache-Control: public, max-age=60, stale-while-revalidate=60`. The public profile is anonymous-visible-only by construction, so it reuses exactly that header.
- Error precedent: private profile returns 401 `account not found` for unknown caller and 503 `account storage unavailable` on DB failure without leaking driver detail (`noteDbFailure()` + `console.warn` with `requestId`, no error text in body). The public route mirrors the 503 pattern and uses 404 for unknown users.
- Memory fallback (`src/routes/auth.ts:15,81-100,123-126`): when the DB is unavailable in non-prod, accounts live in the module-level `memUsers` array keyed by `externalId` (with `id` equal to `externalId` for memory-created users). There is no memory comment store joined to users, so per-user comment totals are unavailable in that mode.
- Test harness (`src/routes/profile.test.ts`, `src/test/identityDb.ts`): `identityDb()` fakes only the `users` table (any non-`users` table query returns `[]`, and `matches()` throws `unexpected test query` for unrecognized `users` columns). The public-route tests therefore require extending the fake with a `comments` table supporting `COUNT` + `SUM(likes_count)` filtered by `user_id` + `status`, or an equivalent seam the plan author chooses.

## Proposed Architecture

### 1. Route, method, auth, and ordering

- **Decision: `GET /api/v1/users/:id/profile` on `profileRouter`, public (no `requireAuth`), registered AFTER the existing `/me/profile` route.** Rationale: Hono matches in registration order, and `/:id/profile` would otherwise capture the literal `me` segment (`/me/profile` vs `/:id/profile` collision). Placing the static route first preserves the private route byte-for-byte with zero behavior change. The existing `/api/v1/users/*` rate-limit (30) applies automatically with no middleware edit.
- **Decision: `Cache-Control: public, max-age=60, stale-while-revalidate=60` on success, no `Vary: Authorization`.** Rationale: the body contains no per-caller data (unlike personalized comments lists, which must be `private`), so it is safe for shared caches; the 60s TTL matches the anonymous comments-list/count precedent and bounds staleness after a `PATCH /me` rename/avatar change.

### 2. Param resolution (uuid OR externalId)

- **Decision: `:id` accepts `users.id` (UUID) or `users.externalId` (`google_<sub>`, `dev_<email>`); resolution is trimmed exact-match, UUID first, externalId second.** Algorithm:
  1. `raw = c.req.param('id').trim()`; empty string yields 400 `invalid_id` (see §4).
  2. If `raw` matches UUID syntax (case-insensitive hex `8-4-4-4-12`), `SELECT ... FROM users WHERE id = raw LIMIT 1`; on hit, that row is the subject.
  3. Otherwise (or on UUID miss), `SELECT ... FROM users WHERE external_id = raw LIMIT 1`; on hit, that row is the subject.
  4. No hit on either lookup yields 404 `user_not_found`.
- Rationale: two indexed unique-column point lookups (primary key, then unique `external_id`), no `OR` predicate, no `LIKE`, no case folding. UUID-first avoids a wasted externalId probe for the common comment-tap path (comment `author.id` is the UUID). Falling through from UUID-miss to externalId covers the theoretical collision where an externalId happens to be UUID-shaped. `username` is deliberately NOT accepted: handles are mutable and non-canonical, and accepting them would expand enumeration surface.
- **Decision: no UUID-syntax rejection.** A syntactically invalid UUID is simply not a UUID — it flows to the externalId lookup and then to 404 rather than 400. Only the empty/whitespace-only param is 400. Rationale: avoids leaking which id space a value belongs to and keeps one deterministic rule.

### 3. Response shape (public-safe subset + two stats)

- **Decision: `200 { success: true, user: {...}, stats: { commentsCount, likesReceived } }` where `user` is the existing `toPublic()` output minus `email`.** Exact keys:
  - `user`: `{ id, externalId, name, username, avatarUrl, bannerUrl, bio, status, role, isAuthor, isTranslator, provider: 'google' }` with the same null-coalescing as today (`name: displayName ?? null`, `status: bio ?? null` preserved as-is). `email` is omitted entirely (key absent, not null) so cached public responses can never leak PII.
  - `stats`: `{ commentsCount: number, likesReceived: number }`, both non-negative integers.
- Rationale: reusing `toPublic()` minus one field keeps the app's existing user-chip parsing working (same key names, same `id`/`externalId` canonicalization `externalId ?? id`) while closing the PII hole; a shared `toPublicUser(isPublic)` helper or inline destructure-strip is the plan author's choice, with the acceptance that `email` is absent from the wire body.
- **Decision: one aggregate stats query on the resolved UUID:** `SELECT COUNT(*) AS commentsCount, COALESCE(SUM(likes_count), 0) AS likesReceived FROM comments WHERE user_id = <resolved users.id> AND status = 'visible'`. Only `visible` rows count — `pending`/`hidden`/`deleted` are excluded, matching what readers can actually see. Replies are included (they are visible comment rows authored by the user). Orphaned rows (`user_id IS NULL` after account deletion) belong to no profile and never match a resolved UUID.

### 4. Errors (shape, codes, status)

- **Decision: error bodies are `{ success: false, code, error }` with existing-style lowercase string errors, no stack/driver detail:**
  - `400 { success: false, code: 'invalid_id', error: 'invalid user id' }` — empty/whitespace-only `:id` only.
  - `404 { success: false, code: 'user_not_found', error: 'user not found' }` — neither UUID nor externalId matched (both DB and memory modes).
  - `503 { success: false, code: 'account_unavailable', error: 'account storage unavailable' }` — DB threw during user or stats lookup; handler calls `noteDbFailure()`, logs the `console.warn` storage event with `requestId`, and never echoes driver text (same pattern as `/me/profile`).
- Rationale: `code` gives the app a machine-readable branch (show "user not found" vs retry-later) while the 404/503 split matches HTTP semantics; 503 (not 500) signals transient storage failure consistent with the rest of the users surface. Error responses set no public cache header (no `Cache-Control: public` on 4xx/5xx).

### 5. Memory fallback (no DB, non-prod)

- **Decision: when `!isDbAvailable()`, resolve against the `memUsers` array by `externalId` match first, then `id` match; unknown yields the same 404 `user_not_found`; known yields the public-safe user object with `stats: { commentsCount: 0, likesReceived: 0 }`.** In production (`getEnv().isProd`) with no DB, return the same 503 as the DB-failure path. Rationale: mirrors the `auth.ts` memory semantics (dev fixtures keyed by `externalId`), returns an honest zero rather than a fabricated count (the memory comment store is not joined to users), and keeps prod behavior fail-closed.

### 6. Docs index update

- **Decision: extend the `/api/v1` index `endpoints` map with `userPublicProfile: 'GET /api/v1/users/:id/profile'` while keeping the existing `userProfile: 'GET /api/v1/users/me/profile'` entry unchanged.** Rationale: additive discovery for clients; no existing key renamed.

## Files To Change

| File | Proposed change and acceptance criteria |
| --- | --- |
| `src/routes/profile.ts` | Add public `GET '/:id/profile'` handler AFTER the existing `/me/profile` route: dual uuid/externalId resolution per §2, public-safe user projection (existing `toPublic` minus `email`), single aggregate stats query per §3 filtered to `status = 'visible'`, `Cache-Control: public, max-age=60, stale-while-revalidate=60` on success, error mapping per §4, memory fallback per §5, 503 path via `noteDbFailure()` with no leak. Acceptance: all behaviors in §§1-5 hold; `/me/profile` untouched. |
| `src/routes/profile.test.ts` (extend) | Cover: resolve by UUID; resolve by externalId (`google_<sub>`); `commentsCount` counts visible only (seeded pending/hidden/deleted rows excluded); `likesReceived` equals sum of `likes_count` over visible rows (null/zero-safe); `email` key absent from body; unknown id yields 404 `user_not_found`; empty param yields 400 `invalid_id`; success carries the exact public cache header; DB failure yields 503 without leaking. Requires extending the `identityDb` fake (or equivalent seam) with a `comments` table aggregate. Acceptance: each case asserts status + `code` + body shape. |
| `src/app.ts` | Add `userPublicProfile: 'GET /api/v1/users/:id/profile'` to the `/api/v1` index `endpoints` map; keep `userProfile` entry unchanged. Acceptance: index lists both entries. |

`src/database/schema.ts`, `drizzle/*`, `src/routes/comments.ts`, `src/routes/auth.ts`, `src/middleware/*`, `src/worker.ts`, and `wrangler.toml` need no functional edits. No dependency addition is required.

## Testing Strategy

Use Vitest with local Hono `app.request` against the `profileRouter` mounted at `/users` (same harness as `src/routes/profile.test.ts`); DB-path tests use an extended isolated fake (no live Neon, no real Google credentials, no production storage).

Required cases:

1. **Resolution:** seed a user with known UUID `u1` and `externalId: 'google_sub1'`; `GET /users/<u1>/profile` and `GET /users/google_sub1/profile` both return 200 with identical `user.id`/`user.externalId`; unknown UUID and unknown external string both return 404 with `code: 'user_not_found'`.
2. **Visibility filter:** seed visible ×2 (one root, one reply), pending ×1, hidden ×1, deleted ×1 for the same author; `stats.commentsCount` equals 2.
3. **Likes sum:** visible rows with `likes_count` 3 and 5 plus a hidden row with `likes_count` 100; `stats.likesReceived` equals 8. Author with zero visible rows yields `{ commentsCount: 0, likesReceived: 0 }` (verifies `COALESCE`).
4. **PII omission:** every 200 body has no `email` key at any depth (`expect(body.user).not.toHaveProperty('email')` plus a serialized-text check that the user's email string appears nowhere).
5. **Headers and errors:** 200 carries exactly `public, max-age=60, stale-while-revalidate=60`; whitespace-only id yields 400 `invalid_id`; forced DB failure yields 503 `account_unavailable` with no driver text in the body.
6. **Regression:** existing `/users/me/profile` tests (fresh-account level payload, 401-without-token, 503-without-leak) keep passing unchanged.

Implementation acceptance requires `npm run typecheck`, `npm test`, and `npm run build`, all exiting 0. This specification commit runs none of these.

## Risks And Mitigations

1. **Route-order collision (`/:id/profile` swallowing `/me/profile`).** A misordered registration would route private-account reads into the public handler (auth bypass appearance, wrong stats). *Mitigation:* static `/me/profile` registered first is pinned as an explicit acceptance criterion and covered by the unchanged regression tests hitting `/users/me/profile` with a Bearer token.
2. **Email leak via shared serializer.** Reusing `toPublic()` verbatim would ship `email` into a publicly cacheable body. *Mitigation:* the public projection strips `email` (key absent) with a dedicated test asserting absence in both parsed body and serialized text; code review checks the strip survives future `toPublic` field additions (public helper allow-lists fields rather than spreading).
3. **User enumeration via 404 oracle.** Distinct 404/200 lets anyone probe which externalIds exist. *Mitigation:* accepted and proportionate — returned data is already public (display name, avatar, comment totals visible in comments UI); rate limiting (`/api/v1/users/*` 30-window) bounds bulk probing; no PII is returned on hit.
4. **Stale cache after profile edits.** The 60s public TTL means a `PATCH /me` rename/avatar change lags up to a minute on the public route. *Mitigation:* matches the existing anonymous comments-list staleness contract clients already tolerate; no purge infrastructure needed for two small counters; TTL is pinned in tests so a future change is deliberate.

## Decision Summary

- New public `GET /api/v1/users/:id/profile` (no auth) on `profileRouter`, registered AFTER `/me/profile`; existing `/api/v1/users/*` rate limit (30) applies with no middleware change.
- `:id` accepts UUID (`users.id`) or externalId (`users.externalId`) via trimmed exact-match, UUID lookup first then externalId; empty param is 400 `invalid_id`, no match is 404 `user_not_found`; malformed UUIDs fall through to externalId lookup, never 400.
- `200 { success: true, user, stats: { commentsCount, likesReceived } }`; `user` is the existing `toPublic()` shape minus `email` (key absent); `status` mirrors `bio` unchanged.
- Stats come from one aggregate over `comments` on the resolved UUID with `status = 'visible'` only: `COUNT(*)` and `COALESCE(SUM(likes_count), 0)`; replies included, pending/hidden/deleted excluded.
- Success sends `Cache-Control: public, max-age=60, stale-while-revalidate=60` with no `Vary: Authorization`; DB failure sends 503 `account_unavailable` via `noteDbFailure()` with no leaked detail.
- No-DB memory mode resolves `memUsers` by externalId-then-id, returns zeros for stats, 404 for unknown; prod without DB returns 503.
- `/api/v1` index gains `userPublicProfile` alongside the unchanged `userProfile` entry; `/me/profile`, comments routes, schema, and migrations are untouched.

## Assumptions And Open Questions

- Assumed: comment `author.id` values held by existing mobile clients are `users.id` UUIDs (per `authorOf`), so UUID-first resolution optimizes the dominant tap path; externalId support covers session-derived ids.
- Assumed: `identityDb` fake extension for the `comments` aggregate is acceptable test scaffolding; the plan author may instead introduce a query seam, provided the same assertions hold.
- Assumed: `username`-based lookup stays out; if product later wants handle URLs, that is a separate spec (mutability + enumeration review).
- No open questions blocking the plan; the spec is complete as written.
