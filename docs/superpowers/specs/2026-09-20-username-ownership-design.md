# Username Ownership: Design

**Date:** 2026-09-20
**Status:** Approved brainstorm scope; audited design specification (specification only, no product code)
**Repositories:** server `/home/x1carbon/Projects/fan-novel-server` (primary, edited); app `/home/x1carbon/Projects/Fan Novel` (read-only reference, untouched)
**Runtime:** Cloudflare Workers + Hono + Drizzle + Neon Postgres
**Scope:** Server-side username-ownership change only. No app-repo changes.

## Goal

End server invention of usernames: new accounts created through Google login receive no auto-filled username (only a display name derived from the Google account), the username becomes a strictly user-chosen handle set either explicitly at creation or through `PATCH /api/v1/auth/me`, taken names fail closed with machine-usable alternative suggestions produced by a bounded deterministic slug generator, and all rows that already carry an auto-generated username keep working exactly as before with no backfill, rename, or data rewrite.

## Non-Goals

- Any backfill, forced rename, normalization, or deletion of existing `users` rows, including rows whose username was auto-generated.
- Any change to the `Fan Novel` app repository: no edits to `app/profile-setup.tsx`, `src/store/googleProfileMerge.ts`, `src/components/auth/GoogleAuthModal.tsx`, `src/services/api.ts`, or string tables. Suggestion display in the app UI is a future app-side adoption, not part of this design.
- Case-insensitive username uniqueness, username reservation/hold TTLs, username history, or username change rate-limiting beyond the existing route rate limits.
- Live-handle search, directory, prefix-enumeration, or any endpoint that reveals usernames other than the single name the caller asked about.
- Any change to `ADMIN_EMAILS`/bootstrap-admin behavior, session/token shape, Google token verification, sync semantics, comments, novels, uploads, decorations, R2, billing, or Cloudflare configuration.
- Any database migration: none is required (see Context — the column is already nullable) and none is authorized.
- Executing any live-Neon command, migration, deployment, or live test as part of this specification-only change; release gates are documented but not executed here.

## Context

- Identity is hardened (`src/routes/googleIdentity.ts` verified subject + lowercased email; `src/routes/googleAccount.ts:resolveGoogleAccount` provisions by `googleSubject` with canonical external ID `google_<verified sub>`, single-insert atomicity, 409 on uniqueness conflicts). Session JWTs carry `sub = users.externalId` (`src/middleware/auth.ts`, `src/routes/auth.ts`).
- The auto-generation under removal lives in exactly two server places plus one fixture path:
  - `src/routes/googleAccount.ts:35-38`: `displayName = input.name || input.username || identity.email.split('@')[0]` and `username = (input.username || displayName).slice(0, 100)` on insert. The conflict-recovery branch (lines 48-57) never writes; the returning-user patch branch (lines 60-65) heals only email, admin role, and missing media — it never touches username or displayName.
  - `src/routes/sync.ts:89-98` (`provisionUser`, reachable only when `!getEnv().isProd`): invents `username = user_<sanitized externalId>`.
  - `src/routes/auth.ts:69-84` in-memory dev/test fixture path (`memUsers`): `username = input.username || displayName` mirroring the same invention for absent-token fixtures.
