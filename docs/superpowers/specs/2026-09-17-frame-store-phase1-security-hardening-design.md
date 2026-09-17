# Frame Store Phase 1: Security Hardening Design

**Date:** 2026-09-17  
**Status:** Approved Phase 1 direction (simplified: no legacy accounts); audited design specification  
**Repository:** `/home/x1carbon/Projects/fan-novel-server`  
**Scope:** Server identity, authentication-email integrity, production authentication configuration, and account failure paths only.

## Goal

Make verified Google claims the sole authority for account identity and administrator bootstrap from the first account onward: accounts are created only from a verified Google ID token (`externalId = google_<verified sub>`), sync/profile input can never alter authentication email, and every security-relevant path fails closed when production configuration or account storage is unavailable. The deployed `users` table is empty (user-confirmed), so no legacy migration is included. This establishes the account-security prerequisite for a later frame store; it does not implement a store or claim that every unrelated server authorization issue is resolved.

## Non-Goals

- Frame catalog, ownership, entitlements, equipped frames, coins, purchases, receipts, payment transactions, or VIP expiry.
- Changes to the `Fan Novel` application, its account-settings sheet, token storage, or local VIP flag.
- R2 configuration, credentials, bucket contents, public delivery, or frame uploads.
- Legacy-account migration, email-based linking, heal logic, account merging, or data backfill — not needed (no existing users) and explicitly excluded.
- General novel-ownership middleware remediation, upload redesign, rate limiting, CORS, or a broader security audit.
- New refresh tokens, session revocation, or offline entitlement behavior.
- Replacing Google tokeninfo with local JWKS verification in this phase.
- Deploying, running live tests, or implementing code as part of this specification-only change.

## Problem Statement

The approved security objective is that no one can log in as, elevate to, or modify an account using unverified client identity claims. No accounts exist today, so nothing needs migrating — but every account the server creates after deploy would otherwise inherit the current defects from day one:

- `src/routes/auth.ts:45-55` checks Google tokeninfo but retains only email and audience. Lines 86-101 make audience validation conditional, derive identity from client `googleId`, and locate an account using external ID **or** email. Lines 118-134 update and issue a session for the matched row. This is a confirmed identity-binding defect, not a demonstrated exploit; knowing an email alone does not bypass the existing production token/email checks — but without the fix, the first accounts created would bind to client-influenced identifiers.
- `src/routes/sync.ts:89-111,128-142` accepts email in provisioning and overwrites an existing account's email from sync input. Authentication email also participates in login lookup and administrator bootstrap (`src/routes/auth.ts:101-124`).
- `src/config/env.ts:58-83` can discard invalid configuration and reconstruct development/open defaults. `src/middleware/auth.ts:5-38` permits a built-in development signing key independently of the login-only production guard.
- `src/routes/auth.ts:135-244` contains memory account fallbacks not restricted to development. Database errors must not turn authoritative production account operations into successful memory operations.

## Context

- The server is Hono with Drizzle/PostgreSQL, built for Node and Cloudflare Workers. `src/database/db.ts:12-24,34-54` selects a Node pool or Neon HTTP driver; lines 67-78 expose availability/cooldown behavior. A configured database is not necessarily reachable.
- `users` has a stable UUID primary key, unique nullable external ID and email, display fields, role and creator flags (`src/database/schema.ts:6-20`). Library/history/session references use the UUID. All rows will be created by the new verified-identity code.
- `requireAuth` checks signature, issuer, audience and expiry. Account routes resolve JWT subjects through `users.externalId`. `/me` renews the session (`src/routes/auth.ts:164-182`).
- `src/index.ts:7-13` reads configuration before listening. Workers bind environment values before `createApp()` on each request (`src/worker.ts:18-24`); Workers have no equivalent one-time Node startup with all request bindings available.
- Checked-in `wrangler.toml:6-16` specifies production, closed sync and Google audiences. Its required secrets are documented at lines 20-23. Actual deployed bindings and secret values have not been verified.
- The user confirmed there are **no existing users**; the deployed `users` table is assumed empty and is verified before deploy (see Migration).
- App observations are context only: `Fan Novel/src/store/authStore.ts:208-225` assigns a local VIP role, and lines 368-388 persist server JWTs. `Fan Novel/src/services/api.ts:446-460` throws on `/me` 401 but returns null on many non-success/offline outcomes. No app changes are authorized by this design.
- Existing Vitest coverage includes development memory login/admin behavior in `src/routes/auth.admin-persist.test.ts`.

## Proposed Architecture

### 1. Verified Google identity and claim boundary

Keep tokeninfo as the verification service, but return a typed verified identity rather than a boolean. A supplied ID token is accepted only after a successful tokeninfo response and explicit validation of:

