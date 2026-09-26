# Pro Reading-Statistics Subscription Entitlement: Design

**Date:** 2026-09-26
**Status:** Approved design scope (specification only, no product code)
**Repositories:** server `/home/x1carbon/Projects/fan-novel-server` (primary, spec only)
**Runtime:** Cloudflare Workers + Hono + Drizzle + Neon Postgres
**Scope:** Server-side time-limited Pro entitlement for reading statistics only. No app-repo changes.

## Goal

Give `users.reading_stats_plan` a time-limited meaning so Pro reading statistics
(words, streaks, WPM, hourly/genre distributions, chapter-state collections) are
available only while a server-granted Pro window is active, while Free remains a
permanent fallback that never expires and all stored reading evidence is preserved
across downgrades and upgrades.

Concretely: add expiry bookkeeping columns to `users`, derive the effective plan
from UTC epoch-ms expiry on every plan-aware request (`POST /api/v1/sync/push`,
`POST /api/v1/sync/pull`, `GET /api/v1/users/me/profile?readingStatsVersion=2`),
downgrade to Free immediately at expiry with no background job, renew only through
a trusted manual admin/internal operation, and keep the client out of all
entitlement decisions.

## Non-Goals

- Any billing provider, checkout, payment webhook, invoice, receipt, refund, or
  automatic payment renewal. Renewal is a manual trusted-admin operation only.
- Trial activation: schema carries trial columns, but activation is disabled by
  policy (see § Trial activation policy stub). No trial-grant path ships.
- Any change to the v2 Free/Pro sync contracts (`contracts.ts` shapes,
  `pro_fields_not_allowed`, completion/WPM plausibility rules), the calculation
  engine (`calculations.ts`), or the append-only/idempotent session store semantics.
- Leaderboards, social features, new stats dimensions, or mobile-app UI changes.
- Deleting, redacting, or migrating `reading_sessions` / `reading_history` /
  `user_library` / `reading_chapter_state` / `reading_novels` rows on downgrade.
- A background expiry job, cron, queue, or lazy-write-back of derived plan.
- Any live-Neon command, migration run, deployment, or live test as part of this
  specification.

## Context (existing contracts)

- Identity/plan column (`src/database/schema.ts:7-26`): `users.reading_stats_plan`
  `varchar(10)` default `'free'`, check constraint `in ('free','pro')`. Today it is
  a permanent flag with no time dimension.
- Plan authority (`src/features/readingSync/freeStore.ts:80-87`):
  `normalizeReadingPlan()` degrades anything but `'pro'` to `'free'`;
  `authoritativePlan(row)` reads only the stored column, never the request.
- Push (`src/routes/sync.ts:264-314`): `pushV2` runs `ownerMismatch` →
  read-only non-provisioning `v2PlanProbe` (single `SELECT reading_stats_plan`) →
  strict parse (`parseProV2Push` vs `parseFreeV2Push`) → `v2SyncUser` resolve →
  re-read authoritative plan → `409 plan_changed` if probe and resolve disagree →
  `storeProPush` / `storeFreeSessions`. Responses carry `plan` + `serverNow`.
- Pull (`src/routes/sync.ts:316-347`): same probe/parse/resolve/409 sequence;
  Pro requires `readingStats` cursors, served by `pullProData`; Free served by
  `buildFreePullResponse(loadFreeStatsForUser())`.
- Profile (`src/routes/profile.ts:156-207`): `GET /me/profile` requires auth;
  without `?readingStatsVersion=2` it returns the legacy plan-blind payload
  (kept byte-for-byte); with `=2` it resolves `authoritativePlan(row)` then
  serves `proProjection(loadProStats())` or `freeProjection(loadFreeStatsForUser())`
  with `{ success, user, plan, readingStatsVersion, readingStats }`. Unknown
  version value is `400`; `toPublic()` never emits plan/expiry internals.
- Free store (`freeStore.ts:35-40,163-178`): Free rows use
  `FREE_SESSION_SAFE_DEFAULTS` (`words 0`, `minuteOfDay 0`, `readDay ''`,
  `genre ''`) plus `proFieldsPresent = false`, `completionSignalPresent = true`.
  Pro rows carry `proFieldsPresent = true`. `loadFreeStatsForUser` aggregates in
  SQL (no row streaming). Legacy v1 push/pull and the legacy unversioned profile
  are **also derived-plan gated** (§ Legacy v1 gating): same derivation, same
  safe defaults/zeroes for Free; wire shapes unchanged, values gated. There is
  no plan-blind Pro-evidence channel after this design.
- Constants: `CLIENT_CLOCK_SKEW_MS = 5min` (`sync.ts:48`) applies only to session
  `ts` clamping, never to entitlement.

## Schema Design

### New `users` columns (all additive, all nullable except where noted)

