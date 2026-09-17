# Frame Store Phase 1: Security Hardening Design

**Date:** 2026-09-17  
**Status:** Approved Phase 1 direction; audited design specification  
**Repository:** `/home/x1carbon/Projects/fan-novel-server`  
**Scope:** Server identity, authentication-email integrity, production authentication configuration, and account failure paths only.

## Goal

Make verified Google claims the authority for production account identity and administrator bootstrap, prevent sync/profile input from altering authentication email, and fail closed when production authentication configuration or account storage is unavailable. Preserve existing account data through a guarded, durable, one-time legacy identity migration. This establishes the account-security prerequisite for a later frame store; it does not implement a store or claim that every unrelated server authorization issue has been resolved.

## Non-Goals

- Frame catalog, ownership, entitlements, equipped frames, coins, purchases, receipts, payment transactions, or VIP expiry.
- Changes to the `Fan Novel` application, its account-settings sheet, token storage, or local VIP flag.
- R2 configuration, credentials, bucket contents, public delivery, or frame uploads.
- General novel-ownership middleware remediation, upload redesign, rate limiting, CORS, or a broader security audit.
- New refresh tokens, session revocation, account merge tooling, or offline entitlement behavior.
- Replacing Google tokeninfo with local JWKS verification in this phase.
- Deploying, running live tests, or implementing code as part of this specification-only change.

## Problem Statement

The approved security objective is that no one can log in as, elevate to, or modify another account using unverified client identity claims. The current server does not consistently meet that objective:

- `src/routes/auth.ts:45-55` checks Google tokeninfo but retains only email and audience. Lines 86-101 make audience validation conditional, derive identity from client `googleId`, and locate an account using external ID **or** email. Lines 118-134 update and issue a session for the matched row. This is a confirmed identity-binding defect, not a demonstrated exploit; knowing an email alone does not bypass the existing production token/email checks.
- `src/routes/sync.ts:89-111,128-142` accepts email in provisioning and overwrites an existing account's email from sync input. Authentication email also participates in login lookup and administrator bootstrap (`src/routes/auth.ts:101-124`).
- `src/config/env.ts:58-83` can discard invalid configuration and reconstruct development/open defaults. `src/middleware/auth.ts:5-38` permits a built-in development signing key independently of the login-only production guard.
- `src/routes/auth.ts:135-244` contains memory account fallbacks not restricted to development. Database errors must not turn authoritative production account operations into successful memory operations.

## Context

- The server is Hono with Drizzle/PostgreSQL, built for Node and Cloudflare Workers. `src/database/db.ts:12-24,34-54` selects a Node pool or Neon HTTP driver; lines 67-78 expose availability/cooldown behavior. A configured database is not necessarily reachable.
- `users` has a stable UUID primary key, unique nullable external ID and email, display fields, role and creator flags (`src/database/schema.ts:6-20`). Library/history/session references use the UUID. Preserving that UUID preserves server account data while changing the login identifier.
- `requireAuth` checks signature, issuer, audience and expiry. Existing account routes resolve JWT subjects through `users.externalId`. `/me` renews the session (`src/routes/auth.ts:164-182`).
- `src/index.ts:7-13` reads configuration before listening. Workers bind environment values before `createApp()` on each request (`src/worker.ts:18-24`); Workers have no equivalent one-time Node startup with all request bindings available.
- Checked-in `wrangler.toml:6-16` specifies production, closed sync and Google audiences. Its required secrets are documented at lines 20-23. Actual deployed bindings and secret values have not been verified.
- App observations are context only: `Fan Novel/src/store/authStore.ts:208-225` assigns a local VIP role, and lines 368-388 persist server JWTs. `Fan Novel/src/services/api.ts:446-460` throws on `/me` 401 but returns null on many non-success/offline outcomes. No app changes are authorized by this design.
- Existing Vitest coverage includes development memory login/admin behavior in `src/routes/auth.admin-persist.test.ts`. No existing files were found in `docs/superpowers/specs/` when this document was started.