- `users.username` is already nullable with a unique constraint: `src/database/schema.ts:11` declares `username: varchar('username', { length: 100 }).unique()` with no `.notNull()`, and `drizzle/0000_sync.sql` creates it as plain `"username" varchar(100)` plus a `UNIQUE` constraint. PostgreSQL treats NULLs as distinct under a unique constraint, so any number of username-less rows coexist. No `0008` migration is needed; the journal (`drizzle/meta/_journal.json`, `idx 0..6`) stays untouched and committed history is never edited.
- Current `PATCH /me` (`src/routes/auth.ts:112-172`): `USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/` (line 28), exact-match clash pre-check returning 409 `اسم المستخدم محجوز بالفعل` (lines 142-145), then a single `UPDATE ... RETURNING` (line 151) — fail-closed with no partial writes. `accountError` (lines 40-46) maps any `isUniqueConflict` to a generic 409 `account identity conflict`.
- Current `toPublic` (`src/routes/auth.ts:30-38`) resurrects fallbacks: `name: u.displayName ?? u.username ?? u.name` and `username: u.username ?? u.name`. These fallbacks are the "auto-username" surface for username-less rows and must stop (authoritative responses carry null, never an invented handle).
- Display-only username fallbacks that stay unchanged: `src/routes/comments.ts` (`displayName || username || 'مستخدم'`, lines 204/411/539/916) renders a human label and confers no identity; `src/routes/admin.ts:23` exposes the raw nullable column.
- App already handles missing usernames with no edits required (verified read-only): `isReturningServerAccount` (`Fan Novel/src/store/googleProfileMerge.ts:105-109`) returns false for null/blank usernames; `GoogleAuthModal.finishLogin` routes username-less accounts to `startProfileSetup` as a non-secret draft; `app/profile-setup.tsx:91-131` saves via `ApiService.updateMe` (`PATCH /me`) under the already-validated session and maps 409 to the `auth.usernameTaken` error while preserving the draft; `ApiService.updateMe` throws `ApiError(kind, message, status)` and ignores unknown response fields, so an added `suggestions`/`code` field on 409 responses is backward compatible.
- Rate-limit convention (`src/app.ts:35`): `/api/v1/auth/*` runs `rateLimit(30)`. Any new auth-namespaced endpoint inherits this automatically.
- Release discipline (`docs/superpowers/runbooks/phase1-security-release.md`) applies to database changes. This design makes no database change, so the migration/deployment gates do not trigger; the read-only health/emptiness probes may still be used unchanged as pre-release sanity checks, and no live-Neon write is authorized in any phase of this work.

## Proposed Architecture

### 1. Creation without invention (`resolveGoogleAccount`)

- On the insert path, `username` is set exclusively from an explicitly supplied, valid, available `input.username`; otherwise it is inserted as `NULL`. `displayName` (the display name, not a handle) is `input.name || identity.email.split('@')[0]`, sliced to 100 chars. The email-prefix fallback now feeds only the display name, never the username.
- Explicit-username acceptance rule at creation: the supplied value must match `USERNAME_RE`; a value that fails the regex yields 400 (invalid payload), never a silent null and never a mutation. A value that passes the regex but is held by another row yields 409 `username_taken` with suggestions (same body shape as §4). A pre-insert exact-match `SELECT` provides the fast path; the unique-constraint violation path is the correctness backstop (see §6 for distinguishing it from identity conflicts).
- The conflict-recovery branch stays write-free: on `isUniqueConflict` during insert, re-read by `googleSubject`; if the committed row's email matches, return it (idempotent race winner) without healing anything; otherwise 409 identity conflict, unchanged. If the unique violation was caused by the requested username colliding with a different row (no committed row for this subject), return 409 `username_taken` with suggestions instead of the generic identity-conflict message.
- The returning-user patch branch stays username-blind: it continues to heal only email, bootstrap-admin role, and missing media. A returning login never sets, changes, or clears a username, whether null or grandfathered.
- Request validation (`googleSchema` in `auth.ts`): the `username` field is constrained to `USERNAME_RE` at the schema level so invalid handles are rejected with 400 before reaching provisioning. `name` keeps its current `max(100)` rule.

### 2. Fixture and sync provisioning without invention

- `memUsers` fixture path (`auth.ts:69-84`): `username =` the explicit `input.username` when it matches `USERNAME_RE`, else `null`. `displayName` keeps its existing fallback chain. The fixture-update branch only overwrites username when an explicit valid value is supplied.
- `provisionUser` (`sync.ts:89-98`, non-production only): inserts `username: null` instead of the `user_<...>` fabrication. Rationale: even a dev-only invention trains clients to expect server-chosen handles and would diverge from production behavior; null matches production exactly.

### 3. Unique Slug Generator (pure, bounded, deterministic)