| Column (db) | Drizzle field | Type | Default | Meaning |
|---|---|---|---|---|
| `reading_stats_plan` (existing) | `readingStatsPlan` | `varchar(10)` | `'free'` | Last-granted plan. Bookkeeping only; never trusted alone. |
| `reading_stats_plan_started_at` | `readingStatsPlanStartedAt` | `bigint` (epoch ms) | `null` | When the current/last Pro window started. |
| `reading_stats_plan_expires_at` | `readingStatsPlanExpiresAt` | `bigint` (epoch ms) | `null` | When the current Pro window ends (exclusive). Null = no active grant. |
| `reading_stats_trial_started_at` | `readingStatsTrialStartedAt` | `bigint` | `null` | Trial window start. Stored only; unused while trials disabled. |
| `reading_stats_trial_ends_at` | `readingStatsTrialEndsAt` | `bigint` | `null` | Trial window end (exclusive). Stored only; unused while trials disabled. |
| `reading_stats_last_renewed_at` | `readingStatsLastRenewedAt` | `bigint` | `null` | Last manual renewal timestamp (audit). |
| `reading_stats_grace_until` | `readingStatsGraceUntil` | `bigint` | `null` | Grace extension end (exclusive). Null by default = no grace. |
| `reading_stats_plan_duration_days` | `readingStatsPlanDurationDays` | `integer` | `30` | Duration granted by the last renewal. Informational. |
| `reading_stats_plan_status` | `readingStatsPlanStatus` | `varchar(20)` | `'free'` | Lifecycle label: `'free'` \| `'active'` \| `'expired'` \| `'cancelled'`. Informational; effective plan is always derived, never read from this column. |
| `reading_stats_renewal_count` | `readingStatsRenewalCount` | `integer` | `0` | Number of successful Pro grants/renewals. Display/audit only; never an entitlement input. |
| `reading_stats_total_subscribed_ms` | `readingStatsTotalSubscribedMs` | `bigint` (epoch-ms duration) | `0` | Cumulative active Pro time granted across all windows. Display/audit only; never an entitlement input. |

Drizzle sketch (field names only; plan author owns exact definition):

```ts
readingStatsPlanStartedAt: bigint('reading_stats_plan_started_at', { mode: 'number' }),
readingStatsPlanExpiresAt: bigint('reading_stats_plan_expires_at', { mode: 'number' }),
readingStatsTrialStartedAt: bigint('reading_stats_trial_started_at', { mode: 'number' }),
readingStatsTrialEndsAt: bigint('reading_stats_trial_ends_at', { mode: 'number' }),
readingStatsLastRenewedAt: bigint('reading_stats_last_renewed_at', { mode: 'number' }),
readingStatsGraceUntil: bigint('reading_stats_grace_until', { mode: 'number' }),
readingStatsPlanDurationDays: integer('reading_stats_plan_duration_days').default(30).notNull(),
readingStatsPlanStatus: varchar('reading_stats_plan_status', { length: 20 }).default('free').notNull(),
readingStatsRenewalCount: integer('reading_stats_renewal_count').default(0).notNull(),
readingStatsTotalSubscribedMs: bigint('reading_stats_total_subscribed_ms', { mode: 'number' }).default(0).notNull(),
```

Plus a check constraint on `reading_stats_plan_status in
('free','active','expired','cancelled')`. No index is required: every entitlement
read is a point lookup on the already-indexed `users.external_id` / PK path
(`v2PlanProbe`, `v2SyncUser`, profile `WHERE external_id = sub`); no query filters
or orders by expiry. No FK changes. No changes to session/history/library tables.

Why denormalized counters instead of deriving from `subscription_events`
(`COUNT`/`SUM`)? The probe runs on every push/pull/profile request: a point
lookup on the `users` row keeps the hot path at one indexed read, while
aggregating events per request would add a second query to the most frequent
endpoint. `renewalCount` / `totalSubscribedMs` / `planStatus` /
`planDurationDays` are therefore write-time materializations of the event log
for the hot path and admin display; the event table remains the source of
truth for investigations. Trial/grace columns are reserved so enabling either
later needs no migration.

### Semantics

- `plan` is the granted tier; `planExpiresAt` is the entitlement clock.
  Effective access = derived per request (§ Effective-plan algorithm).
- Free is permanent: a Free row needs no timestamps; all Free timestamp columns
  stay `null`, `planDurationDays` stays at its default, `planStatus = 'free'`.
- Pro is time-limited: a Pro grant must set `planStartedAt`, `planExpiresAt`
  (`startedAt + durationDays`), `lastRenewedAt`, `planDurationDays`,
  `planStatus = 'active'`, increment `renewalCount` by one, and add the granted
  duration to `totalSubscribedMs`. Default duration is 30 days.
- `graceUntil` defaults to `null` (no grace). It exists so a future policy can
  grant a short post-expiry window without a schema change; while null or in the
  past it has zero effect.
- Trial columns default to `null` and are inert while the trial policy is
  disabled. They must never influence the effective plan until a separate trial
  activation spec ships.

## Migration Strategy