- A nonempty subject and valid nonempty email.
- Issuer exactly `accounts.google.com` or `https://accounts.google.com`.
- Audience exactly one configured, nonempty Google client ID; an empty allowlist never accepts a supplied token.
- Verified email. Normalize only boolean `true` or the exact tokeninfo string `"true"` to true; reject false, missing, or other values.
- A valid expiration later than server time. Tokeninfo errors, unavailable service, malformed JSON, and malformed claims never become successful authentication.

The optional client display fields remain untrusted customization. The request-email field is accepted but must match the normalized verified email; it is never used for lookup, promotion, or persistence. Client `googleId` is ignored for verified login identity.

Canonical external ID is `google_<verified sub>`, preserving the established `google_` namespace. The prefix is a stable convention; its identity-bearing value comes exclusively from the verified subject — never the raw subject alone or a client-controlled identifier.

Production always requires a token. For explicit development/test environments only, absent-token memory login may remain for local fixtures, with a separate development identifier derived from normalized email, never from client `googleId`. This path cannot access persistent account rows or run in production. A supplied but invalid token is rejected in every environment.

### 2. Account provisioning from verified identity

Accounts are created from verified claims only. There is no email-based lookup, no linking, and no heal path. A nullable, unique `users.googleSubject` (`google_subject`) column is added as the durable verified-identity anchor: it carries the uniqueness constraint that makes concurrent provisioning safe and makes every production row explicitly bound to a verified subject. Null is possible only for development fixtures and manual inserts, never for production-created rows.

Resolution rules for verified login:

1. Look up a row by `googleSubject = verified sub`. If present, use that row; the canonical external ID must equal `google_<verified sub>` or the operation fails closed for reconciliation. Email is never a lookup key.
2. If no row matches, create the account in a single insert: external ID `google_<verified sub>`, `googleSubject` set, authentication email set to the verified email, role `reader` unless the verified email is in `ADMIN_EMAILS` (bootstrap, §3), display fields taken from untrusted request input.
3. A unique-constraint violation (external ID, email, or subject) returns 409 with no partial mutation. Concurrent identical provisioning converges by rereading the committed row (idempotent). A verified email colliding with a different existing row is 409, never a silent merge. This must work with the existing Neon HTTP driver without assuming interactive transaction support; the single-row insert makes email and subject binding naturally atomic.
4. A supplied token is the only path that can create or modify production accounts. Uniqueness conflicts never fall through to memory fallback or anonymous creation.

Audit/provisioning events include event name, request ID, account UUID and outcome — logged once per account creation, not on every repeated login. Do not log raw ID/session tokens, credentials, full email, or secret values.

### 3. Authentication email and privilege authority

Only successful verified Google login may set authentication email (at account creation, or on a later sub-matched login whose verified email changed). Administrator bootstrap compares the **verified email** with `ADMIN_EMAILS`, not a body field. Roles begin at `reader`; elevation happens only through the verified-email `ADMIN_EMAILS` bootstrap at login. No other elevation path exists, and this phase adds no revocation mechanics.

Remove sync's email-update branch. Also prevent sync's first insert from establishing an authentication email: an unverified email must never enter the authentication path. In production, sync must resolve an existing account from the authenticated subject and reject an unknown subject with 401; it must not create accounts. Development auto-provisioning may remain, but inserts null email and null `googleSubject`, and cannot run in production.

The existing sync subject/body-external-ID equality check remains. Body email/name fields stay accepted for client compatibility but cannot mutate authentication data. Profile PATCH continues to allow only name, username, avatar and banner; authentication email, external ID, Google subject and role are not writable profile fields.

### 4. Production configuration and signing

Validate the effective source before constructing or caching an environment object. Never recover from a failed production parse by discarding `NODE_ENV` and rebuilding permissive defaults.

- Accepted modes are explicit `production`, `development`, and `test`. Missing/unknown mode is a configuration error; local fixtures and local launch environments must identify themselves explicitly.
- In production, require a nonempty valid PostgreSQL connection URL, exact `SYNC_OPEN='false'`, at least one nonempty Google client ID, and a signing secret of at least 32 UTF-8 bytes that is not a known development/default value. Reject the existing development-secret prefix and documented production placeholder.
- Any schema parse error in production, including an unrelated invalid numeric setting, throws before an application can serve protected routes. Diagnostics identify invalid field names, not their values.
- Development/test may omit the database and use development defaults. Invalid environment data must not change the intended mode or silently open sync.
- Signing and verification both use validated configuration. No secondary raw `process.env.JWT_SECRET` fallback may bypass it. The built-in secret is allowed only in explicit development/test mode.

On Node, invalid configuration stops startup before the listener starts. On Workers, it fails application initialization for that request, resulting in an error rather than a functioning permissive app. A request-time error is not evidence that `wrangler deploy` will reject invalid bindings; predeployment validation remains necessary.

### 5. Production account failure semantics