## Proposed Architecture

### 1. Verified Google identity and claim boundary

Keep tokeninfo as the verification service, but return a typed verified identity rather than a boolean. A supplied ID token is accepted only after a successful tokeninfo response and explicit validation of:

- A nonempty subject and valid nonempty email.
- Issuer exactly `accounts.google.com` or `https://accounts.google.com`.
- Audience exactly one configured, nonempty Google client ID; an empty allowlist never accepts a supplied token.
- Verified email. Normalize only boolean `true` or the exact tokeninfo string `"true"` to true; reject false, missing, or other values.
- A valid expiration later than server time. Tokeninfo errors, unavailable service, malformed JSON, and malformed claims never become successful authentication.

The optional client display fields remain untrusted customization. Retain the current request-email field for wire compatibility, but require it to match the normalized verified email; never use it for lookup, promotion, or persistence. Ignore client `googleId` for verified login identity.

Canonical external ID remains `google_<verified sub>` to retain the established namespace and compatibility for correctly keyed accounts. The prefix is constant; its identity-bearing value comes exclusively from the verified subject. This is a verified-sub-derived ID, not the raw Google subject or a client-controlled identifier.

Production always requires a token. For explicit development/test environments only, absent-token memory login may remain for local fixtures, with a separate development identifier derived from normalized email, never from client `googleId`. This path cannot access persistent account rows, heal identities, or run in production. A supplied but invalid token is rejected in every environment.

### 2. Durable heal-once migration

Email lookup is removed as a normal login identity mechanism. A narrowly scoped migration exception is necessary for legacy rows whose stored external ID came from pre-fix client input.

Add nullable `users.googleSubject` (`google_subject`), unique when populated. A null value means the row has not yet been bound by this verified-claims implementation. This minimal account-schema addition is necessary: the current `google_` prefix was client-influenced, so it cannot prove that a row was verified or that healing already happened. Merely observing that the next login finds the new ID does not enforce "once" against a later, different subject.

Resolution rules:

1. Look up a row by `googleSubject = verified sub`. If present, use that row; never transfer it by email. Canonical external ID and verified subject must agree or the operation fails closed for reconciliation.
2. Otherwise identify candidates by canonical external ID and normalized verified email. If they identify different rows, or normalized email matches multiple legacy rows, return 409 without modification. PostgreSQL's current unique text email constraint alone does not guarantee case-insensitive uniqueness.
3. One eligible row with null `googleSubject` may be bound atomically: set the verified subject and canonical external ID together, retain the UUID and all account data, and update authentication email from verified claims. If the external ID changes, emit a successful heal audit event.
4. A row already bound to a different Google subject is never healed again, even when email matches. Return 409. A subject/identity uniqueness conflict never falls through to account creation or memory fallback.
5. If neither identity nor email yields a candidate, create a new row with both canonical external ID and verified subject populated.

Use a conditional single-row update that requires the old external ID and null `googleSubject`, plus database uniqueness constraints. On a concurrent update, reread: an identical completed binding may succeed idempotently; a different binding fails 409. This must work with the existing Neon HTTP driver without assuming interactive transaction support. Email, identity binding, and any administrator bootstrap for a login must not be committed as inconsistent partial account changes.

Audit events include event name, request ID, account UUID and outcome. Do not log raw ID/session tokens, credentials, full email, or legacy external IDs that may contain emails. Log only the successful state transition, not every repeated login.

### 3. Authentication email and privilege authority

Only successful verified Google login may assign or change authentication email in production. Administrator bootstrap compares the **verified email** with `ADMIN_EMAILS`, not a body field or an unverified stored email. Preserve existing legitimate roles and creator flags; this phase does not add automatic role revocation or erase old accounts.