1. Additive migration only: `ALTER TABLE users ADD COLUMN ...` for the ten new
   columns with the defaults above. No `NOT NULL` without default, no backfill
   inside the DDL transaction beyond defaults, no constraint on existing rows.
2. Backfill (one idempotent statement or small script, reviewed separately):
   - Rows with `reading_stats_plan = 'free'`: leave all new timestamps `null`,
     set `plan_status = 'free'`. No behavior change.
   - Rows with `reading_stats_plan = 'pro'` and no expiry concept today: to avoid
     an instant mass downgrade on deploy, grant one 30-day window from migration
     time (`plan_started_at = now`, `plan_expires_at = now + 30d`,
     `last_renewed_at = now`, `plan_duration_days = 30`, `plan_status = 'active'`,
     `renewal_count = 1`, `total_subscribed_ms = 30d`) **plus one `grant`
     event row per backfilled user** (`actor_id` null,
     `reason = 'system: migration backfill'`, `previous_expires_at` null,
     `new_expires_at` = the granted expiry, `duration_days = 30`,
     `occurred_at` = migration `now`). Without the event row, backfilled
     windows would be unaccountable grants and `totalSubscribedMs` would no
     longer equal the sum of event durations — violating the "logged event
     always matches the stored window" invariant.
     The exact `now` source (migration-run time) is recorded in the migration log.
     Alternative (expire immediately) is rejected: it would convert a deploy into
     a silent mass entitlement revocation.
3. Drizzle schema updated in the same change; `drizzle/` migration files generated
   per repo convention (backfill lives in `scripts/backfill-pro-subscription.*`,
   reviewed separately). No data migration for session/history/library tables.
4. Rollback is forward-only: drop-columns on revert. No production code may fall
   back to trusting the raw stored `plan` flag when expiry columns are absent —
   ship no fallback reader; a database without the migration is a failed
   deployment, not a degraded mode.

## Effective-Plan Algorithm

Single authority used by push, pull, and profile. Inputs: resolved `users` row
(including the new columns) and server `nowMs = Date.now()`. No client input, no
background state, no writes.

```ts
function effectiveReadingPlan(row, nowMs: number): 'free' | 'pro' {
  if (row.readingStatsPlan !== 'pro') return 'free';
  const expiresAt = row.readingStatsPlanExpiresAt;
  // Fail closed: a Pro flag without a valid expiry grants nothing.
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return 'free';
  if (nowMs < expiresAt) return 'pro';
  // Expired. graceUntil is reserved; null or past => no effect.
  // Trial fields are ignored while trial policy is disabled.
  return 'free';
}
```

Rules:

- `expiresAt` is exclusive: `nowMs >= expiresAt` means Free. Exact-millisecond
  boundary belongs to Free (deterministic, no off-by-one disputes).
- `graceUntil`: while the default policy holds (no grace), it is not consulted.
  If a future policy enables grace, that policy ships its own spec; this design
  pins the default to immediate downgrade.
- `planStatus`, `planStartedAt`, `lastRenewedAt`, `planDurationDays`,
  `renewalCount`, and `totalSubscribedMs` are never inputs to the derivation.
  They are display/audit fields.
- `null`/non-integer/negative expiry on a `pro` row derives Free (fail closed),
  so corrupt or half-written grants cannot widen access.
- Callers must use the row from `v2SyncUser`/profile resolution (post-probe
  re-read), never the probe row alone, preserving the existing `409 plan_changed`
  race detection.

`authoritativePlan()` in `freeStore.ts` is extended (or wrapped by
`effectiveReadingPlan()`) to this signature; all three surfaces call the same
function. Unit tests pin the boundary (`expiresAt - 1` → pro, `expiresAt` →
free), the null/corrupt-expiry fail-closed cases, and the grace-ignored default.

## Legacy v1 Gating (normative)

The v1 bypass is closed, not documented away. Code comments at the legacy
session writer and legacy profile aggregates already flag those paths as the
Pro-evidence channel (`words`, `minuteOfDay`, `readDay`, `genre`,
`totalWords`, `streakDays`), so leaving them plan-blind would keep a working
Pro channel open for expired accounts while v2 correctly derives Free.

- **v1 push:** resolve the account, derive `effectiveReadingPlan(row, nowMs)`
  from the freshly resolved row, then write. When derived Free, v1 session rows
  store `FREE_SESSION_SAFE_DEFAULTS` for the four Pro-dimension columns plus
  `proFieldsPresent = false` (completion marker semantics unchanged); v1
  history `readDay`/dimension columns store the same safe defaults. Shipped
  Pro dimensions from a Free-derived caller are ignored, never stored.
- **v1 pull:** same derivation first. When derived Free, session/history rows
  are projected with the Pro-dimension columns replaced by the safe defaults
  (shape unchanged, values gated). A Free account therefore cannot read back
  Pro dimensions it wrote through v1 while Pro, nor accumulate new ones.