Login, GET `/me`, and PATCH `/me` require durable account storage in production. A database outage, initialization failure, or circuit-breaker unavailability yields 503, with no memory lookup, successful mutation, token minting, or fallback promotion. Identity/uniqueness conflicts yield 409 rather than 503. A validly signed session whose subject no longer resolves yields 401 on `/me` and profile mutation. Keep development-only memory behavior isolated from production, including when a process changes test configurations or has populated memory users. Public error bodies disclose no database details or secrets. Fail-closed account changes do not certify unrelated novel-ownership fallback paths, which remain outside this phase.

## Files To Change

The following are implementation-design targets, **not changes authorized by this document-writing task**:

| File | Proposed change and acceptance criteria |
| --- | --- |
| `src/routes/auth.ts` | Typed verified claims, subject-based lookup, single-insert provisioning, verified-email bootstrap, and production 503/401/409 behavior. Client `googleId` and body email never select or authorize an account; no email-based account linking exists. |
| `src/routes/sync.ts` | Remove authentication-email writes and production auto-provisioning. Existing profile/authentication fields are unchanged by sync; unknown production subjects receive 401. |
| `src/config/env.ts` | Explicit mode and production config validation before caching. Invalid production input throws without development/open defaults or secret leakage. |
| `src/middleware/auth.ts` | Central validated signing key for sign/verify and development-only fallback. Production never accepts a token signed with the built-in dev key. |
| `src/database/schema.ts` | Add nullable unique `googleSubject`; retain the UUID primary key and existing relationships. |
| `drizzle/0006_google_identity_binding.sql` | Add the nullable subject column and unique constraint on the (empty) users table. |
| `drizzle/meta/_journal.json` | Register the additive migration. |
| `drizzle/meta/0006_snapshot.json` | Record the generated schema snapshot consistent with the migration. |
| `src/config/env.test.ts` | New config/mode/cache-isolation tests. |
| `src/middleware/auth.test.ts` | New signing/verification policy tests. |
| `src/routes/auth.identity.test.ts` | New verified identity, provisioning, conflict and failure tests. |
| `src/routes/sync.identity.test.ts` | New authentication-email lock and unknown-subject tests. |
| `src/routes/auth.admin-persist.test.ts` | Make development mode explicit, isolate environment state, and retain development-only admin/memory coverage. |

The exact migration sequence above uses the currently inspected `0000`–`0005` history; if another migration lands first, allocate the next sequence rather than overwrite it. `src/database/db.ts`, app source, R2 configuration and `wrangler.toml` bindings need no functional edits for this design. No dependency addition is required.

## Migration (Fresh-Schema Assumption)

- The deployed `users` table is empty per user confirmation. The additive migration (nullable unique `google_subject`) applies to an empty table; there is no backfill, no heal step, and no data migration.
- Before deploy, verify emptiness with a read-only row count. **If any unexpected rows are found, stop deployment and consult the user.** This spec does not authorize deleting or modifying unexpected rows.
- Register the migration through the existing Drizzle journal workflow before deploying code that reads `googleSubject`.
- There is no backward-compatibility section because there are no legacy accounts; the wire contract (`POST /auth/google` payload/response) is unchanged, so no client release coordination is required.
- `googleSubject` is a permanent verified-identity anchor, not a transitional migration aid: production rows always carry it.

## Testing Strategy

Use Vitest with local Hono `app.request`, mocked tokeninfo and database boundaries, and isolated environment/module globals. No test uses real Google credentials, production storage, R2 or live network access. Use an isolated local PostgreSQL database to verify uniqueness and concurrent provisioning outcomes; route mocks alone cannot establish atomicity.

Required cases:

1. Valid production configuration; missing/unknown mode; missing/empty/short/default signing key; missing database/audience; open or misspelled sync flag; and malformed numeric settings. Every invalid production case fails before permissive app creation. Configuration cache resets cannot reuse another test/environment's permissive settings.
2. Signing and verification enforce the same key policy. Separate a rejected production configuration containing the development secret from rejection of a dev-signed token by a correctly configured production verifier. Preserve JWT issuer/audience/expiry checks.
3. Valid tokeninfo claims; missing subject/email/audience/issuer/expiry; false or malformed email verification; accepted boolean/string true normalization; wrong audience/issuer; expired token; malformed response and upstream failure. No supplied invalid token falls back to development authentication.
4. Different client `googleId` values with the same verified subject yield the same account. Verified-email bootstrap succeeds only for the verified address; request-body email mismatch is rejected. Unknown protected profile fields cannot change identity, email or role.
5. Sync push/pull cannot set or change authentication email, including first-insert attempts and case variants. Missing users/unknown subjects fail 401 in production; body/token identity mismatch remains 403. Development provisioning inserts null email and null `googleSubject`.
6. First login creates the account with external ID `google_<verified sub>`, `googleSubject` set, verified email, and `reader` role (or `ADMIN_EMAILS` bootstrap). Repeated logins return the same row with no new writes. Concurrent identical provisioning converges to one row. A verified email colliding with another row, or a subject/external-ID disagreement, returns 409 with no partial mutation.
7. All three account routes return 503 on database unavailability, including populated memory fixtures and database errors after availability checks. Conflicts return 409; missing subjects return 401; none issue a success token from failure.
8. A new-account login returns a usable token; sync cannot provision unknown production subjects. Client wire fixtures remain compatible for accounts created by this design.
9. Logs contain provisioning events once per account and no tokens, emails, secret values or raw database diagnostics in responses.

