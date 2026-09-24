# Decoration Store Backend Phase 1: Design

**Date:** 2026-09-19
**Status:** Approved brainstorm scope; audited design specification (specification only, no product code)
**Repository:** `/home/x1carbon/Projects/fan-novel-server`
**Runtime:** Cloudflare Workers + Hono + Drizzle + Neon Postgres (live deployment `12f18023`)
**Scope:** Server-side decoration store backend phase 1 only. No app-repo changes.

## Goal

Provide a server-authoritative backend for four uniform decoration types (avatar frames, nameplates, profile frames, profile effects) with three acquisition channels (admin-granted coins, admin-recorded real-money purchases as an explicit stub, and tiered VIP folder unlocks), a full entitlement snapshot endpoint for login/foreground auto-sync, and equip-time validation enforcing the never-free rule: no decoration equips without a live ownership row or a live VIP derivation, and identity for all privileged and user-scoped routes comes from the verified `google_subject` session exactly as established by the Phase 1 identity hardening.

## Non-Goals

- Google Play receipt verification (real-money verification is a stub; backend records admin-confirmed purchases only).
- Coin earning rules, quests, daily rewards, or any balance credit path other than explicit admin grants.
- Any change to the `Fan Novel` app repository (`/home/x1carbon/Projects/Fan Novel`), including store UI, local caching, or offline entitlement behavior.
- CDN custom domain, R2 bucket configuration, credential rotation, or asset uploads; the existing R2 layout `fan-novel-assets/frames/1_VIP1, 2_VIP2, …` is read as a naming convention only.
- Legacy-account migration, email-based linking, heal logic, or any modification/deletion of existing database content or committed migration history (`drizzle/0000`–`0006` and journal entries `idx 0`–`6` are immutable).
- Session revocation, refresh-token redesign, rate-limit overhaul, CORS changes, or general novel-ownership remediation.
- Deploying, migrating production, or running live tests as part of this specification-only change; release gates are documented but not executed here.

## Context

- The server is Hono with Drizzle/PostgreSQL, running on Node locally and Cloudflare Workers in production. `src/database/db.ts` selects a Node pool or the Neon HTTP driver; a configured database is not necessarily reachable, and failure paths fail closed with 503.
- Identity is hardened: `src/routes/googleIdentity.ts` returns a typed verified identity (subject + lowercased email) only after tokeninfo validation of subject, email, issuer, audience, `email_verified`, and expiry. `src/routes/googleAccount.ts:resolveGoogleAccount` provisions accounts by `googleSubject` with canonical external ID `google_<verified sub>`, single-insert atomicity, and 409 on uniqueness conflicts. Session JWTs carry `sub = users.externalId` (`src/middleware/auth.ts`, `src/routes/auth.ts`).
- Admin gating pattern (`src/routes/admin.ts:11-19`): every `/admin/*` route runs `requireAuth` then `getCaller` (resolved from `users.externalId = token sub` via `src/middleware/ownership.ts`), returning 401 when the caller row is missing and 403 when `role !== 'admin'`. Each handler independently returns 503 when `isDbAvailable()` is false and records driver failures via `noteDbFailure()`. New privileged decoration routes follow this exact pattern; no new auth primitive is introduced.
- `users` table (`src/database/schema.ts:6-21`) has a stable UUID primary key, unique nullable `external_id`, `google_subject`, `email`, and `username`, plus display fields and role/creator flags. Library, history, sessions, role requests, API keys, and comments reference the UUID. The new design references `users.id` the same way and adds only nullable equipped-decoration references (no change to identity columns).
- Sync philosophy (`src/routes/sync.ts`): client clocks are ordering authority for library data, but authentication data is never client-writable; production sync never provisions accounts. The decoration store applies the same philosophy one level stricter: the client never grants ownership — ownership rows are created only by coin-spend transactions, admin-recorded purchases, admin grants, or VIP derivation evaluated on the server.
- Migration convention: additive SQL files in `drizzle/` (`0000`–`0006` applied), registered in `drizzle/meta/_journal.json` and accompanied by a `drizzle/meta/<NNNN>_snapshot.json`. The next sequence is `0007` at journal `idx 7`. Committed history is never edited.
- Release discipline (`docs/superpowers/runbooks/phase1-security-release.md`) applies to any database change: exact production-config validation without printing secrets, read-only health/emptiness gates, migration through the Drizzle journal workflow with post-migration column/constraint verification, `wrangler deploy` only after explicit authorization, and bounded transactions with row-count assertions. This spec extends those gates to the new tables without weakening any of them.
- R2 asset layout (context only, not modified): decoration art already lives under `fan-novel-assets/frames/1_VIP1, 2_VIP2, …`. The backend stores the folder/prefix string per item; it never serves image bytes and never lists bucket contents.