Remove sync's email-update branch. Also prevent sync's first insert from establishing an authentication email: otherwise an attacker-controlled email could seed the migration lookup. In production, sync must resolve an existing account from the authenticated subject and reject an unknown subject with 401; it must not recreate an account from an old or missing identity. Development auto-provisioning may remain, but inserts null email and cannot populate `googleSubject`.

The existing sync subject/body-external-ID equality check remains. Body email/name fields remain accepted for old client compatibility but cannot mutate authentication data. Profile PATCH continues to allow only name, username, avatar and banner; authentication email, external ID, Google subject and role are not writable profile fields.

### 4. Production configuration and signing

Validate the effective source before constructing or caching an environment object. Never recover from a failed production parse by discarding `NODE_ENV` and rebuilding permissive defaults.

- Accepted modes are explicit `production`, `development`, and `test`. Missing/unknown mode is a configuration error; local fixtures and local launch environments must identify themselves explicitly.
- In production, require a nonempty valid PostgreSQL connection URL, exact `SYNC_OPEN='false'`, at least one nonempty Google client ID, and a signing secret of at least 32 UTF-8 bytes that is not a known development/default value. Reject the existing development-secret prefix and documented production placeholder.
- Any schema parse error in production, including an unrelated invalid numeric setting, throws before an application can serve protected routes. Diagnostics identify invalid field names, not their values.
- Development/test may omit the database and use development defaults. Invalid environment data must not change the intended mode or silently open sync.
- Signing and verification both use validated configuration. No secondary raw `process.env.JWT_SECRET` fallback may bypass it. The built-in secret is allowed only in explicit development/test mode.

On Node, invalid configuration stops startup before the listener starts. On Workers, it fails application initialization for that request, resulting in an error rather than a functioning permissive app. A request-time error is not evidence that `wrangler deploy` will reject invalid bindings; predeployment validation remains necessary.

### 5. Production account failure semantics

Login, GET `/me`, and PATCH `/me` require durable account storage in production. A database outage, initialization failure, or circuit-breaker unavailability yields 503, with no memory lookup, successful mutation, token minting, or fallback promotion. Known identity/email uniqueness conflicts yield 409 rather than 503. A validly signed session whose subject no longer resolves yields 401 on `/me` and profile mutation, so old clients can drop an obsolete session.

Keep development-only memory behavior isolated from production, including when a process changes test configurations or has populated memory users. Public error bodies disclose no database details or secrets. Fail-closed account changes do not certify unrelated novel-ownership fallback paths, which remain outside this phase.

## Files To Change

The following are implementation-design targets, **not changes authorized by this document-writing task**:

| File | Proposed change and acceptance criteria |
| --- | --- |
| `src/routes/auth.ts` | Typed verified claims, subject-based resolution, guarded migration, verified-email bootstrap, and production 503/401/409 behavior. Client `googleId` never selects a verified account; repeated or conflicting heals cannot rebind it. |
| `src/routes/sync.ts` | Remove authentication-email writes and production auto-provisioning. Existing profile/authentication fields are unchanged by sync; unknown production subjects receive 401. |
| `src/config/env.ts` | Explicit mode and production config validation before caching. Invalid production input throws without development/open defaults or secret leakage. |
| `src/middleware/auth.ts` | Central validated signing key for sign/verify and development-only fallback. Production never accepts a token signed with the built-in dev key. |
| `src/database/schema.ts` | Add nullable unique `googleSubject`; retain account UUID and existing relationships. |
| `drizzle/0006_google_identity_binding.sql` | Add the nullable subject column and unique constraint, without deleting/rekeying existing rows in bulk. |
| `drizzle/meta/_journal.json` | Register the additive migration. |
| `drizzle/meta/0006_snapshot.json` | Record the generated schema snapshot consistent with the migration. |
| `src/config/env.test.ts` | New config/mode/cache-isolation tests. |
| `src/middleware/auth.test.ts` | New signing/verification policy tests. |
| `src/routes/auth.identity.test.ts` | New verified identity, migration, conflict and failure tests. |
| `src/routes/sync.identity.test.ts` | New authentication-email lock and unknown-subject tests. |
| `src/routes/auth.admin-persist.test.ts` | Make development mode explicit, isolate environment state, and retain development-only admin/memory coverage. |