Implementation acceptance requires `npm run typecheck` and `npm test`, plus the isolated PostgreSQL provisioning/concurrency checks. This specification commit does not run or claim these implementation tests.

## Rollout Notes

These are future release gates, not authorization to deploy during spec writing.

- Verify the `users` table is empty (read-only count). Unexpected rows stop deployment pending user consultation (see Migration).
- Verify production mode, closed sync, audiences, valid database configuration and adequate JWT secret without exposing values. Secret-name listing alone cannot validate a value.
- Run the tests and a `wrangler deploy --dry-run` with an external output directory. Dry-run checks bundling, not live secret correctness or database availability.
- Release using `wrangler deploy` after authorization. Keep R2 bindings and assets unchanged.
- Check database health and redacted provisioning/error events. Any live login smoke check needs separate approval: login creates an account row and writes login metadata and is not read-only.
- On failure, prefer a fixed secure deployment or temporary unavailability. Blindly rolling back to the old permissive login code reopens the identity defects for every account created since deploy. Retain the additive column and recorded subject bindings; never roll back by erasing verified subject bindings.

## Risks And Mitigations

1. **Fresh-schema assumption is wrong** (unexpected rows exist at deploy time). *Mitigation:* pre-deploy read-only emptiness check; deployment stops and the user is consulted; this spec authorizes no deletion or modification of unexpected rows.
2. **Outage after stricter config or database requirements** (hard startup/failed requests on misconfiguration). *Mitigation:* intentional fail closed over silent permissiveness; validate configuration and apply the additive schema before deploy; pre-deploy checklist and diagnostics that name the exact invalid field.
3. **Rollback reopens identity defects.** *Mitigation:* treat rollback to the old permissive login code as a last resort for a fixed secure deployment or temporary unavailability; keep the additive column and recorded bindings so re-deploying the hardened build loses nothing.
4. **Google tokeninfo availability.** *Mitigation:* fail authentication closed with a controlled service error when verification is unavailable; JWKS caching is a separate future change, not an unverified fallback.
5. **First-account/admin bootstrap exposure.** With an empty table, the earliest verified logins define the account population, and an `ADMIN_EMAILS` match elevates immediately. *Mitigation:* bootstrap compares only the verified email (§3); confirm `ADMIN_EMAILS` correctness before opening registrations, and log provisioning events with outcomes.
6. **Overstating Phase 1 coverage.** Unrelated ownership/upload weaknesses and future account-privilege history are not comprehensively repaired here. Do not advertise this prerequisite as a complete commerce-readiness certification.

## Decision Summary

- Verified Google subject determines identity; accounts are created from verified claims only, from day one — no email-based lookup, linking, or heal machinery.
- Require configured audience, valid issuer/expiry, verified email and well-formed claims; body identity/email never authorize account access or promotion.
- `users.googleSubject` (nullable, unique) is added as the permanent verified-identity anchor; canonical external ID is `google_<verified sub>`; provisioning is a single atomic insert with 409 on uniqueness conflicts.
- Fresh-schema assumption: no migration of legacy rows; unexpected rows found pre-deploy stop deployment for user consultation (no deletion authorized).
- Sync/profile cannot set authentication email; production sync cannot create accounts and rejects unknown subjects with 401.
- Production requires explicit valid configuration and durable account storage. Development credentials and memory users cannot be production fallbacks.
- Tests cover configuration, JWT policy, claims, email lock, provisioning/uniqueness/concurrency, and storage failure.
- No app, R2, frame catalog or payment implementation is included.

## Assumptions And Open Questions

- User-confirmed: there are no existing users; the deployed `users` table is assumed empty and verified with a read-only count before deploy. Any unexpected rows halt deployment for user consultation.
- The nullable unique `googleSubject` column is retained (per approval) as the durable verified-identity anchor and the uniqueness mechanism for concurrent provisioning — not as a migration aid.
- Canonical external ID means `google_<verified sub>`, preserving the existing namespace rather than switching clients to raw subjects.
- **Deferred Phase 2 decision:** frame grants through coins, real money, or VIP, including VIP expiration semantics. This does not block Phase 1 implementation planning.