## Proposed Architecture

### 1. Uniform decoration model

All four decoration types share one table and one entitlement pipeline. The type discriminator is a closed enum; no per-type tables, no per-type endpoints, no per-type business rules.

- Type enum (exact values): `avatar_frame`, `nameplate`, `profile_frame`, `profile_effect`.
- Every catalog row carries: `type`, `slug` (stable, unique, URL-safe, e.g. `golden-lion-vip2`), `title`, `folder` (positive integer matching the R2 folder number, e.g. `2`), `asset_prefix` (exact R2 prefix string, e.g. `frames/2_VIP2`; stored verbatim, never constructed from user input), optional `coin_price` (nullable positive integer; null means not purchasable with coins), optional `money_sku` (nullable non-empty string; null means not purchasable with money), optional `vip_tier` (nullable positive integer; null means not included in any VIP folder), `is_active` flag, timestamps.
- A row is purchasable/unlockable only through the channels its non-null fields declare. A row with all three of `coin_price`, `money_sku`, and `vip_tier` null is inert: it appears in the catalog only when `is_active` is true but cannot be acquired by any route (admin direct-grant excepted for support tooling). Price-zero coin rows do not exist: `coin_price`, when present, is an integer >= 1, so there is no free path even by misconfiguration.
- `slug` is immutable after creation (admin edits may change title, prices, SKU, tier, and active flag, but never the slug or the type). Folder renames are performed by deactivating the old row and creating a new row, never by rewriting history, so existing ownership rows keep pointing at the exact asset the user acquired.

### 2. Coin wallet and transaction ledger (admin-funded, user-spent)

No coin system exists yet, and phase 1 deliberately adds no earning rules. Coins enter circulation only through explicit admin grants; they leave only through decoration purchases.