- **Legacy unversioned profile (no `readingStatsVersion`):** wire keys stay
  byte-identical, but values are gated: `totalWords = 0`, `streakDays = 0` for
  Free-derived callers; `totalSeconds` and the level ladder stay live (computed
  from Free totals, same ladder authority). This is an intentional value change
  for Free on a deprecated surface; shape compatibility is preserved, Pro-value
  compatibility is not.
- Precedence with the race guard is unchanged: if expiry lapses between the
  probe and the resolve, the caller sees the existing `409 plan_changed`
  (`reading plan changed; refresh and retry`) rather than a contract error. The
  409 wins over `pro_fields_not_allowed` in that interleaving only.

## Push / Pull / Profile Interactions

All plan-aware surfaces keep their existing order of operations; only the plan
resolution step changes from stored-flag to derived-effective-plan. Strict
contract parsing, owner policy, idempotency, and response shapes are unchanged.

- `v2PlanProbe`: select the new columns alongside `reading_stats_plan`
  (`plan, planExpiresAt`, plus any columns the admin surface needs — never auth
  anchors), derive `effectiveReadingPlan(row, Date.now())`, and branch parsers on
  the derived value. Still read-only and non-provisioning.
- `pushV2` / `pullV2`: after `v2SyncUser`, derive the effective plan from the
  freshly resolved row; on probe/resolve disagreement keep the existing `409
  plan_changed` (`reading plan changed; refresh and retry`). `plan` in success
  bodies is the derived effective plan. A Pro-shaped push arriving after expiry
  probes as Free, fails Free strict parsing with `pro_fields_not_allowed`, and the
  client refreshes (profile) and retries as Free — no data is silently stripped.
- `GET /me/profile?readingStatsVersion=2`: derive from the selected row
  (`PROFILE_USER_COLUMNS` extended with the expiry columns, never projected to
  the client) and serve the Pro or Free projection accordingly. `plan` in the body
  is the derived plan. Legacy unversioned profile stays byte-for-byte plan-blind.
- `SYNC_USER_COLUMNS` and `PROFILE_USER_COLUMNS` are extended with the new
  entitlement columns; `toPublic()` gains no new keys (expiry timestamps are never
  serialized to clients).
- No `plan`, `planExpiresAt`, or `readingStatsVersion`-adjacent field is ever
  accepted from the request: the strict schemas already forbid `plan`-like keys
  (`FREE_SESSION_FORBIDDEN_KEYS` includes `statsPlan`/`isPro`; envelope forbids
  Pro collections on Free), and the entitlement columns are not part of any
  request schema.

## Downgrade / Upgrade Behavior

- Downgrade is immediate at `planExpiresAt` with no grace by default. It is
  observed, not executed: the next push/pull/profile request derives Free. No job
  flips stored rows; stored `plan`/`planStatus` may still read `'pro'`/`'active'`
  after expiry — the derived plan is what gates. (An admin reconcile that labels
  stale rows `'expired'` is optional hygiene, never a correctness dependency.)
- On downgrade Pro data is hidden, not deleted: pull serves the Free projection,
  profile serves the Free projection, and Pro aggregates (words, streaks, WPM,
  hourly/genre, chapter-state collections) are simply not computed or returned.
  All `reading_sessions` rows (including `proFieldsPresent = true` rows),
  `reading_history`, `user_library`, `reading_chapter_state`, and `reading_novels`
  rows remain intact, so a later renewal restores full Pro aggregates computed
  over the preserved history.
- Queued Pro data remains locally deferred (client guidance, not a server
  guarantee — no app-repo changes are in scope, so no test here can pin client
  behavior): a client holding unsynced Pro sessions across expiry should keep
  them queued; its next Pro-shaped push is rejected by the Free contract, and
  it should retain (not drop) the queue until Pro is renewed, then flush
  normally. The server never instructs deletion and never deletes reading rows
  on any entitlement transition (server-guaranteed, tested).
- Upgrade/renewal restores Pro immediately (next request derives Pro once
  `planExpiresAt` is in the future). No backfill or recomputation step is needed
  because nothing was deleted; aggregates are computed live from stored rows.
- Existing reading data is preserved in both directions: this design adds no
  DELETE/UPDATE to any reading table on any entitlement transition.

## Renewal / Admin API / Integration Boundary

Automatic payment renewal is out of scope. The only writer of entitlement columns
is a trusted manual admin/internal operation:

- **Boundary:** `POST /api/v1/admin/users/:id/reading-plan` (path owned by the
  plan author; an internal function `grantReadingPlan()` behind the same authz is
  an acceptable alternative). Auth: existing Bearer auth plus admin role check
  (`users.role = 'admin'`); non-admin callers receive the existing
  forbidden/unauthorized bodies, never an entitlement hint. Rate-limited with the
  existing admin/users budgets; no new middleware.