- New pure helper module (no I/O of its own): `normalizeUsernameCandidate(raw)` and `suggestUsernames(base, isTaken)`.
- Normalization: trim surrounding whitespace; reject (not repair) anything outside `USERNAME_RE` — the HTTP layer returns 400 with no suggestions for invalid input, because suggesting variants of a name that violates policy would leak policy-probing and invite bypass confusion. Lower-casing is not applied: uniqueness stays exact-match, preserving grandfathered mixed-case rows and avoiding a semantics change (see Decision Summary).
- Suggestion loop, given a valid taken base: probe candidates in fixed order — `base_1`, `base_2`, … — where each candidate is formed by truncating `base` so that `base + '_' + n` fits 20 characters and still matches `USERNAME_RE`. Collect up to `MAX_SUGGESTIONS = 3` candidates for which `isTaken` is false, stopping after `MAX_PROBES = 20` database probes regardless of how many were collected. Both bounds are constants in one place. The sequence is deterministic: same base and same table state always yield the same list.
- The `isTaken` callback is a single-row exact-match existence check (`SELECT id ... WHERE username = ? LIMIT 1`), executed by the route handler against Drizzle, never string-interpolated. Total per-request database cost is bounded: 1 availability check + at most 20 suggestion probes, all indexed point lookups on the existing unique index — no new index required.
- No-enumeration property: the only name the caller learns anything about is the name they supplied (taken vs. free) plus up to three synthetic `base_n` variants generated by the server, which are confirmed-free at generation time. There is no search, prefix, list, or batch-check interface, and the endpoint accepts exactly one candidate per request.

### 4. Live uniqueness endpoint and PATCH conflict shape