- `coin_wallets`: one row per user (`user_id` primary key referencing `users.id` on delete cascade), `balance` integer >= 0 defaulting to 0, `updated_at`. There is no negative balance in any state; the check constraint enforces it at the database level.
- `coin_transactions`: append-only ledger. Each row records `user_id`, signed `delta` (positive for grants, negative for spends), `balance_after` (the wallet balance immediately after applying the delta), `reason` enum (`admin_grant`, `purchase`), optional `item_id` (set for purchases), optional `admin_id` (the granting admin's `users.id` for grants; null for user-initiated spends), optional `note` (free text, max 500 chars), and `created_at`. Rows are never updated or deleted.
- Grant flow (admin): validate `amount` is an integer in `1..1_000_000`; inside a single bounded unit of work, read-or-create the wallet row, add the amount, insert exactly one `coin_transactions` row with `reason = 'admin_grant'`, `delta = +amount`, `balance_after` equal to the new balance, and `admin_id` set to the caller. Assert exactly one wallet row written and exactly one ledger row inserted; any other count rolls back and returns 500 without partial mutation.
- Spend flow (user purchase): validate the item exists, is active, has a non-null `coin_price`, and the caller does not already hold a live ownership row for it (duplicate purchase returns 409 `already_owned` with no charge). Inside a single bounded unit of work, lock the wallet row, reject with 409 `insufficient_balance` when `balance < coin_price`, decrement the balance, insert exactly one `coin_transactions` row (`reason = 'purchase'`, `delta = -price`, `balance_after` set, `item_id` set, `admin_id` null), and insert exactly one `decoration_ownership` row (`source = 'coin'`). Assert one wallet update, one ledger insert, one ownership insert; conflicts on the ownership unique key converge to 409 `already_owned` with the wallet write rolled back so a racing double-tap can never double-charge.
- The Neon HTTP driver does not guarantee interactive transactions; the implementation therefore performs the spend as a single SQL transaction block (one round trip) with `SELECT … FOR UPDATE` on the wallet row, and relies on the `(user_id, item_id)` unique constraint plus the `balance >= 0` check constraint as the correctness backstop rather than on application-level locking.

### 3. Real-money purchases (explicit stub)

Phase 1 records purchases the administrator confirms out of band. There is no receipt endpoint, no Play Developer API call, no signature check, and no client-submitted proof accepted as authority.

- `POST /api/v1/admin/decorations/purchases/record` accepts `user_id` (users UUID), `item_id`, `sku` (must equal the item's current `money_sku`), and `order_reference` (non-empty, max 255, globally unique). It validates the item is active and money-eligible, then inserts one `decoration_ownership` row (`source = 'money'`, `order_reference` set) and one `money_purchase_records` audit row (`user_id`, `item_id`, `sku`, `order_reference` unique, `recorded_by` = admin caller id, `recorded_at`). Duplicate `order_reference` returns 409 with no ownership row created. A SKU mismatch returns 400. The response includes an explicit `verification: 'stubbed-manual'` field so no caller can mistake this for verified revenue.
- Client-submitted purchase tokens, order IDs, or receipts are never accepted by any user-facing route in this phase; the user-facing purchase route handles coins only. When Play verification lands in a later phase, it reuses the same `decoration_ownership` table with `source = 'money'` and fills a then-mandatory receipt column; the stub's `order_reference` uniqueness carries over unchanged.

### 4. VIP tier-per-folder with read-time expiry

VIP matches the existing R2 layout: folder `N` belongs to VIP tier `N`, and VIP level `N` unlocks folders `1..N` while the grant is active. Expiry revokes access at read time; there is no cron job, no background worker, and no lazy deletion.

- `vip_grants`: one row per user (`user_id` primary key referencing `users.id` on delete cascade), `tier` integer >= 1, `expires_at` timestamp with timezone (must be in the future at assign time), `granted_by` (admin caller id), `created_at`, `updated_at`. Assigning VIP to a user who already holds a grant overwrites tier and expiry in place (upsert); revoking deletes the row. There is at most one live grant per user by construction.
- Read-time evaluation: a VIP grant is live if and only if the row exists and `expires_at > now()` evaluated with the database clock at query time. Every entitlement computation (snapshot, equip validation) re-evaluates liveness; an expired row grants nothing even though the row still exists until revoked or overwritten. Expired rows are left in place (they are evidence of past entitlement) and impose no scheduled cleanup.
- Folder unlock rule: item with `vip_tier = T` is VIP-accessible to a caller whose live grant has `tier >= T`. An item with null `vip_tier` is never VIP-accessible. VIP access is derived on every read from `vip_grants` joined against `decoration_items`; it is never materialized as ownership rows, so tier changes and expiries take effect immediately with no fan-out writes.
- The `decoration_ownership.expires_at` column exists for future time-limited promo grants and stays null for all phase-1 coin, money, and admin-grant rows. VIP-derived access never writes to the ownership table; the ownership table is therefore the permanent-grant ledger and `vip_grants` is the time-boxed entitlement source, with no overlapping authority and no double source of truth.

### 5. Ownership ledger and the never-free rule

- `decoration_ownership`: `(user_id, item_id)` unique pair referencing `users.id` (cascade) and `decoration_items.id` (restrict: catalog rows with any ownership row cannot be hard-deleted, only deactivated). Columns: `source` enum (`coin`, `money`, `admin_grant`), `granted_at`, `expires_at` (null in phase 1), optional `order_reference` (set only for `money`), optional `granted_by` (set only for `admin_grant`). Rows are inserted by the three server-side flows only; there is no user-facing route that inserts a row without spending coins, and no bulk self-grant.
- A row is live when `expires_at IS NULL OR expires_at > now()`. All phase-1 rows are permanently live once written. Ownership rows are never deleted by user action; support corrections are performed through admin-only routes that are themselves audit-logged.
- Never-free rule (normative): every equip validation requires either a live ownership row for the exact item or a live VIP derivation covering the item's folder. Price-null items, inactive items, unknown ids, and expired derivations all fail equip. The client snapshot is a hint for rendering; it never confers authority.

### 6. Equipped state

Equipped selection is stored on the `users` row as four nullable foreign keys (`equipped_avatar_frame_id`, `equipped_nameplate_id`, `equipped_profile_frame_id`, `equipped_profile_effect_id`, each referencing `decoration_items.id` with `ON DELETE SET NULL`). Rationale: exactly one equipped item per slot per user is a natural column constraint, reads piggyback on the existing `/me`-style user fetch without an extra join table, and updates are single-row atomic writes.

- Equip route validates: the item exists (else 404), the item is active (else 410 `item_inactive`), the item's `type` matches the target slot (else 400 `type_slot_mismatch`), and the caller holds a live entitlement for the exact item (else 403 `not_owned`). Unequip (null item) always succeeds for a well-formed slot name. Equipping an item the caller owns in a different slot's type is rejected, not reinterpreted.
- Equipping does not consume or modify ownership; it only points at entitled items. Deactivating a catalog item does not unequip current wearers (their ownership rows remain live and their equipped pointers remain valid and continue to render), but no one — including existing owners who unequip — can newly equip a deactivated item (equip validation returns 410 regardless of ownership), and no one can newly acquire it. This preserves what users paid for while closing the acquisition path.
- Profile PATCH (`PATCH /api/v1/auth/me`) is not extended: equipped fields are writable only through the dedicated equip route so that validation cannot be bypassed through the generic profile editor.

### 7. API surface

All routes are versioned under `/api/v1/decorations` and `/api/v1/admin/decorations`. Rate limiting follows the existing `src/app.ts` convention (`60` for admin and decoration routes). Error bodies are JSON `{ error, code? }` with no driver diagnostics, no secrets, and no stack traces. Timestamps are ISO-8601; money amounts are never present (SKU strings only, no prices in fiat).

| Method & path | Auth | Purpose and semantics |
| --- | --- | --- |
| `GET /api/v1/decorations/catalog` | None (public) | Lists all active catalog rows: `id, type, slug, title, folder, asset_prefix, coin_price, money_sku, vip_tier`. Inactive rows are excluded. No ownership or wallet data. Paginated (`page`, `limit` max 100, default 50) ordered by `(type, folder, slug)`. |
| `GET /api/v1/decorations/sync` | `requireAuth` (user) | Full entitlement snapshot for login/foreground auto-sync. Resolves caller by token `sub → users.externalId` (401 when the row is missing, 503 when the database is unavailable). Returns `balance`, `owned_item_ids` (live ownership rows), `vip: { tier, expires_at } \| null` (live grant only; expired grants return null), `equipped: { avatar_frame, nameplate, profile_frame, profile_effect }` (item ids or null), and `server_now`. The response is read-only and confers no ownership. |
| `POST /api/v1/decorations/purchase` | `requireAuth` (user) | Coin spend for one `item_id` (zod: UUID string). Returns 404 unknown item, 410 inactive item, 400 not coin-eligible, 409 `already_owned`, 409 `insufficient_balance`. Success returns the new `balance` and the `item_id`. |
| `PUT /api/v1/decorations/equip` | `requireAuth` (user) | Sets or clears one slot: `{ slot: 'avatar_frame' \| 'nameplate' \| 'profile_frame' \| 'profile_effect', item_id: UUID \| null }`. Enforces the equip validation in §6. Returns the full `equipped` map. |
| `POST /api/v1/admin/decorations/items` | `requireAuth` + admin | Creates a catalog row. Validates the closed type enum, slug format (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 100), folder >= 1, `asset_prefix` non-empty max 500, `coin_price` null or integer >= 1, `money_sku` null or non-empty max 200, `vip_tier` null or integer >= 1, and at least one acquisition channel present (one of coin/SKU/tier non-null). Duplicate slug returns 409. |
| `PATCH /api/v1/admin/decorations/items/:id` | `requireAuth` + admin | Edits title, prices, SKU, tier, folder prefix, and active flag. Slug and type are immutable (attempts return 400). Deactivation (`is_active=false`) is always allowed. |
| `POST /api/v1/admin/decorations/grants` | `requireAuth` + admin | Direct support grant: `{ user_id, item_id, note? }`. Inserts one `decoration_ownership` row with `source='admin_grant'` and `granted_by` set. Duplicate returns 409 with no side effects. |
| `POST /api/v1/admin/coins/grant` | `requireAuth` + admin | Credits coins: `{ user_id, amount, note? }` with `amount` integer `1..1_000_000`. Creates the wallet row when missing. Returns the new balance. |
| `POST /api/v1/admin/decorations/purchases/record` | `requireAuth` + admin | Records an admin-confirmed money purchase (the stub): `{ user_id, item_id, sku, order_reference }`. Enforces SKU equality and global `order_reference` uniqueness. Returns `verification: 'stubbed-manual'`. |
| `PUT /api/v1/admin/vip/assign` | `requireAuth` + admin | Upserts the user's VIP grant: `{ user_id, tier >= 1, expires_at (ISO, future) }`. Returns the grant. |
| `DELETE /api/v1/admin/vip/assign` | `requireAuth` + admin | Revokes VIP: `{ user_id }` deletes the grant row. Missing grant returns 404. (Uses DELETE with a JSON body to match the existing `PUT /admin/requests/:id` body-driven style; alternatively `DELETE /api/v1/admin/vip/:userId`. The plan author picks one spelling and documents it; both are not implemented.) |

Sync/integration contract for the app (read-only guidance, no app changes authorized): the app calls `GET /api/v1/decorations/sync` on login and on foreground return, replaces its local entitlement cache wholesale with the snapshot (never merges), constructs image URLs from `asset_prefix` against the known asset host, and sends equip intents to `PUT /api/v1/decorations/equip`. A 401 on snapshot means re-login; a 403 on equip means refresh the snapshot and render the item as locked.

### 8. Data model (new tables plus users columns)

```text
decoration_items
  id uuid PK defaultRandom()
  type varchar(20) NOT NULL            -- avatar_frame|nameplate|profile_frame|profile_effect
  slug varchar(100) NOT NULL UNIQUE
  title varchar(200) NOT NULL
  folder integer NOT NULL              -- >= 1, matches R2 folder number
  asset_prefix varchar(500) NOT NULL   -- verbatim R2 prefix, e.g. frames/2_VIP2
  coin_price integer NULL              -- NULL or >= 1
  money_sku varchar(200) NULL
  vip_tier integer NULL                -- NULL or >= 1
  is_active boolean NOT NULL DEFAULT true
  created_at timestamptz NOT NULL DEFAULT now()
  updated_at timestamptz NOT NULL DEFAULT now()
  CHECK (coin_price IS NULL OR coin_price >= 1)
  CHECK (vip_tier IS NULL OR vip_tier >= 1)
  CHECK (folder >= 1)
  CHECK (coin_price IS NOT NULL OR money_sku IS NOT NULL OR vip_tier IS NOT NULL)
  INDEX (type, is_active), INDEX (vip_tier) WHERE vip_tier IS NOT NULL

coin_wallets
  user_id uuid PK REFERENCES users(id) ON DELETE CASCADE
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0)
  updated_at timestamptz NOT NULL DEFAULT now()

coin_transactions (append-only)
  id bigint GENERATED ALWAYS AS IDENTITY PK
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
  delta integer NOT NULL CHECK (delta <> 0)
  balance_after integer NOT NULL CHECK (balance_after >= 0)
  reason varchar(20) NOT NULL          -- admin_grant|purchase (closed in phase 1)
  item_id uuid NULL REFERENCES decoration_items(id) ON DELETE RESTRICT
  admin_id uuid NULL REFERENCES users(id) ON DELETE SET NULL
  note varchar(500) NULL
  created_at timestamptz NOT NULL DEFAULT now()
  INDEX (user_id, created_at)

decoration_ownership
  id bigint GENERATED ALWAYS AS IDENTITY PK
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
  item_id uuid NOT NULL REFERENCES decoration_items(id) ON DELETE RESTRICT
  source varchar(20) NOT NULL          -- coin|money|admin_grant
  granted_at timestamptz NOT NULL DEFAULT now()
  expires_at timestamptz NULL          -- always NULL in phase 1
  order_reference varchar(255) NULL    -- money only
  granted_by uuid NULL REFERENCES users(id) ON DELETE SET NULL
  UNIQUE (user_id, item_id)
  INDEX (user_id)

money_purchase_records (append-only audit)
  id bigint GENERATED ALWAYS AS IDENTITY PK
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
  item_id uuid NOT NULL REFERENCES decoration_items(id) ON DELETE RESTRICT
  sku varchar(200) NOT NULL
  order_reference varchar(255) NOT NULL UNIQUE
  recorded_by uuid NULL REFERENCES users(id) ON DELETE SET NULL
  recorded_at timestamptz NOT NULL DEFAULT now()
  INDEX (user_id)

vip_grants
  user_id uuid PK REFERENCES users(id) ON DELETE CASCADE
  tier integer NOT NULL CHECK (tier >= 1)
  expires_at timestamptz NOT NULL
  granted_by uuid NULL REFERENCES users(id) ON DELETE SET NULL
  created_at timestamptz NOT NULL DEFAULT now()
  updated_at timestamptz NOT NULL DEFAULT now()

users (added columns, all nullable)
  equipped_avatar_frame_id uuid NULL REFERENCES decoration_items(id) ON DELETE SET NULL
  equipped_nameplate_id uuid NULL REFERENCES decoration_items(id) ON DELETE SET NULL
  equipped_profile_frame_id uuid NULL REFERENCES decoration_items(id) ON DELETE SET NULL
  equipped_profile_effect_id uuid NULL REFERENCES decoration_items(id) ON DELETE SET NULL
```

Slot-to-column mapping is fixed: `avatar_frame → equipped_avatar_frame_id`, `nameplate → equipped_nameplate_id`, `profile_frame → equipped_profile_frame_id`, `profile_effect → equipped_profile_effect_id`. The equip route rejects any other slot string with 400.

### 9. Migration and rollout gates

- The new migration is `drizzle/0007_decoration_store.sql` (journal `idx 7`, next tag after `0006_google_identity_binding`), containing only `CREATE TABLE` statements for the six new tables, the four `ALTER TABLE users ADD COLUMN` statements, and the supporting indexes and check constraints. It alters no existing column, creates no backfill, and touches no existing row. If another migration lands first, the plan author allocates the next free sequence instead of overwriting; committed history is never edited.
- A matching `drizzle/meta/0007_snapshot.json` is generated through the Drizzle journal workflow (never hand-edited), and `drizzle/meta/_journal.json` gains exactly one entry.
- Pre-migration gates (all read-only, secrets never printed or committed): exact production-config validation per the runbook; `SELECT count(*)` health probe against the live database (stop on unreachable); verification that journal entries `idx 0..6` match the committed tags (stop on any inconsistency); a logical backup of the database completed and restorable before any write. The users-emptiness gate from Phase 1 is not re-run as an emptiness assertion (accounts now legitimately exist), but any unexpected pre-existing rows in the six new table names stop the release for user consultation, and this spec authorizes no deletion.
- Migration execution uses the existing Drizzle `migrate()` workflow against `./drizzle`, followed by programmatic verification: each of the six tables exists, each of the four `users.equipped_*` columns exists, and the `(user_id, item_id)` uniqueness, `order_reference` uniqueness, and `balance >= 0` constraints are present. Bounded-transaction rule: every multi-write route asserts affected row counts (grant: 1 wallet + 1 ledger; spend: 1 wallet + 1 ledger + 1 ownership; record-purchase: 1 ownership + 1 audit) and rolls back on any mismatch.
- Deployment follows the runbook: `wrangler deploy --dry-run` with an external output directory first, then authorized `wrangler deploy`, then read-only `/health` requiring `db: up`. Post-deploy smoke is read-only (`catalog` fetch + authenticated `sync` snapshot); any live purchase or grant smoke check needs separate approval because it writes ledger data.

## Files To Change

The following are implementation-design targets, **not changes authorized by this document-writing task**:

| File | Proposed change and acceptance criteria |
| --- | --- |
| `src/database/schema.ts` | Add `decorationItems`, `coinWallets`, `coinTransactions`, `decorationOwnership`, `moneyPurchaseRecords`, `vipGrants` tables and the four nullable `users.equipped_*` columns exactly as specified in §8. No existing table or column is renamed, removed, or retyped. |
| `drizzle/0007_decoration_store.sql` | New additive migration: six `CREATE TABLE`s, four `ADD COLUMN`s, indexes, checks, and uniqueness constraints. Applies cleanly on top of `0006` with no data movement. |
| `drizzle/meta/_journal.json` | Register exactly one new entry (`idx 7`, tag `0007_decoration_store`). No existing entry is modified. |
| `drizzle/meta/0007_snapshot.json` | Generated schema snapshot consistent with the migration (Drizzle-generated, not hand-written). |
| `src/routes/decorations.ts` (new) | User router: `GET /catalog`, `GET /sync`, `POST /purchase`, `PUT /equip`. Caller resolved by token `sub → users.externalId`; 401 unknown subject, 503 unavailable storage, no memory fallback in any environment. |
| `src/routes/admin.ts` | New admin endpoints under the existing `requireAuth` + `getCaller` gate: item create/edit, coin grant, direct grant, record-purchase stub, VIP assign/revoke. Zod-validated bodies, 503 when the database is unavailable, `noteDbFailure()` on driver errors. |
| `src/app.ts` | Mount the new user router at `/api/v1/decorations` and add the `60` rate-limit line for `/api/v1/decorations/*` matching the existing admin/upload convention. No other middleware or route changes. |
| `src/routes/decorations.test.ts` (new) | Catalog visibility, snapshot shape, coin purchase success/duplicate/insufficient-balance, equip validation matrix, VIP derivation and expiry. All mocked boundaries; no live network. |
| `src/routes/admin.decorations.test.ts` (new) | Admin gating (401/403), item validation, grant/purchase/VIP flows, duplicate order-reference and duplicate-grant conflicts. |
| `src/routes/decorations.postgres.test.ts` (new) | Isolated local PostgreSQL: wallet/ledger atomicity under racing purchases, unique-pair convergence, check-constraint enforcement, VIP read-time expiry with the database clock. |

`src/middleware/auth.ts`, `src/routes/auth.ts`, `src/routes/googleIdentity.ts`, `src/routes/googleAccount.ts`, `src/routes/sync.ts`, `wrangler.toml`, R2 bindings, and the app repository need no functional edits for this design. No dependency addition is required.

## Testing Strategy

Use Vitest with local Hono `app.request`, mocked Google boundaries where touched (none directly, but caller tokens are minted with the test signing key), and isolated environment/module globals. No test uses real Google credentials, production storage, R2, or live network access. No secrets are committed; test fixtures use synthetic UUIDs, slugs, SKUs, and order references. An isolated local PostgreSQL instance verifies atomicity and constraints that mocks cannot establish.

Required cases:

1. Catalog lists only active rows with the exact public field set; inactive rows are excluded; pagination bounds (`limit` clamped to 100) hold; no ownership or wallet fields leak.
2. Snapshot for a fresh user returns zero balance, empty ownership, null VIP, and null equipped map; snapshot for an entitled user returns the exact owned ids, live VIP tier/expiry, and equipped pointers; expired VIP grants return `vip: null` while ownership rows persist; unauthenticated callers get 401 and unknown subjects get 401, never an empty success.
3. Coin purchase deducts the exact price, writes one ledger row with correct delta and `balance_after`, and creates one ownership row; duplicate purchase returns 409 with the balance unchanged; insufficient balance returns 409 with no ledger or ownership write; unknown item returns 404; inactive item returns 410; non-coin-eligible item returns 400.
4. Racing duplicate purchases against isolated PostgreSQL converge to exactly one ownership row and exactly one charge (second caller gets 409); wallet balance never goes negative under concurrency; assertion mismatches roll back fully.
5. Equip accepts each of the four slots with a matching-type entitled item and returns the updated equipped map; rejects unknown items (404), inactive items (410), type/slot mismatches (400), unowned items (403), and malformed slots (400); null clears the slot; profile PATCH cannot alter equipped fields.
6. Admin item creation validates slug format, type enum, non-negative channels, and the at-least-one-channel rule; duplicate slug returns 409; slug/type edits are rejected; deactivation succeeds and blocks new acquisition while preserving existing owners.
7. Admin coin grants validate the `1..1_000_000` range, create missing wallets, record `admin_id`, and return the new balance; non-admin callers get 403 and unauthenticated callers get 401 on every privileged route.
8. Record-purchase stub enforces SKU equality (400 on mismatch), global `order_reference` uniqueness (409 on duplicate with no ownership write), and always returns `verification: 'stubbed-manual'`; no user-facing route accepts receipts.
9. VIP assign validates tier >= 1 and future expiry, upserts in place, and revocation deletes (missing grant returns 404); folder unlock follows `tier >= item.vip_tier` with null tiers never unlocked; expiry evaluated on the database clock revokes immediately with no cleanup job.
10. All user and admin decoration routes return 503 (not memory results) when the database is unavailable, including with populated development fixtures; error bodies contain no driver diagnostics or secrets.

Implementation acceptance requires `npm run typecheck`, `npm test`, the isolated PostgreSQL suite, `npm run build`, and `wrangler deploy --dry-run` with an external output directory, all exiting 0. This specification commit runs none of these.

## Risks And Mitigations

1. **Double-charge or lost-coin on racing purchases (Neon HTTP driver has no interactive transactions).** *Mitigation:* single-statement transaction block with `SELECT … FOR UPDATE`, `(user_id, item_id)` unique backstop converging races to 409 `already_owned` with the wallet write rolled back, `balance >= 0` check constraint, and exact row-count assertions (1 wallet + 1 ledger + 1 ownership) on every spend; concurrency suite against isolated PostgreSQL is a merge gate, not an optional check.
2. **VIP expiry evaluated inconsistently (app clock vs. server clock vs. database clock).** *Mitigation:* liveness is always evaluated with the database clock (`expires_at > now()`) inside the snapshot and equip queries, never with client-supplied time; the snapshot returns `server_now` for display only; expired rows grant nothing even before any cleanup; the app replaces (never merges) its cache on each snapshot.
3. **Stubbed money purchases mistaken for verified revenue.** *Mitigation:* the only record path is admin-authenticated, requires SKU equality and globally unique `order_reference`, and returns an explicit `verification: 'stubbed-manual'` marker; no user-facing route accepts receipts; a later verification phase reuses the same tables with a mandatory receipt column rather than a parallel ledger.
4. **Catalog deactivation strands paying users or breaks equipped profiles.** *Mitigation:* deactivation blocks acquisition and new equips but never deletes ownership rows or clears equipped pointers; equipped foreign keys use `ON DELETE SET NULL` only for hard deletes (which are blocked while ownership exists); support corrections go through audit-logged admin grants.
5. **Migration-sequence collision (another migration lands as 0007 first).** *Mitigation:* journal continuity is verified before writing the migration; on collision the plan author allocates the next free sequence and retitles the file and journal entry together; committed history is never rewritten and production migration runs only through the Drizzle workflow with post-migration constraint verification.

## Decision Summary

- Four decoration types share one uniform model (`decoration_items` with a closed type enum); no per-type tables or routes.
- Coins are admin-granted only in phase 1 (no earning rules); spends go through a bounded wallet-plus-ledger transaction with row-count assertions and check-constraint backstops.
- Real-money handling is an explicit stub: admin-recorded purchases with SKU equality and unique order references, always marked `stubbed-manual`; Play verification is deferred without a parallel ledger.
- VIP is tier-per-folder (`tier N` unlocks folders `1..N`), stored as one grant row per user, evaluated at read time against the database clock; expiry revokes immediately with no cron, and VIP access is derived, never materialized as ownership rows.
- Never-free rule: equip requires a live ownership row for the exact item or a live VIP derivation; the snapshot is a read-only hint with no granting power.
- User identity comes from the verified `google_subject` session (`sub → users.externalId`); all privileged routes reuse the existing `requireAuth` + `getCaller` admin gate with 401/403/503 semantics intact.
- Snapshot endpoint (`GET /api/v1/decorations/sync`) is the sole auto-sync contract, called on login and foreground return with wholesale cache replacement on the client.
- Assets stay in the existing R2 layout referenced by verbatim `asset_prefix`; no R2, CDN, upload, or serving changes.
- Migration is strictly additive (`0007`, journal `idx 7`, plus generated snapshot); existing content and committed history are immutable, and runbook release gates (backup, bounded transactions, row-count assertions, dry-run, authorized deploy) apply unchanged.
- Out of scope: Play verification, coin earning, app UI, CDN custom domain, and any live execution as part of this spec.

## Assumptions And Open Questions

- Assumed: the R2 folder number embedded in prefixes like `frames/2_VIP2` always equals the item's `folder`/`vip_tier` for VIP rows; the admin item-creation route does not parse or validate the prefix structure beyond non-emptiness, so folder/tier consistency for VIP items is an operator responsibility verified at catalog entry time.
- Assumed: one live VIP grant per user is sufficient (no stacked or overlapping grants); tier upgrades/downgrades are plain overwrites with a single expiry.
- Assumed: `DELETE /api/v1/admin/vip/assign` with a JSON body is acceptable to the existing API style; the plan author may instead use `DELETE /api/v1/admin/vip/:userId` but must implement exactly one spelling.
- Open question for the plan phase (not a spec gap): seed-catalog mechanism for the initial frame folders (admin API calls vs. a checked-in seed script) — either is compatible with this design, but the seed content itself needs product confirmation of titles, prices, SKUs, and tiers.
- Open question for a later phase: Play verification column set on `money_purchase_records` (receipt blob vs. purchase-token reference and retention policy); the stub reserves the table without fixing that shape.