- **Request (sketch):** `{ plan: 'pro' | 'free', durationDays?: number (default
  30, positive int, capped e.g. ≤ 365), reason?: string }`. No timestamps accepted
  from the caller — the server computes all window timestamps. Retries are
  **additive by contract in v1**: a retried grant intent creates a second
  extension. Operators confirm the result before retrying; clients disable
  double-submit. (A server-issued idempotency key is a future enhancement, not
  v1.)
- **Concurrency (normative):** the grant handler runs
  `SELECT ... FOR UPDATE` on the subject `users` row inside the same transaction
  as the `users` update + event insert. Two concurrent grants serialize: the
  second reads the first grant's `new_expires_at` as its base, so no extension
  is lost. The existing admin budget applies (`app.ts` already mounts
  `app.use('/api/v1/admin/*', rateLimit(60))`); no new middleware.
- **Renewal window math (normative):** let `now = Date.now()`,
  `previousExpiresAt` be the locked row's `reading_stats_plan_expires_at`, and
  `durationMs = durationDays * 86400_000`. Coerce corrupt values first: if
  `previousExpiresAt` is not a safe integer (string, NaN, float, negative),
  treat it as null (fail-closed extension, never widen). Then:
  `base = previousExpiresAt !== null && previousExpiresAt > now ? previousExpiresAt : now`;
  `startedAt = <previous live window's startedAt preserved when base is the old expiry, else now>`;
  `expiresAt = base + durationMs`.
  Concretely: renewing a live window preserves the continuous-coverage
  `startedAt` and moves only the expiry; a fresh grant (no live window) sets
  `startedAt = now`. After stacking, `expiresAt - startedAt != duration` by
  design — `startedAt` marks coverage start, `lastRenewedAt` marks the last
  grant execution.
  Rationale: an early renewal while Pro is still active extends from the current
  expiry (`expiresAt + duration`), so remaining paid days are never lost; a
  renewal after expiry (or on a Free row) starts from `now`. This is the same
  `max(now, currentExpiry) + duration` rule: no silent forfeiture, no overlap
  double-grant of wall-clock access.
- **Effects:** `pro` sets `plan='pro'`, all window columns, `lastRenewedAt=now`,
  `status='active'`, increments `renewalCount` by exactly one, and adds exactly
  `durationMs` to `totalSubscribedMs` (see § Total-subscribed-time definition);
  `free` (revoke) sets `plan='free'`, clears `expiresAt` and `graceUntil` to
  `null`, sets `status='cancelled'`, preserves `startedAt`, `lastRenewedAt`,
  `durationDays`, `renewalCount`, and `totalSubscribedMs`, and leaves all
  reading tables untouched. (`'cancelled'` is pinned: a revoke is always an
  explicit admin act, never the silent Free default.) Renewal extends per the
  window math above (never overwrites a live expiry with `now + duration`).
  Revocation preserves history counters so cancelled accounts retain
  subscription history.
- **Response:** `{ success: true, effectivePlan, planExpiresAt, planStatus }`
  (never auth anchors). **Audit:** structured log
  `{ event: 'reading_plan.grant', userId, plan, durationDays, expiresAt, actor }`
  **plus** a durable row in `subscription_events` (§ Subscription event log).
  The log line alone is not the audit trail; the table is.
- No billing/provider integration point, no webhook receiver, no invoice storage.
  If billing ever lands, it calls this same boundary; nothing in sync/profile
  needs to change.

## Total-Subscribed-Time Definition (normative)

`reading_stats_total_subscribed_ms` is the **cumulative granted duration**: the
sum of `durationDays * 86400_000` over every successful Pro grant/renewal. It
is **not** a deduplicated measure of wall-clock days the account spent Pro.