- New route `GET /api/v1/auth/username/availability?username=<candidate>` under the existing auth router (inherits `rateLimit(30)`). Authentication: `requireAuth` (the profile-setup caller always holds a validated session at the point it needs this — the single exchange already happened before routing to setup — and requiring auth keeps the check from becoming an unauthenticated enumeration oracle).
- Semantics: 400 when the candidate fails `USERNAME_RE` (body `{ error }`, no `suggestions`); 200 `{ available: true, suggestions: [] }` when free; 200 `{ available: false, suggestions: [...] }` with up to 3 generator outputs when taken (200 rather than 409 because a taken result on a routine live-check is an expected answer, not an error, and it keeps the app's 409-error toast mapping from firing during typing); 401/503 follow the existing `requireAuth`/storage conventions (`account storage unavailable`, never driver diagnostics).
- `PATCH /me` conflict behavior: the exact-match pre-check stays, but its 409 body becomes `{ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions: [...] }`. The single-`UPDATE` structure is unchanged — fail closed, no partial writes: on conflict nothing is written, including the accompanying `name`/media fields in the same payload.
- Race backstop on update: if the `UPDATE` itself raises a unique violation (lost the pre-check race), the handler distinguishes a username collision from an identity collision by re-reading the username holder; a foreign holder yields the same 409 `username_taken` + suggestions body, while a genuine identity conflict keeps the existing generic 409. `accountError`'s blanket `isUniqueConflict → account identity conflict` mapping must therefore not swallow the username case: the PATCH handler resolves username collisions before delegating to `accountError`.

### 5. `toPublic` null contract

- `toPublic` returns `username: u.username ?? null` and `name: u.displayName ?? null`. The `?? u.name` fallbacks are removed. Rationale: any fallback in an authoritative response re-invents a handle for username-less accounts and would break the app's `isReturningServerAccount` routing (a fabricated non-empty username would skip profile setup). Display rendering without a name is the app's existing fallback territory (initials/Google data), not the server's.
- Affected responses: `POST /api/v1/auth/google` (provisioned + fixture branches), `GET /api/v1/auth/me`, `PATCH /api/v1/auth/me`. All three share the one `toPublic` function, so the change is atomic.
- Grandfathered rows are unaffected in practice: their stored username is non-null and continues to serialize exactly as today.

### 6. Conflict disambiguation (creation and update races)

- Two distinct 409 meanings share the `23505` code: identity collisions (externalId/googleSubject/email) vs. username collisions. Decision: never collapse them into one message. Identity collisions keep `account identity conflict`; username collisions return `code: 'username_taken'` plus suggestions. Disambiguation is by targeted re-read (holder of the conflicting username vs. row for the subject), never by parsing driver error text.
- Bounded-transaction rule: every write stays a single statement (`INSERT ... RETURNING` / `UPDATE ... RETURNING`); suggestion probes are read-only and run only after the conflicting write has failed or the pre-check has found a clash, so suggestions can never be persisted accidentally.

## Files To Change

The following are implementation-design targets, **not changes authorized by this document-writing task**:

| File | Proposed change and acceptance criteria |
| --- | --- |
| `src/routes/googleAccount.ts` | Insert path sets `username` only from an explicit valid available `input.username`, else `NULL`; `displayName` falls back to the email prefix. Creation 409 disambiguates username-taken (with suggestions) from identity conflict. Returning-user patch branch remains username-blind. No other behavior changes. |
| `src/routes/auth.ts` | `googleSchema.username` constrained to `USERNAME_RE` (400 on invalid); `toPublic` returns `username: u.username ?? null`, `name: u.displayName ?? null` with no `u.name` fallbacks; `PATCH /me` 409 body gains `code: 'username_taken'` + `suggestions` while keeping the single-`UPDATE` fail-closed structure; update-race unique violations disambiguated before `accountError`; `memUsers` fixture path stops inventing usernames. New `GET /username/availability` route behind `requireAuth` (inherits the existing `/api/v1/auth/*` rate limit). |
| `src/routes/usernames.ts` (new) | Pure slug generator (`normalizeUsernameCandidate`, `suggestUsernames`) plus the availability/PATCH-shared suggestion service with `MAX_SUGGESTIONS = 3`, `MAX_PROBES = 20`, deterministic `base_n` ordering with 20-char truncation. No I/O inside the pure functions; the `isTaken` probe is injected. |
| `src/routes/sync.ts` | Non-production `provisionUser` inserts `username: null` instead of the fabricated `user_<...>` value. Production behavior (never provision) unchanged. |
| `src/routes/usernames.test.ts` (new) | Generator unit tests: determinism, bounds, truncation, invalid-base rejection, empty/full-table edge cases. All pure, no I/O. |
| `src/routes/auth.usernames.test.ts` (new) | Hono `app.request` tests: creation without username yields null username + display name from Google data; explicit valid username accepted; invalid username 400; taken username at creation 409 with suggestions; availability endpoint matrix (free/taken/invalid/unauthenticated); PATCH success, PATCH clash 409 with suggestions and zero writes, PATCH race backstop; `toPublic` null contract on all three auth responses; bootstrap-admin still applied on username-less creation. Mocked boundaries, no live network. |
| `src/routes/googleAccount.postgres.test.ts` (extend) | Isolated local PostgreSQL: concurrent creations racing the same explicit username converge to exactly one holder (other gets username-taken 409, never identity-conflict mislabel); username-less concurrent creations both succeed with null usernames; grandfathered-row login leaves username untouched. |

`src/middleware/auth.ts`, `src/routes/googleIdentity.ts`, `src/routes/admin.ts`, `src/routes/comments.ts`, `src/config/env.ts`, `src/app.ts`, `src/database/schema.ts`, `drizzle/*`, `wrangler.toml`, and the entire app repository need no functional edits. No dependency addition is required.

## Testing Strategy

Use Vitest with local Hono `app.request`, caller tokens minted with the test signing key, and the existing isolated-PostgreSQL harness for race cases. No test uses real Google credentials, production storage, or live network access. No secrets are committed; fixtures use synthetic subjects, emails, and handles.

Required cases:

1. Generator purity: same base + same taken-set always returns the same list; at most 3 suggestions; at most 20 `isTaken` calls; every suggestion matches `USERNAME_RE` including 20-char boundary bases (truncation correctness); invalid base yields no suggestions.
2. Creation without explicit username returns `username: null` with `name` derived from Google input; the response carries no non-empty handle, so the app's existing missing-username routing sends the user to setup with no app change.
3. Creation with an explicit valid username persists it verbatim and returns it; creation with an invalid-format username returns 400 and creates nothing.
4. Creation with a taken username returns 409 `username_taken` with up to 3 suggestions (zero under adversarial saturation, which the generator test pins) and creates no row; a racing creation that loses on the unique constraint gets the same body, never the generic identity-conflict message.
5. Availability endpoint: free → `{ available: true, suggestions: [] }`; taken → `{ available: false, suggestions }`; malformed → 400 with no suggestions; missing token → 401; database unavailable → 503 with no diagnostics.
6. PATCH success sets username + name + media atomically and returns the updated public user; PATCH clash returns 409 with suggestions and writes nothing (re-read confirms name/media unchanged); PATCH race backstop returns the username-taken body rather than the generic conflict.
7. Grandfathering: a row with a legacy auto-generated username logs in, reads `/me`, and patches non-username fields with the handle byte-identical afterward; no migration files exist and the journal is untouched.
8. Bootstrap: an `ADMIN_EMAILS` login with no username still provisions/updates to `role: admin` with `username: null`; admin gating elsewhere is unaffected.

Implementation acceptance requires `npm run typecheck`, `npm test`, the isolated PostgreSQL suite (`googleAccount.postgres.test.ts` including the new race cases), and `npm run build`, all exiting 0. This specification commit runs none of these.

## Risks And Mitigations

1. **Username race mislabeled or double-claimed (two creations, one handle).** *Mitigation:* the unique constraint is the correctness backstop, not the pre-check; both insert-race and update-race losers are disambiguated by targeted re-read into `username_taken` + suggestions vs. identity conflict; single-statement writes mean no partial state; the PostgreSQL race suite is a merge gate, not an optional check.
2. **Availability endpoint becomes a username-enumeration oracle.** *Mitigation:* `requireAuth` (no anonymous probing), inherited `rateLimit(30)`, exactly one candidate per request with no search/list/batch interface, and suggestions are server-synthesized free variants — the caller learns nothing about any account besides the single name they asked about.
3. **`toPublic` null contract breaks an app assumption.** *Mitigation:* verified read-only that every app consumer is null-safe (`isReturningServerAccount` treats null/blank as needs-setup; setup saves via PATCH; `updateMe` ignores unknown fields); grandfathered non-null rows serialize unchanged; the contract test matrix in §Testing pins the null shape on all three auth responses.
4. **Suggestion probing adds load or leaks timing.** *Mitigation:* hard bounds (1 + ≤20 indexed point lookups, early stop at 3 hits) keep worst-case cost trivial; probes run only on the taken path, so the common free-name case costs one lookup; no timing-sensitive branching between free/taken beyond the bounded loop.
5. **A future migration accidentally "fixes" null usernames.** *Mitigation:* this spec authorizes no migration and no backfill; any later proposal touching `users.username` nullability or rewriting existing handles is out of scope here and must go through its own spec with the runbook's read-only gates and explicit user authorization.

## Decision Summary

- New accounts get `username: NULL` unless the caller supplied an explicit valid available handle; only the display name falls back to Google data (email prefix). The server never invents a username on any path: provision, sync fixture, or dev/test memory fixture.
- Explicit handles are validated by the existing `USERNAME_RE` (`^[a-zA-Z0-9_]{3,20}$`) at both creation (400 on invalid) and PATCH; uniqueness is exact-match, unchanged, so grandfathered mixed-case rows are never disturbed.
- Taken names fail closed with `409 { error, code: 'username_taken', suggestions }` on both creation and PATCH, with zero writes on the conflict path and race backstops that disambiguate username collisions from identity collisions instead of collapsing them.
- Suggestions come from a pure deterministic generator (`base_1…`, 20-char truncation, max 3 suggestions, max 20 probes, indexed exact-match lookups, no new index) exposed through an authenticated single-candidate `GET /api/v1/auth/username/availability` endpoint that inherits the existing auth rate limit and offers no search/list/batch surface.
- Authoritative user payloads carry `username: null` / `name: displayName ?? null` with no `u.name` fallbacks; display-only fallbacks in comments and the raw admin read stay as-is.
- Existing auto-generated usernames are grandfathered: no migration (the column has been nullable since `0000`), no backfill, no renames, journal and committed history immutable, `ADMIN_EMAILS`/bootstrap behavior unchanged.
- App repository untouched: missing-username routing, PATCH-based setup save, and 409 handling already exist; the new 409 fields are backward compatible and suggestion UI is deferred to a future app-side change.

## Assumptions And Open Questions

- Assumed: exact-match (case-sensitive) uniqueness continues; `Sara` and `sara` remain distinct claimable handles. Changing this would endanger grandfathered rows and is explicitly out of scope.
- Assumed: `requireAuth` on the availability endpoint is acceptable because the only client that needs it (profile setup) always holds a validated session at that point, per the single-exchange flow documented in `GoogleAuthModal`.
- Assumed: `MAX_SUGGESTIONS = 3` and `MAX_PROBES = 20` are acceptable product bounds; the plan author implements exactly these values and does not re-tune without a follow-up decision.
- Open question for the plan phase (not a spec gap): module placement — `src/routes/usernames.ts` vs. a shared `src/lib/` helper — either is compatible; the plan author picks one and keeps the pure generator I/O-free.
- Open question for a later phase: whether the app adopts the `suggestions` array in the setup UI (tap-to-fill) — server behavior is complete and correct without it.