The exact migration sequence above uses the currently inspected `0000`–`0005` history; if another migration lands first, allocate the next sequence rather than overwrite it. `src/database/db.ts`, app source, R2 configuration and `wrangler.toml` bindings need no functional edits for this design. No dependency addition is required.

## Migration And Backward Compatibility

- Preserve UUID, library/history/session associations, avatar/banner, username and existing grants. Binding is not account deletion, account merging, or creation of an empty replacement.
- The nullable subject column is added first. Correctly keyed legacy rows bind without changing their external ID. Email-matched eligible rows change external ID once and receive a fresh token in that same successful login response.
- Older sessions for a rekeyed external ID do not magically remain resolvable. Other installations must perform verified login again; `/me` returns 401 for the obsolete subject. Sync cannot provision a replacement row for it. No legacy-subject alias is introduced because it would extend trust in an unverified identity.
- Legacy accounts whose email changed and whose external ID never contained the verified subject cannot be safely identified automatically. Preserve their data and require verified administrative reconciliation before migration; do not label them disposable or assume they have no valuable data. Case-fold duplicates, suspicious legacy privileged rows and email/subject conflicts likewise need review. This is the explicit limit of automatic "no account loss": data is retained, but uninterrupted access for every inconsistent legacy row cannot be guaranteed from the existing columns.
- Existing stored email was previously client-writable. Heal-once is the approved compatibility compromise, not retrospective proof that every legacy row's email is trustworthy. Before rollout, review suspicious bindings/admin accounts; unresolved risks block automatic migration for affected accounts.
- The existing request/response field names and `google_` namespace remain unchanged. App-side local account-ID derivation and stale sync payload behavior must be covered by compatibility fixtures; app changes are not silently added to this phase.

## Testing Strategy

Use Vitest with local Hono `app.request`, mocked tokeninfo and database boundaries, and isolated environment/module globals. No test uses real Google credentials, production storage, R2 or live network access. Use an isolated local PostgreSQL database to verify uniqueness and concurrent migration outcomes; route mocks alone cannot establish atomicity.

Required cases:

1. Valid production configuration; missing/unknown mode; missing/empty/short/default signing key; missing database/audience; open or misspelled sync flag; and malformed numeric settings. Every invalid production case fails before permissive app creation. Configuration cache resets cannot reuse another test/environment's permissive settings.
2. Signing and verification enforce the same key policy. Separate a rejected production configuration containing the development secret from rejection of a dev-signed token by a correctly configured production verifier. Preserve JWT issuer/audience/expiry checks.
3. Valid tokeninfo claims; missing subject/email/audience/issuer/expiry; false or malformed email verification; accepted boolean/string true normalization; wrong audience/issuer; expired token; malformed response and upstream failure. No supplied invalid token falls back to development authentication.
4. Different client `googleId` values with the same verified subject yield the same account. Verified-email bootstrap succeeds only for the verified address; request-body email mismatch is rejected. Unknown protected profile fields cannot change identity, email or role.
5. Existing sync push/pull cannot change email, including first-insert attempts and case variants. Missing users/obsolete subjects fail 401 in production; body/token identity mismatch remains 403. Development provisioning leaves email null.
6. Correctly keyed binding and email-based legacy heal retain UUID and all associations. Repeated login makes no second transition. A different subject cannot rebind a marked row. Concurrent identical heals converge; competing claims, subject/email split matches and case-fold duplicate emails fail closed without partial changes.
7. All three account routes return 503 on database unavailability, including populated memory fixtures and database errors after availability checks. Conflicts return 409; missing subjects return 401; none issue a success token.
8. A healed login returns a usable new token. An old token receives `/me` 401 and cannot reprovision through sync. Existing client wire fixtures remain compatible for already canonical identities.
9. Logs contain successful heal events once and no tokens, emails, secret values or raw database diagnostics in responses.