Because renewal extends from `max(now, previousExpiresAt)`, successive grants
do not overlap in wall-clock access, so in practice the sum equals the total
granted Pro time. But dashboards and admin surfaces must label it exactly as
"cumulative granted Pro time", never as "actual days spent Pro" — e.g. two
manual 30-day grants in a row display as 60 days granted even if the second was
issued one day after the first (the second window simply starts at the first
window's expiry). It is display/audit only and never an entitlement input.

## Subscription Event Log (normative)

Counters alone cannot answer "who renewed this account, when, from what expiry
to what expiry, and why". Every Pro grant/renew and every Pro revoke writes one
row to a new append-only table in the same transaction as the `users` update:

```text
subscription_events
  id                    serial primary key
  user_id               uuid not null references users(id) on delete cascade
  type                  varchar(16) not null check (type in ('grant','renew','revoke','expired'))
  actor_id              uuid references users(id) on delete set null
  previous_expires_at   bigint
  new_expires_at        bigint
  duration_days         integer
  reason                varchar(500)
  occurred_at           bigint not null
  received_at           timestamp not null default now()
  index(user_id, occurred_at, id)
```

Rules:

- `grant` = first Pro grant on a row with no prior grant history; `renew` = any
  later Pro grant. The distinction is decided inside the locked transaction
  from history (`renewalCount > 0` or any prior `grant`/`renew` event), never
  from the request. Both increment `renewalCount` (it is a grant counter in
  practice); `revoke` and `expired` never touch `renewalCount` or
  `totalSubscribedMs`.
- `actor_id` is the admin/trusted operator that executed the grant (never the
  subject user unless self-grant is an explicit future policy). Null only when
  the actor row is unavailable; the structured log still carries the actor.
  For `type = 'expired'`, `actor_id` is always null: null here means "system",
  not "missing admin". `reason` for `expired` is the fixed string
  `system: natural expiry`, never caller input.
- `previous_expires_at` / `new_expires_at` are the exact values before and after
  the `users` update (null where absent). `duration_days` is the granted
  duration for grant/renew, null for revoke and expired. `reason` is the
  caller-supplied reason verbatim for grant/renew/revoke (bounded, never auth
  material). For `expired`: `previous_expires_at` = the window expiry that just
  lapsed, `new_expires_at` = null, `duration_days` = null,
  `occurred_at` = detection time (`Date.now()` of the observing request), not
  the expiry boundary itself — the boundary is already stored in
  `previous_expires_at`.
- The event write and the `users` update commit atomically for
  grant/renew/revoke: a grant that fails to log fails entirely, and a logged
  event always matches the stored window.
- No event row is ever updated or deleted except by account deletion cascade.
- `occurred_at` (bigint epoch ms) is the server event time, set by the writer
  from `Date.now()`; `received_at` (timestamp default now()) is the database
  ingest time, set by Postgres. The two clocks exist so a skewed or replayed
  writer cannot rewrite history: ordering and windowing always use
  `occurred_at`, while `received_at` answers "when did this row land".
- Admin/read surfaces for events are out of scope for v1; the table exists so a
  later investigation ("who renewed account X on date Y and why?") has a
  complete answer without reconstructing it from counters.

### Natural-expiry observation (normative)

Expiry is still derived, never executed by a background job. But the first
request that observes an already-lapsed window must leave one audit trace, or
the most common downgrade path stays silent:

- When `pushV2` / `pullV2` / `GET /me/profile?readingStatsVersion=2` derives
  Free because `nowMs >= planExpiresAt` on a row whose stored `plan = 'pro'`,
  the same handler attempts one best-effort `expired` insert **after** the
  response inputs are computed, in a **separate step, not in the request's data
  transaction** (not in the Free session insert, not in the profile aggregate).
- Idempotency key is `(user_id, previous_expires_at)` for `type = 'expired'`:
  enforced by a partial unique index on
  `(user_id, previous_expires_at) WHERE type = 'expired'`, written with
  `ON CONFLICT DO NOTHING`. Ten concurrent first-observers produce exactly one
  row; every later request for the same lapsed window is a logical no-op.
- **Null-key guard (normative):** `previous_expires_at` is nullable, and
  `NULL != NULL`, so a corrupt pro-with-null-expiry row must **never** attempt
  the insert — it would mint one unbounded `expired` row per request. Attempt
  the `expired` insert only when `previous_expires_at` is a safe integer;
  otherwise skip silently (derivation already fails closed to Free).
- **Per-request cost (accepted):** stored `plan`/`planStatus` are never flipped
  on expiry, so every post-expiry push/pull/profile pays one indexed
  `INSERT ... ON CONFLICT DO NOTHING` attempt (one round-trip, conflict-no-op
  after the first). This is the price of keeping derivation write-free for the
  data path: quantified as a single cheap upsert on an already-authenticated
  request, not a scan. A one-time status flip was rejected because it would put
  a `users` write on the read path.
- Failure semantics (deliberately different from grant/renew): the `expired`
  insert **never fails the request, never trips the storage breaker, and never
  blocks the response**. It never calls `noteDbFailure()` (the push write path
  does; the expired logger must not). Storage failure is a structured warn
  (`sync.plan_expired_log`, `profile.plan_expired_log`) and the next request
  retries the insert. Derivation stays pure: the response is identical whether
  the log write succeeded or not.
- No `users` write accompanies the `expired` row in v1 (stored `plan` may still
  read `'pro'`/`'active'` after expiry; the derived plan is what gates). An
  admin reconcile that later labels stale rows `'expired'` is optional hygiene,
  never a correctness dependency.
- `renewalCount` / `totalSubscribedMs` are untouched by `expired` rows: they
  count grants, and the expired window was already counted when it was granted.

## Timezone / Clock Rules

- All entitlement timestamps are UTC epoch milliseconds (`bigint`, same
  convention as session `ts`/`updatedAt`). No date strings, no local offsets, no
  `YYYY-MM-DD` math in entitlement paths.
- The only clock is server `Date.now()` at request time. Client clocks
  (`session.ts`, device wall time, `readDay` calendar days) never influence
  entitlement. `CLIENT_CLOCK_SKEW_MS` remains scoped to session-timestamp
  clamping.
- Duration arithmetic is `durationDays * 86_400_000` on the server; DST and
  calendar months are irrelevant by construction. Expiry comparison is integer
  `<`, no rounding, no tolerance window.

## Security / Entitlement Boundaries

- Server is authoritative: plan and expiry come only from the `users` row read
  inside the request. Client-sent plan/expiry keys do not exist in any request
  schema and are rejected as `pro_fields_not_allowed`/`unknown_key` where they
  collide with strict shapes.
- Owner policy unchanged: authenticated caller may touch only its own
  `externalId`; admin grant path is the sole cross-user writer and requires admin
  role.
- Free projection contains no Pro keys (`PRO_ONLY_STATS_KEYS` assertion pattern
  in existing tests); expiry timestamps are never serialized to any client.
- Read-only surfaces never trip the storage breaker (`noteDbFailure` only on
  write-path failures, per existing convention); entitlement derivation itself
  never writes.
- Enumeration/audit: admin grant logs actor + subject + window; sync/profile
  409/400 bodies reveal nothing about other users' windows.

## Backward Compatibility

- Existing rows: Free rows behave identically (all new columns null/ignored);
  existing Pro rows receive one 30-day window at migration (§ Migration Strategy)
  instead of instant revocation.
- Wire: v2 Free/Pro request/response schemas unchanged; `plan` values remain
  `'free'`/`'pro'` (now derived rather than stored). Legacy v1 sync and legacy
  unversioned profile payloads unchanged and remain plan-blind.
- Client upgrade path: an expired Pro client sees `plan: 'free'` on its next
  profile/push/pull plus the existing `409 plan_changed` / strict-contract errors
  it already handles (`refresh and retry`); queued Pro sessions stay queued per §
  Downgrade. No new error codes are introduced on sync/profile surfaces.
- Stored-plan fallback: no code may fall back to trusting the raw stored `plan`
  flag when expiry columns are present. The fail-closed derivation is the only
  reader.

## Testing / Acceptance Criteria

Unit (no DB): effective-plan matrix — Free stays Free; Pro with future expiry →
  Pro; Pro at/after expiry → Free; Pro with null/NaN/negative expiry → Free;
  `graceUntil` set or null → still Free after expiry (default policy); trial
  fields populated → ignored. Boundary test at `expiresAt - 1` / `expiresAt`.
Contract (existing harness + seedable fake): expired-Pro push of a Pro-shaped
  body is parsed as Free and rejected with `pro_fields_not_allowed` (not stored);
  `409 plan_changed` preserved for probe/resolve races; profile `?readingStatsVersion=2`
  returns `plan: 'free'` + Free projection after expiry and `plan: 'pro'` + Pro
  projection before; expiry columns absent from every wire body (parsed + serialized-text checks).
Persistence: downgrade changes no reading-table row counts; renewal restores Pro
  aggregates over pre-expiry rows; queued-Pro retry after renewal is accepted
  (idempotency preserved, no duplicates).
Admin: non-admin grant → forbidden; grant sets window columns per the
  `max(now, expiry)` rule, increments `renewalCount`, adds the granted duration
  to `totalSubscribedMs`, emits the audit log, and writes the atomic event row;
  revoke clears expiry, preserves history counters, writes a `revoke` event row,
  and derives Free on the next request; `durationDays` default 30, cap enforced,
  invalid values 400. Expiry: first push/pull/profile that observes a lapsed
  window writes exactly one `expired` row (`actor_id` null, fixed reason,
  `previous_expires_at` = lapsed expiry) via `ON CONFLICT DO NOTHING` on the
  partial unique key; concurrent observers converge; a failed log write never
  fails the request and never trips the breaker; second and later observations
  write nothing.
Regression: `npm run typecheck`, `npm test`, `npm run build` all exit 0. This
  specification runs none of these.

## Rollout / Observability

- Order: migrate columns → backfill existing Pro windows → deploy derivation +
  extended selects → expose admin grant → verify with a canary Pro account
  (grant → push/pull/profile Pro → force expiry via short admin grant → confirm
  Free derivation with data intact → re-grant → confirm Pro restored).
- Logging (structured JSON, existing conventions): `sync.plan_probe` gains
  `effectivePlan` (never expiry timestamps at info level);
  `reading_plan.grant` / `reading_plan.revoke` with actor/subject/window;
  `profile.storage` / `sync.pro_read` 503 paths unchanged.
- Metrics/counters (if the repo's observability supports them; otherwise logs):
  derived-Pro vs derived-Free counts on v2 push/pull/profile, `plan_changed` 409
  rate, admin-grant rate. Alert on a post-deploy cliff (mass 409/contract-failure
  spike indicates backfill failure) and on any Pro-projection served with an
  expired window (indicates derivation bypass).
- No background job to monitor; no cache to purge (profile v2 responses are
  `private, no-store`).

## Trial Activation Policy Stub

Schema reserves `trialStartedAt` / `trialEndsAt`; policy disables them:

- No route, admin action, or sync/profile path reads trial columns in this
  design. The effective-plan algorithm ignores them unconditionally.
- Any future trial feature requires its own spec covering: eligibility (one per
  user), duration, whether trial stacks with paid Pro, abuse controls, and
  whether trial expiry differs from paid expiry. Until that spec ships, writing
  non-null trial columns has no user-visible effect, and tests pin that
  inertness.

## Files To Change (implementer checklist)

| File | Proposed change |
|---|---|
| `src/database/schema.ts` | Add the ten columns + `plan_status` check + new `subscription_events` table with type check and `(user_id, occurred_at, id)` index; keep existing `readingStatsPlan` default/check. |
| `drizzle/*` | Generated migration for the above + documented backfill for existing Pro rows. |
| `src/features/readingSync/freeStore.ts` | Extend `authoritativePlan` (or add `effectiveReadingPlan(row, nowMs)`) per § Effective-plan algorithm; fail closed. |
| `src/routes/sync.ts` | Extend `SYNC_USER_COLUMNS` + `v2PlanProbe` select; derive in `pushV2`/`pullV2`; gate the legacy v1 session/history writes and pulls per § Legacy v1 gating; keep parse→resolve→409 order (`409 plan_changed` wins when expiry lapses mid-race); `plan` in responses = derived. Clean up the stale `sync.ts` comment claiming Pro push is unimplemented. |
| `src/routes/profile.ts` | Extend `PROFILE_USER_COLUMNS` (read-only, never projected); derive in the `readingStatsVersion=2` branch; gate legacy unversioned aggregates per § Legacy v1 gating (keys unchanged, Free values zeroed). |
| `src/routes/admin.ts` | Add `POST /api/v1/admin/users/:id/reading-plan` behind the existing `requireAuth` + admin-role gate (already rate-limited by `app.use('/api/v1/admin/*', rateLimit(60))`): row-locked grant/revoke with atomic event row, `max(now, expiry)` math, additive-retry contract, audit log. |
| `scripts/backfill-pro-subscription.*` (new) | One idempotent backfill for existing Pro rows incl. one `grant` event each (`reason = 'system: migration backfill'`). |
| Tests | Effective-plan matrix (incl. trial/grace inertness), probe/parse/409 precedence cases, profile Free-after-expiry, v1 write/read gating, downgrade-preserves-data, renewal-extension math (`max(now, expiry)`), corrupt-expiry coercion, total-subscribed-ms accumulation, event-row atomicity and field values, expired null-guard + idempotency + no-breaker, admin authz/defaults/caps, backfill event invariant. |

`contracts.ts`, `calculations.ts`, `proStore.ts`/`proProtocol.ts` shapes and
`wrangler.toml`/`worker.ts` need no functional edits for this design. Legacy v1
sync/profile code paths do need the value-gating edits above.

## Risks And Mitigations

1. **Mass downgrade on deploy.** Existing Pro rows have no expiry. *Mitigation:*
   one 30-day backfill window at migration; alert on 409/contract-failure cliffs.
2. **Stored-flag trust bypass.** Code reading raw `plan` without expiry reopens
   permanent Pro. *Mitigation:* single derivation function; review rejects any
   other reader; corrupt-expiry fail-closed tests.
3. **Client data loss on expiry.** A client might drop queued Pro sessions when
   its push is rejected. *Mitigation:* contract rejection (not silent strip) +
   specified client behavior (defer, don't drop); server never deletes.
4. **Admin misuse.** Manual grants are powerful. *Mitigation:* admin-only,
   capped durations, reason field, structured audit log.

## Decision Summary

- Free is permanent; Pro is a 30-day-default server-granted window tracked by
  ten new `users` columns (trial pair stored but inert, grace default null,
  plus `renewalCount` and cumulative `totalSubscribedMs`).
- Effective plan is derived per request from UTC epoch-ms expiry; no background
  job; expiry boundary belongs to Free; corrupt/missing expiry fails closed.
- Push/pull/profile keep their probe→parse→resolve→409 flow, branched on the
  derived plan; wire contracts and idempotency unchanged; expiry never leaves the
  server.
- Downgrade hides (never deletes) Pro data; queued Pro sessions defer locally;
  renewal restores full aggregates from preserved rows.
- Only a trusted manual admin operation writes entitlement (row-locked,
  additive retries, atomic event row); no billing, webhooks, trials activation,
  leaderboards, or UI changes.
- Legacy v1 sync and the unversioned profile are gated like v2 (shapes kept,
  Free values zeroed/defaulted); natural expiry logs one idempotent `expired`
  row per window without failing reads or tripping the breaker.

## Assumptions And Open Questions

- Assumed: granting existing Pro rows a fresh 30-day window at migration is
  acceptable product behavior (vs immediate expiry); flagged for product sign-off.
- Pinned: `durationDays` cap is 365; revoke `planStatus` is always `'cancelled'`.
- No open questions blocking the plan; trial activation and any future grace
  policy each require their own spec.