Implementation acceptance requires `npm run typecheck` and `npm test`, plus the isolated PostgreSQL migration/concurrency checks. This specification commit does not run or claim these implementation tests.

## Rollout Notes

These are future release gates, not authorization to deploy during spec writing.

- Review legacy conflicts and sensitive account bindings, back up account data, and apply the additive migration through the existing Drizzle migration workflow before deploying code that reads `googleSubject`.
- Verify production mode, closed sync, audiences, valid database configuration and adequate JWT secret without exposing values. Secret-name listing alone cannot validate a value. Changing the JWT signing key invalidates existing sessions and must be communicated.
- Run the tests and a `wrangler deploy --dry-run` with an external output directory. Dry-run checks bundling, not live secret correctness or database availability.
- Release using `wrangler deploy` after authorization. Keep R2 bindings and assets unchanged.
- Check database health and redacted error/heal events. Any live login smoke check needs separate approval: login may heal an account or update login metadata and is not read-only.
- On failure, prefer a fixed secure deployment or temporary unavailability. Blindly rolling back to the old permissive login code reopens the identity defects and can undermine the binding invariant. Retain the additive column and recorded bindings; never roll back by erasing subject bindings or restoring arbitrary legacy IDs.

## Risks And Mitigations

1. **Legacy email is not historically trustworthy.** Guarded migration cannot prove the provenance of old data. Review conflicts/privileged rows, preserve UUID/data, log bindings, and use manual verified reconciliation where automatic binding is unsafe.
2. **Repeated or concurrent email relinking.** A durable verified-subject marker, uniqueness and conditional update enforce one-time binding. Never use prefix shape or successful previous lookup as the only migration guard.
3. **Outage after stricter config or database requirements.** Validate configuration and deploy the additive schema first. Fail closed with clear redacted diagnostics; do not restore memory success to improve apparent availability.
4. **Old sessions stop resolving after heal.** Return a fresh token to the healing login and 401 for obsolete subjects; block sync reprovisioning. Preserve data and document reauthentication on other installations.
5. **Google tokeninfo availability.** Fail authentication closed with a controlled service error when verification is unavailable. JWKS caching is a separate future change, not an unverified fallback.
6. **Overstating Phase 1 coverage.** Existing sessions, legacy privilege history and unrelated ownership/upload weaknesses are not comprehensively repaired here. Do not advertise this prerequisite as a complete commerce-readiness certification.

## Decision Summary

- Verified Google subject determines identity; the constant `google_` namespace stays for compatibility.
- Require configured audience, valid issuer/expiry, verified email and well-formed claims; body identity/email never authorize account access or promotion.
- Preserve accounts by binding eligible legacy rows once, with a durable unique verified-subject column, atomic checks and redacted logging.
- Email lookup is migration-only; conflicts never merge or transfer accounts automatically.
- Sync/profile cannot set authentication email; production sync cannot recreate unknown identities.
- Production requires explicit valid configuration and durable account storage. Development credentials and memory users cannot be production fallbacks.
- Tests cover configuration, JWT policy, claims, email lock, one-time/concurrent migration, old-session compatibility and storage failure.
- No app, R2, frame catalog or payment implementation is included.

## Assumptions And Open Questions

- The minimal schema addition is a necessary design refinement of "heal once"; existing columns cannot distinguish previously verified bindings from client-assigned legacy IDs. This document specifies the addition but does not execute it.
- Canonical external ID means `google_<verified sub>`, preserving the existing namespace rather than switching clients to raw subjects.
- Automatic migration assumes an eligible legacy email match has passed the pre-rollout integrity review. Ambiguous or suspicious records require reconciliation, not a guessed identity mapping.
- **Deferred Phase 2 decision:** frame grants through coins, real money, or VIP, including VIP expiration semantics. This does not block Phase 1 implementation planning.
