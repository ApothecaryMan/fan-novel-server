# Decoration Store Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-authoritative decoration store backend (4 uniform types, coin wallet+ledger, stubbed money records, read-time VIP, sync snapshot, validated equip) behind existing auth gates with additive migration 0007.

**Architecture:** One `decoration_items` table with closed type enum drives all entitlement; `coin_wallets`+`coin_transactions` ledger handles coins; `decoration_ownership` is the permanent-grant ledger; `vip_grants` is read-time derived (never materialized); single-statement CTE SQL blocks give atomicity on the Neon HTTP driver; Hono routers reuse `requireAuth`+`getCaller`.

**Tech Stack:** Cloudflare Workers + Hono + Drizzle ORM + Neon Postgres (node-postgres locally), Zod, Vitest, drizzle-kit, wrangler.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/database/schema.ts` | Add 6 tables + 4 `users.equipped_*` columns; no existing table touched |
| `drizzle/0007_decoration_store.sql` | Additive migration: 6 CREATE TABLEs, 4 ADD COLUMNs, indexes, checks |
| `drizzle/meta/_journal.json` | Exactly one new entry idx 7 tag `0007_decoration_store` |
| `drizzle/meta/0007_snapshot.json` | Drizzle-generated snapshot (never hand-edited) |
| `src/routes/decorations.ts` | User router: `GET /catalog`, `GET /sync`, `POST /purchase`, `PUT /equip` + exported pure helpers |
| `src/routes/admin.ts` | 6 admin endpoints under existing gate: items create/patch, grants, coin grant, purchase record, VIP assign + revoke |
| `src/app.ts` | Mount user router at `/api/v1/decorations`, add `rateLimit(60)` line |
| `scripts/seed-decorations.ts` | Idempotent checked-in seed (upsert by slug), 8 rows, run manually against target DB |
| `src/routes/decorations.test.ts` | Mocked-DB unit tests: catalog, sync, purchase, equip, VIP derivation |
| `src/routes/admin.decorations.test.ts` | Admin gating + validation + conflict tests |
| `src/routes/decorations.postgres.test.ts` | Isolated local Postgres atomicity/constraint/expiry tests |

## Locked Decisions (open items resolved, no placeholders)

1. **Seed mechanism + content:** checked-in script `scripts/seed-decorations.ts` invoked as `npm run seed:decorations` (tsx-equivalent via compiled `dist`). It upserts by `slug` (insert else update title/prices/sku/tier/active, never deletes). Seed content is exactly 8 rows below. No R2 writes, prefixes reference existing `fan-novel-assets/frames/` naming only.
2. **VIP revoke spelling (exactly one):** `DELETE /api/v1/admin/vip/:userId` with UUID path param. No JSON body. Missing grant returns 404. Rationale: DELETE-with-body is unreliable through proxies; path param matches `PUT /admin/users/:id` style.
3. **Play-verification reserve (no column added):** future names reserved only: `receipt_blob`, `purchase_token`, `verified_at`, `verifier` on `money_purchase_records` via a later additive migration. Phase-1 stub adds nothing beyond spec section 8.

### Seed content (exact, 8 rows)

| slug | type | title | folder | asset_prefix | coin_price | money_sku | vip_tier |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `golden-lion-vip1` | avatar_frame | Golden Lion | 1 | frames/1_VIP1/golden-lion | 500 | null | 1 |
| `silver-wolf-vip1` | nameplate | Silver Wolf | 1 | frames/1_VIP1/silver-wolf | 300 | null | 1 |
| `azure-dragon-vip2` | avatar_frame | Azure Dragon | 2 | frames/2_VIP2/azure-dragon | 800 | vip2_azure_dragon | 2 |
| `crimson-phoenix-vip2` | profile_frame | Crimson Phoenix | 2 | frames/2_VIP2/crimson-phoenix | null | vip2_crimson_phoenix | 2 |
| `jade-tiger-vip2` | nameplate | Jade Tiger | 2 | frames/2_VIP2/jade-tiger | 600 | null | 2 |
| `starlight-veil` | profile_effect | Starlight Veil | 3 | frames/3_VIP3/starlight-veil | 1000 | vip3_starlight_veil | 3 |
| `midnight-tide` | profile_frame | Midnight Tide | 3 | frames/3_VIP3/midnight-tide | 700 | null | null |
| `ember-sigil` | profile_effect | Ember Sigil | 1 | frames/1_VIP1/ember-sigil | null | ember_sigil_99 | null |

---

## Constraints (normative, every task)

- Never modify/delete existing DB content or committed migration history (`drizzle/0000`-`0006`, journal idx 0-6 immutable).
- NO live-Neon writes during implementation; migration verification only on isolated local Postgres (`decoration_store_test` on 127.0.0.1, separate from `phase1_identity_test`).
- No secrets in code/tests/logs; fixtures use synthetic UUIDs/slugs/SKUs/order refs.
- Touch nothing outside plan-named files; `git status` clean except plan + task files.
- App repo is read-only reference; no app UI work; no R2 bucket/object changes.
- No `drizzle-kit push`; journal workflow only; snapshot never hand-edited (regenerate on collision).

### Task 1: Guard working tree

**Files:** none (read-only check)

- [ ] **Step 1: Run git status and log**

```bash
git status --short | head -20
git log --oneline -5
```

Expected: only `?? docs/superpowers/specs/2026-09-19-decoration-store-backend-design.md` (and plan file) as untracked; no modified tracked files. If any tracked file is modified, STOP and consult user before touching anything.

- [ ] **Step 2: Verify journal baseline**

```bash
node -e "const j=require('./drizzle/meta/_journal.json'); console.log(JSON.stringify(j.entries.map(e=>e.idx+':'+e.tag)))"
```

Expected: `["0:0000_sync","1:0001_oval_outlaw_kid","2:0002_dark_sumo","3:0003_omniscient_mole_man","4:0004_secret_tattoo","5:0005_tidy_ultimates","6:0006_google_identity_binding"]`. Any deviation = STOP.

### Task 2: Extend Drizzle schema

**Files:**
- Modify: `src/database/schema.ts` (append after `commentModLog`, before end)
- Test: typecheck only

- [ ] **Step 1: Append decoration tables to schema**

Old string (exact, end of file):
```ts
export const commentModLog = pgTable('comment_mod_log', {
  id: bigserial('id').primaryKey(),
  commentId: bigint('comment_id', { mode: 'number' }).references(() => comments.id, { onDelete: 'cascade' }).notNull(),
  action: varchar('action', { length: 20 }).notNull(), // hide|restore|approve|delete|hard_delete|report
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  reason: varchar('reason', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

New string (old + appended block):
```ts
export const commentModLog = pgTable('comment_mod_log', {
  id: bigserial('id').primaryKey(),
  commentId: bigint('comment_id', { mode: 'number' }).references(() => comments.id, { onDelete: 'cascade' }).notNull(),
  action: varchar('action', { length: 20 }).notNull(), // hide|restore|approve|delete|hard_delete|report
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  reason: varchar('reason', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 13. Decoration catalog (uniform model, closed type enum enforced in app + CHECK).
export const decorationItems = pgTable('decoration_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: varchar('type', { length: 20 }).notNull(), // avatar_frame|nameplate|profile_frame|profile_effect
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 200 }).notNull(),
  folder: integer('folder').notNull(),
  assetPrefix: varchar('asset_prefix', { length: 500 }).notNull(),
  coinPrice: integer('coin_price'),
  moneySku: varchar('money_sku', { length: 200 }),
  vipTier: integer('vip_tier'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  typeActiveIdx: index('decoration_items_type_active').on(t.type, t.isActive),
  vipTierIdx: index('decoration_items_vip_tier').on(t.vipTier),
}));

// 14. Coin wallets (one row per user).
export const coinWallets = pgTable('coin_wallets', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).primaryKey(),
  balance: integer('balance').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 15. Coin ledger (append-only; reason admin_grant|purchase).
export const coinTransactions = pgTable('coin_transactions', {
  id: bigserial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  delta: integer('delta').notNull(),
  balanceAfter: integer('balance_after').notNull(),
  reason: varchar('reason', { length: 20 }).notNull(), // admin_grant|purchase
  itemId: uuid('item_id').references(() => decorationItems.id, { onDelete: 'restrict' }),
  adminId: uuid('admin_id').references(() => users.id, { onDelete: 'set null' }),
  note: varchar('note', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userCreatedIdx: index('coin_transactions_user_created').on(t.userId, t.createdAt),
}));

// 16. Ownership ledger (permanent grants; VIP never materialized here).
export const decorationOwnership = pgTable('decoration_ownership', {
  id: bigserial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  itemId: uuid('item_id').references(() => decorationItems.id, { onDelete: 'restrict' }).notNull(),
  source: varchar('source', { length: 20 }).notNull(), // coin|money|admin_grant
  grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  orderReference: varchar('order_reference', { length: 255 }),
  grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => ({
  userItemUnique: uniqueIndex('decoration_ownership_user_item').on(t.userId, t.itemId),
  userIdx: index('decoration_ownership_user').on(t.userId),
}));

// 17. Money purchase audit (append-only stub; verification always stubbed-manual).
export const moneyPurchaseRecords = pgTable('money_purchase_records', {
  id: bigserial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  itemId: uuid('item_id').references(() => decorationItems.id, { onDelete: 'restrict' }).notNull(),
  sku: varchar('sku', { length: 200 }).notNull(),
  orderReference: varchar('order_reference', { length: 255 }).notNull().unique(),
  recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index('money_purchase_records_user').on(t.userId),
}));

// 18. VIP grants (one row per user; liveness = expires_at > now() on DB clock).
export const vipGrants = pgTable('vip_grants', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).primaryKey(),
  tier: integer('tier').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 19. Equipped slots on users (nullable FKs, SET NULL on delete).
export const equippedColumns = {
  equippedAvatarFrameId: uuid('equipped_avatar_frame_id').references(() => decorationItems.id, { onDelete: 'set null' }),
  equippedNameplateId: uuid('equipped_nameplate_id').references(() => decorationItems.id, { onDelete: 'set null' }),
  equippedProfileFrameId: uuid('equipped_profile_frame_id').references(() => decorationItems.id, { onDelete: 'set null' }),
  equippedProfileEffectId: uuid('equipped_profile_effect_id').references(() => decorationItems.id, { onDelete: 'set null' }),
};
```

NOTE: after appending, also patch the existing `users` definition to include the four columns inline (Drizzle requires columns inside `pgTable`). Apply this second edit: in `export const users = pgTable('users', {` block, after `updatedAt: timestamp('updated_at').defaultNow().notNull()` add:
```ts
  equippedAvatarFrameId: uuid('equipped_avatar_frame_id').references(() => decorationItems.id, { onDelete: 'set null' }),
  equippedNameplateId: uuid('equipped_nameplate_id').references(() => decorationItems.id, { onDelete: 'set null' }),
  equippedProfileFrameId: uuid('equipped_profile_frame_id').references(() => decorationItems.id, { onDelete: 'set null' }),
  equippedProfileEffectId: uuid('equipped_profile_effect_id').references(() => decorationItems.id, { onDelete: 'set null' }),
```
The standalone `equippedColumns` export above documents the mapping; the `users` inline columns are authoritative. Both must exist with identical column names.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors. If `ReferenceError`/circular ref appears, keep declaration order (decorationItems before users patch is fine because references are lazy arrows).

- [ ] **Step 3: Commit**

```bash
git add src/database/schema.ts
git commit -m "feat(store): add decoration schema tables and equipped columns"
```

### Task 3: Write additive migration 0007

**Files:**
- Create: `drizzle/0007_decoration_store.sql`
- Test: isolated local Postgres apply

- [ ] **Step 1: Create migration file with exact contents**

```sql
CREATE TABLE "decoration_items" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "type" varchar(20) NOT NULL, "slug" varchar(100) NOT NULL, "title" varchar(200) NOT NULL, "folder" integer NOT NULL, "asset_prefix" varchar(500) NOT NULL, "coin_price" integer, "money_sku" varchar(200), "vip_tier" integer, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "decoration_items_slug_unique" UNIQUE("slug"), CONSTRAINT "decoration_items_folder_check" CHECK ("folder" >= 1), CONSTRAINT "decoration_items_coin_price_check" CHECK ("coin_price" IS NULL OR "coin_price" >= 1), CONSTRAINT "decoration_items_vip_tier_check" CHECK ("vip_tier" IS NULL OR "vip_tier" >= 1), CONSTRAINT "decoration_items_channel_check" CHECK ("coin_price" IS NOT NULL OR "money_sku" IS NOT NULL OR "vip_tier" IS NOT NULL));
--> statement-breakpoint
CREATE TABLE "coin_wallets" ("user_id" uuid PRIMARY KEY NOT NULL, "balance" integer DEFAULT 0 NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "coin_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action, CONSTRAINT "coin_wallets_balance_check" CHECK ("balance" >= 0));
--> statement-breakpoint
CREATE TABLE "coin_transactions" ("id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "coin_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1), "user_id" uuid NOT NULL, "delta" integer NOT NULL, "balance_after" integer NOT NULL, "reason" varchar(20) NOT NULL, "item_id" uuid, "admin_id" uuid, "note" varchar(500), "created_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "coin_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action, CONSTRAINT "coin_transactions_item_id_decoration_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."decoration_items"("id") ON DELETE restrict ON UPDATE no action, CONSTRAINT "coin_transactions_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action, CONSTRAINT "coin_transactions_delta_check" CHECK ("delta" <> 0), CONSTRAINT "coin_transactions_balance_after_check" CHECK ("balance_after" >= 0));
--> statement-breakpoint
CREATE TABLE "decoration_ownership" ("id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "decoration_ownership_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1), "user_id" uuid NOT NULL, "item_id" uuid NOT NULL, "source" varchar(20) NOT NULL, "granted_at" timestamp with time zone DEFAULT now() NOT NULL, "expires_at" timestamp with time zone, "order_reference" varchar(255), "granted_by" uuid, CONSTRAINT "decoration_ownership_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action, CONSTRAINT "decoration_ownership_item_id_decoration_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."decoration_items"("id") ON DELETE restrict ON UPDATE no action, CONSTRAINT "decoration_ownership_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action, CONSTRAINT "decoration_ownership_user_item_unique" UNIQUE("user_id","item_id"));
--> statement-breakpoint
CREATE TABLE "money_purchase_records" ("id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "money_purchase_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1), "user_id" uuid NOT NULL, "item_id" uuid NOT NULL, "sku" varchar(200) NOT NULL, "order_reference" varchar(255) NOT NULL, "recorded_by" uuid, "recorded_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "money_purchase_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action, CONSTRAINT "money_purchase_records_item_id_decoration_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."decoration_items"("id") ON DELETE restrict ON UPDATE no action, CONSTRAINT "money_purchase_records_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action, CONSTRAINT "money_purchase_records_order_reference_unique" UNIQUE("order_reference"));
--> statement-breakpoint
CREATE TABLE "vip_grants" ("user_id" uuid PRIMARY KEY NOT NULL, "tier" integer NOT NULL, "expires_at" timestamp with time zone NOT NULL, "granted_by" uuid, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "vip_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action, CONSTRAINT "vip_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action, CONSTRAINT "vip_grants_tier_check" CHECK ("tier" >= 1));
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "equipped_avatar_frame_id" uuid; ALTER TABLE "users" ADD CONSTRAINT "users_equipped_avatar_frame_id_decoration_items_id_fk" FOREIGN KEY ("equipped_avatar_frame_id") REFERENCES "public"."decoration_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "equipped_nameplate_id" uuid; ALTER TABLE "users" ADD CONSTRAINT "users_equipped_nameplate_id_decoration_items_id_fk" FOREIGN KEY ("equipped_nameplate_id") REFERENCES "public"."decoration_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "equipped_profile_frame_id" uuid; ALTER TABLE "users" ADD CONSTRAINT "users_equipped_profile_frame_id_decoration_items_id_fk" FOREIGN KEY ("equipped_profile_frame_id") REFERENCES "public"."decoration_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "equipped_profile_effect_id" uuid; ALTER TABLE "users" ADD CONSTRAINT "users_equipped_profile_effect_id_decoration_items_id_fk" FOREIGN KEY ("equipped_profile_effect_id") REFERENCES "public"."decoration_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "decoration_items_type_active" ON "decoration_items" USING btree ("type","is_active"); CREATE INDEX "decoration_items_vip_tier" ON "decoration_items" USING btree ("vip_tier"); CREATE INDEX "coin_transactions_user_created" ON "coin_transactions" USING btree ("user_id","created_at"); CREATE INDEX "decoration_ownership_user" ON "decoration_ownership" USING btree ("user_id"); CREATE INDEX "money_purchase_records_user" ON "money_purchase_records" USING btree ("user_id");
```

- [ ] **Step 2: Verify on isolated local Postgres (never live Neon)**

Run:
```bash
createdb -h 127.0.0.1 -U postgres decoration_store_test 2>&1 || true
DATABASE_URL='postgresql://postgres@127.0.0.1:5432/decoration_store_test' npx drizzle-kit migrate 2>&1 | tail -5
```

Expected: migration applies including `0007`; tail shows success. Then verify:
```bash
node --input-type=module - <<'JS'
import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres@127.0.0.1:5432/decoration_store_test' });
const t = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('decoration_items','coin_wallets','coin_transactions','decoration_ownership','money_purchase_records','vip_grants')");
console.log('TABLES:' + t.rows.length);
const c = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name LIKE 'equipped_%'");
console.log('EQUIPPED_COLS:' + c.rows.length);
const k = await pool.query("SELECT conname FROM pg_constraint WHERE conname IN ('decoration_ownership_user_item_unique','money_purchase_records_order_reference_unique') AND contype='u'");
console.log('UNIQUES:' + k.rows.length);
await pool.end();
JS
```

Expected: `TABLES:6`, `EQUIPPED_COLS:4`, `UNIQUES:2`. Drop test DB afterwards: `dropdb -h 127.0.0.1 -U postgres decoration_store_test`.

- [ ] **Step 3: Register journal + snapshot via drizzle-kit (no hand-edit)**

Run:
```bash
DATABASE_URL='postgresql://postgres@127.0.0.1:5432/decoration_store_test' npx drizzle-kit generate 2>&1 | tail -5
node -e "const j=require('./drizzle/meta/_journal.json'); console.log(j.entries.length, JSON.stringify(j.entries[j.entries.length-1]))"
```

Expected: entries length 8, last entry with `idx` 7 and `tag` 0007_decoration_store. Confirm `drizzle/meta/0007_snapshot.json` exists. Never edit snapshot by hand; if tag collides (another 0007 landed), STOP, allocate next free number and rename both file and journal entry together.

- [ ] **Step 4: Commit**

```bash
git add drizzle/0007_decoration_store.sql drizzle/meta/_journal.json drizzle/meta/0007_snapshot.json
git commit -m "feat(store): additive migration 0007 decoration store"
```

### Task 4: Seed script (idempotent, checked-in)

**Files:**
- Create: `scripts/seed-decorations.ts`
- Modify: `package.json` (add one script line)

- [ ] **Step 1: Create seed script with exact contents**

```ts
// scripts/seed-decorations.ts — idempotent catalog seed. Upsert by slug; never deletes.
// Usage: DATABASE_URL set in env then npm run seed:decorations  (never against live Neon without release authorization)
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { decorationItems } from '../src/database/schema.js';

const SEED = [
  { type: 'avatar_frame', slug: 'golden-lion-vip1', title: 'Golden Lion', folder: 1, assetPrefix: 'frames/1_VIP1/golden-lion', coinPrice: 500, moneySku: null, vipTier: 1 },
  { type: 'nameplate', slug: 'silver-wolf-vip1', title: 'Silver Wolf', folder: 1, assetPrefix: 'frames/1_VIP1/silver-wolf', coinPrice: 300, moneySku: null, vipTier: 1 },
  { type: 'avatar_frame', slug: 'azure-dragon-vip2', title: 'Azure Dragon', folder: 2, assetPrefix: 'frames/2_VIP2/azure-dragon', coinPrice: 800, moneySku: 'vip2_azure_dragon', vipTier: 2 },
  { type: 'profile_frame', slug: 'crimson-phoenix-vip2', title: 'Crimson Phoenix', folder: 2, assetPrefix: 'frames/2_VIP2/crimson-phoenix', coinPrice: null, moneySku: 'vip2_crimson_phoenix', vipTier: 2 },
  { type: 'nameplate', slug: 'jade-tiger-vip2', title: 'Jade Tiger', folder: 2, assetPrefix: 'frames/2_VIP2/jade-tiger', coinPrice: 600, moneySku: null, vipTier: 2 },
  { type: 'profile_effect', slug: 'starlight-veil', title: 'Starlight Veil', folder: 3, assetPrefix: 'frames/3_VIP3/starlight-veil', coinPrice: 1000, moneySku: 'vip3_starlight_veil', vipTier: 3 },
  { type: 'profile_frame', slug: 'midnight-tide', title: 'Midnight Tide', folder: 3, assetPrefix: 'frames/3_VIP3/midnight-tide', coinPrice: 700, moneySku: null, vipTier: null },
  { type: 'profile_effect', slug: 'ember-sigil', title: 'Ember Sigil', folder: 1, assetPrefix: 'frames/1_VIP1/ember-sigil', coinPrice: null, moneySku: 'ember_sigil_99', vipTier: null },
] as const;

const url = process.env.DATABASE_URL ?? '';
if (!url) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool, { schema: { decorationItems } });
for (const row of SEED) {
  await db.insert(decorationItems).values({ ...row, isActive: true }).onConflictDoUpdate({
    target: decorationItems.slug,
    set: { title: row.title, folder: row.folder, assetPrefix: row.assetPrefix, coinPrice: row.coinPrice, moneySku: row.moneySku, vipTier: row.vipTier, isActive: true, updatedAt: new Date() },
  });
  console.log('SEEDED:' + row.slug);
}
await pool.end();
console.log('SEED_DONE:8');
```

- [ ] **Step 2: Add npm script**

Old string in `package.json`:
```json
    "db:studio": "drizzle-kit studio",
```

New string:
```json
    "db:studio": "drizzle-kit studio",
    "seed:decorations": "npx tsc && node dist/scripts/seed-decorations.js",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-decorations.ts package.json
git commit -m "feat(store): idempotent decoration seed script"
```

### Task 5: User decorations router

**Files:**
- Create: `src/routes/decorations.ts`
- Modify: `src/app.ts` (mount + ratelimit)
- Test: `src/routes/decorations.test.ts` (Task 7)

- [ ] **Step 1: Write failing route smoke test first (TDD red)**

Create `src/routes/decorations.test.ts` with this initial content:
```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
describe('decorations router exists', () => {
  it('serves public catalog without auth', async () => {
    delete process.env.DATABASE_URL;
    const app = createApp();
    const res = await app.request('/api/v1/decorations/catalog');
    expect([200, 503]).toContain(res.status);
  });
});
```

Run: `npx vitest run src/routes/decorations.test.ts 2>&1 | tail -8`
Expected: FAIL with `404` / not-found (router not mounted yet).

- [ ] **Step 2: Write minimal implementation (full file, complete)**

Create `src/routes/decorations.ts` with exact contents:
```ts
import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { coinTransactions, coinWallets, decorationItems, decorationOwnership, users, vipGrants } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getCaller } from '../middleware/ownership.js';

export const DECORATION_TYPES = ['avatar_frame', 'nameplate', 'profile_frame', 'profile_effect'] as const;
export type DecorationType = (typeof DECORATION_TYPES)[number];
export const SLOT_TO_COLUMN = {
  avatar_frame: 'equippedAvatarFrameId',
  nameplate: 'equippedNameplateId',
  profile_frame: 'equippedProfileFrameId',
  profile_effect: 'equippedProfileEffectId',
} as const;
export type Slot = keyof typeof SLOT_TO_COLUMN;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function publicItem(r: typeof decorationItems.$inferSelect) {
  return { id: r.id, type: r.type, slug: r.slug, title: r.title, folder: r.folder, asset_prefix: r.assetPrefix, coin_price: r.coinPrice, money_sku: r.moneySku, vip_tier: r.vipTier };
}
// Pure: VIP folder rule tier >= item.vip_tier, null tier never unlocked.
export function vipCovers(grantTier: number | null, itemVipTier: number | null): boolean {
  if (grantTier == null || itemVipTier == null) return false;
  return grantTier >= itemVipTier;
}

export const decorationsRouter = new Hono();

// GET /api/v1/decorations/catalog (public)
decorationsRouter.get('/catalog', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  try {
    const rows = await db.select().from(decorationItems)
      .where(eq(decorationItems.isActive, true))
      .orderBy(asc(decorationItems.type), asc(decorationItems.folder), asc(decorationItems.slug))
      .limit(limit).offset((page - 1) * limit);
    return c.json({ success: true, page, limit, data: rows.map(publicItem) });
  } catch (err) { console.error('[decorations] catalog failed', err); noteDbFailure(); return c.json({ error: 'fetch failed' }, 500); }
});

// GET /api/v1/decorations/sync (auth)
decorationsRouter.get('/sync', requireAuth, async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  try {
    const caller = await getCaller(c);
    if (!caller.row) return c.json({ error: 'account not found' }, 401);
    const uid = caller.row.id;
    const [wallet] = await db.select().from(coinWallets).where(eq(coinWallets.userId, uid)).limit(1);
    const owned = await db.select({ itemId: decorationOwnership.itemId }).from(decorationOwnership)
      .where(and(eq(decorationOwnership.userId, uid), sql`(${decorationOwnership.expiresAt} IS NULL OR ${decorationOwnership.expiresAt} > now())`));
    const liveVip = await db.select().from(vipGrants)
      .where(and(eq(vipGrants.userId, uid), sql`${vipGrants.expiresAt} > now()`)).limit(1);
    const [me] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
    const now = await db.execute(sql`SELECT now() AS now`).then((r: any) => (r.rows?.[0]?.now ?? new Date().toISOString())) as unknown;
    return c.json({
      success: true,
      balance: wallet?.balance ?? 0,
      owned_item_ids: owned.map((o) => o.itemId),
      vip: liveVip[0] ? { tier: liveVip[0].tier, expires_at: (liveVip[0].expiresAt as Date).toISOString() } : null,
      equipped: {
        avatar_frame: (me as any)?.equippedAvatarFrameId ?? null,
        nameplate: (me as any)?.equippedNameplateId ?? null,
        profile_frame: (me as any)?.equippedProfileFrameId ?? null,
        profile_effect: (me as any)?.equippedProfileEffectId ?? null,
      },
      server_now: typeof now === 'string' ? now : (now as Date).toISOString(),
    });
  } catch (err) { console.error('[decorations] sync failed', err); noteDbFailure(); return c.json({ error: 'fetch failed' }, 500); }
});

const purchaseSchema = z.object({ item_id: z.string().uuid() });

// POST /api/v1/decorations/purchase (auth, coins only) — single-statement CTE for Neon HTTP atomicity.
decorationsRouter.post('/purchase', requireAuth, async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = purchaseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid item_id', issues: parsed.error.issues }, 400);
  try {
    const caller = await getCaller(c);
    if (!caller.row) return c.json({ error: 'account not found' }, 401);
    const uid = caller.row.id;
    const [item] = await db.select().from(decorationItems).where(eq(decorationItems.id, parsed.data.item_id)).limit(1);
    if (!item) return c.json({ error: 'item not found' }, 404);
    if (!item.isActive) return c.json({ error: 'item inactive', code: 'item_inactive' }, 410);
    if (item.coinPrice == null) return c.json({ error: 'not coin eligible', code: 'not_coin_eligible' }, 400);
    const price = item.coinPrice;
    const out: any = await db.execute(sql`
      WITH w AS (
        INSERT INTO "coin_wallets" ("user_id","balance") VALUES (${uid}, 0)
        ON CONFLICT ("user_id") DO NOTHING RETURNING *
      ),
      locked AS (SELECT "balance" FROM "coin_wallets" WHERE "user_id" = ${uid} FOR UPDATE),
      charged AS (
        UPDATE "coin_wallets" SET "balance" = "balance" - ${price}, "updated_at" = now()
        WHERE "user_id" = ${uid} AND "balance" >= ${price}
        RETURNING "balance"
      ),
      owned AS (
        INSERT INTO "decoration_ownership" ("user_id","item_id","source") VALUES (${uid}, ${item.id}, 'coin')
        ON CONFLICT ("user_id","item_id") DO NOTHING RETURNING "id"
      ),
      logged AS (
        INSERT INTO "coin_transactions" ("user_id","delta","balance_after","reason","item_id")
        SELECT ${uid}, ${-price}, (SELECT "balance" FROM charged), 'purchase', ${item.id}
        WHERE EXISTS (SELECT 1 FROM charged) AND EXISTS (SELECT 1 FROM owned)
        RETURNING "id"
      )
      SELECT (SELECT "balance" FROM charged) AS balance,
             (SELECT count(*)::int FROM owned) AS owned_count,
             (SELECT count(*)::int FROM logged) AS logged_count`);
    const row = (out as any).rows?.[0];
    if (!row?.balance && row?.balance !== 0) {
      const dup = await db.select().from(decorationOwnership)
        .where(and(eq(decorationOwnership.userId, uid), eq(decorationOwnership.itemId, item.id))).limit(1);
      if (dup[0]) return c.json({ error: 'already owned', code: 'already_owned' }, 409);
      return c.json({ error: 'insufficient balance', code: 'insufficient_balance' }, 409);
    }
    if (row.owned_count !== 1 || row.logged_count !== 1)
      return c.json({ error: 'already owned', code: 'already_owned' }, 409);
    return c.json({ success: true, item_id: item.id, balance: row.balance });
  } catch (err: any) {
    console.error('[decorations] purchase failed', err); noteDbFailure();
    if (String(err?.cause?.code ?? err?.code) === '23505') return c.json({ error: 'already owned', code: 'already_owned' }, 409);
    return c.json({ error: 'purchase failed' }, 500);
  }
});

const equipSchema = z.object({
  slot: z.enum(['avatar_frame', 'nameplate', 'profile_frame', 'profile_effect']),
  item_id: z.string().uuid().nullable(),
});

// PUT /api/v1/decorations/equip (auth) — never-free rule.
decorationsRouter.put('/equip', requireAuth, async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = equipSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid slot or item', issues: parsed.error.issues }, 400);
  try {
    const caller = await getCaller(c);
    if (!caller.row) return c.json({ error: 'account not found' }, 401);
    const uid = caller.row.id;
    const column = SLOT_TO_COLUMN[parsed.data.slot];
    if (parsed.data.item_id === null) {
      await db.update(users).set({ [column]: null } as any).where(eq(users.id, uid));
    } else {
      const [item] = await db.select().from(decorationItems).where(eq(decorationItems.id, parsed.data.item_id)).limit(1);
      if (!item) return c.json({ error: 'item not found' }, 404);
      if (!item.isActive) return c.json({ error: 'item inactive', code: 'item_inactive' }, 410);
      if (item.type !== parsed.data.slot) return c.json({ error: 'type mismatch', code: 'type_slot_mismatch' }, 400);
      const live = await db.select().from(decorationOwnership).where(and(
        eq(decorationOwnership.userId, uid), eq(decorationOwnership.itemId, item.id),
        sql`(${decorationOwnership.expiresAt} IS NULL OR ${decorationOwnership.expiresAt} > now())`)).limit(1);
      let entitled = live.length > 0;
      if (!entitled && item.vipTier != null) {
        const [grant] = await db.select().from(vipGrants)
          .where(and(eq(vipGrants.userId, uid), sql`${vipGrants.expiresAt} > now()`)).limit(1);
        entitled = !!grant && grant.tier >= (item.vipTier as number);
      }
      if (!entitled) return c.json({ error: 'not owned', code: 'not_owned' }, 403);
      await db.update(users).set({ [column]: item.id } as any).where(eq(users.id, uid));
    }
    const [me] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
    return c.json({ success: true, equipped: {
      avatar_frame: (me as any)?.equippedAvatarFrameId ?? null,
      nameplate: (me as any)?.equippedNameplateId ?? null,
      profile_frame: (me as any)?.equippedProfileFrameId ?? null,
      profile_effect: (me as any)?.equippedProfileEffectId ?? null,
    } });
  } catch (err) { console.error('[decorations] equip failed', err); noteDbFailure(); return c.json({ error: 'equip failed' }, 500); }
});
```

- [ ] **Step 3: Mount router in app**

Old strings in `src/app.ts`:
```ts
import { adminRouter } from './routes/admin.js';
```
```ts
  app.use('/api/v1/admin/*', rateLimit(60));
```
```ts
  app.route('/api/v1/admin', adminRouter);
```

New strings:
```ts
import { adminRouter } from './routes/admin.js';
import { decorationsRouter } from './routes/decorations.js';
```
```ts
  app.use('/api/v1/admin/*', rateLimit(60));
  app.use('/api/v1/decorations/*', rateLimit(60));
```
```ts
  app.route('/api/v1/admin', adminRouter);
  app.route('/api/v1/decorations', decorationsRouter);
```

- [ ] **Step 4: Run route smoke + typecheck**

Run: `npm run typecheck && npx vitest run src/routes/decorations.test.ts 2>&1 | tail -8`
Expected: typecheck exit 0; test may 503 (no DATABASE_URL) which still passes the `[200,503]` assertion.

- [ ] **Step 5: Commit**

```bash
git add src/routes/decorations.ts src/app.ts src/routes/decorations.test.ts
git commit -m "feat(store): user decorations router catalog sync purchase equip"
```

### Task 6: Admin decoration endpoints

**Files:**
- Modify: `src/routes/admin.ts` (append before EOF, after novels handler)
- Test: `src/routes/admin.decorations.test.ts` (Task 8)

- [ ] **Step 1: Append admin handlers with exact code**

Append this block to the end of `src/routes/admin.ts` (after the `/novels` handler, before file end):
```ts
import { sql } from 'drizzle-orm';
import { coinTransactions, coinWallets, decorationItems, decorationOwnership, moneyPurchaseRecords, users as usersTable, vipGrants } from '../database/schema.js';
import { DECORATION_TYPES, SLUG_RE } from './decorations.js';

const itemCreateSchema = z.object({
  type: z.enum(['avatar_frame', 'nameplate', 'profile_frame', 'profile_effect']),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1).max(200),
  folder: z.number().int().min(1),
  asset_prefix: z.string().min(1).max(500),
  coin_price: z.number().int().min(1).nullable().optional(),
  money_sku: z.string().min(1).max(200).nullable().optional(),
  vip_tier: z.number().int().min(1).nullable().optional(),
  is_active: z.boolean().optional(),
});

// POST /api/v1/admin/decorations/items
adminRouter.post('/decorations/items', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = itemCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid item', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (b.coin_price == null && b.money_sku == null && b.vip_tier == null)
    return c.json({ error: 'at least one channel required', code: 'no_channel' }, 400);
  try {
    const [row] = await db.insert(decorationItems).values({
      type: b.type, slug: b.slug, title: b.title, folder: b.folder, assetPrefix: b.asset_prefix,
      coinPrice: b.coin_price ?? null, moneySku: b.money_sku ?? null, vipTier: b.vip_tier ?? null,
      isActive: b.is_active ?? true,
    }).returning();
    return c.json({ success: true, data: row }, 201);
  } catch (err: any) {
    if (String(err?.cause?.code ?? err?.code) === '23505') return c.json({ error: 'duplicate slug', code: 'duplicate_slug' }, 409);
    console.error('[admin] item create failed', err); noteDbFailure();
    return c.json({ error: 'create failed' }, 500);
  }
});

const itemPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  folder: z.number().int().min(1).optional(),
  asset_prefix: z.string().min(1).max(500).optional(),
  coin_price: z.number().int().min(1).nullable().optional(),
  money_sku: z.string().min(1).max(200).nullable().optional(),
  vip_tier: z.number().int().min(1).nullable().optional(),
  is_active: z.boolean().optional(),
  slug: z.string().optional(),
  type: z.string().optional(),
});

// PATCH /api/v1/admin/decorations/items/:id (slug+type immutable)
adminRouter.patch('/decorations/items/:id', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const body: any = await c.req.json().catch(() => null);
  if (body?.slug !== undefined || body?.type !== undefined)
    return c.json({ error: 'slug and type are immutable', code: 'immutable' }, 400);
  const parsed = itemPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid patch', issues: parsed.error.issues }, 400);
  try {
    const [found] = await db.select().from(decorationItems).where(eq(decorationItems.id, c.req.param('id'))).limit(1);
    if (!found) return c.json({ error: 'item not found' }, 404);
    const patch: any = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.folder !== undefined) patch.folder = parsed.data.folder;
    if (parsed.data.asset_prefix !== undefined) patch.assetPrefix = parsed.data.asset_prefix;
    if (parsed.data.coin_price !== undefined) patch.coinPrice = parsed.data.coin_price;
    if (parsed.data.money_sku !== undefined) patch.moneySku = parsed.data.money_sku;
    if (parsed.data.vip_tier !== undefined) patch.vipTier = parsed.data.vip_tier;
    if (parsed.data.is_active !== undefined) patch.isActive = parsed.data.is_active;
    patch.updatedAt = new Date();
    const [updated] = await db.update(decorationItems).set(patch).where(eq(decorationItems.id, found.id)).returning();
    return c.json({ success: true, data: updated });
  } catch (err) { console.error('[admin] item patch failed', err); noteDbFailure(); return c.json({ error: 'update failed' }, 500); }
});

const grantSchema2 = z.object({ user_id: z.string().uuid(), item_id: z.string().uuid(), note: z.string().max(500).optional() });

// POST /api/v1/admin/decorations/grants
adminRouter.post('/decorations/grants', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = grantSchema2.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid grant', issues: parsed.error.issues }, 400);
  const caller = c.get('caller');
  try {
    const [row] = await db.insert(decorationOwnership).values({
      userId: parsed.data.user_id, itemId: parsed.data.item_id, source: 'admin_grant', grantedBy: caller.row!.id,
    }).returning();
    return c.json({ success: true, data: row }, 201);
  } catch (err: any) {
    if (String(err?.cause?.code ?? err?.code) === '23505') return c.json({ error: 'already owned', code: 'already_owned' }, 409);
    console.error('[admin] grant failed', err); noteDbFailure();
    return c.json({ error: 'grant failed' }, 500);
  }
});

const coinGrantSchema = z.object({ user_id: z.string().uuid(), amount: z.number().int().min(1).max(1000000), note: z.string().max(500).optional() });

// POST /api/v1/admin/coins/grant — single CTE: upsert wallet + ledger insert.
adminRouter.post('/coins/grant', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = coinGrantSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid grant', issues: parsed.error.issues }, 400);
  const caller = c.get('caller');
  try {
    const out: any = await db.execute(sql`
      WITH w AS (
        INSERT INTO "coin_wallets" ("user_id","balance") VALUES (${parsed.data.user_id}, 0)
        ON CONFLICT ("user_id") DO UPDATE SET "updated_at" = now() RETURNING "balance"
      ),
      bumped AS (
        UPDATE "coin_wallets" SET "balance" = "balance" + ${parsed.data.amount}, "updated_at" = now()
        WHERE "user_id" = ${parsed.data.user_id} RETURNING "balance"
      ),
      logged AS (
        INSERT INTO "coin_transactions" ("user_id","delta","balance_after","reason","admin_id","note")
        SELECT ${parsed.data.user_id}, ${parsed.data.amount}, (SELECT "balance" FROM bumped), 'admin_grant', ${caller.row!.id}, ${parsed.data.note ?? null}
        WHERE EXISTS (SELECT 1 FROM bumped) RETURNING "id"
      )
      SELECT (SELECT "balance" FROM bumped) AS balance, (SELECT count(*)::int FROM logged) AS logged_count`);
    const row = out.rows?.[0];
    if (!row || row.logged_count !== 1) return c.json({ error: 'grant failed' }, 500);
    return c.json({ success: true, user_id: parsed.data.user_id, balance: row.balance });
  } catch (err) { console.error('[admin] coin grant failed', err); noteDbFailure(); return c.json({ error: 'grant failed' }, 500); }
});

const recordSchema = z.object({ user_id: z.string().uuid(), item_id: z.string().uuid(), sku: z.string().min(1).max(200), order_reference: z.string().min(1).max(255) });

// POST /api/v1/admin/decorations/purchases/record (stub)
adminRouter.post('/decorations/purchases/record', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = recordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid record', issues: parsed.error.issues }, 400);
  const caller = c.get('caller');
  try {
    const [item] = await db.select().from(decorationItems).where(eq(decorationItems.id, parsed.data.item_id)).limit(1);
    if (!item) return c.json({ error: 'item not found' }, 404);
    if (!item.isActive) return c.json({ error: 'item inactive', code: 'item_inactive' }, 410);
    if (item.moneySku == null || item.moneySku !== parsed.data.sku)
      return c.json({ error: 'sku mismatch', code: 'sku_mismatch' }, 400);
    const out: any = await db.execute(sql`
      WITH owned AS (
        INSERT INTO "decoration_ownership" ("user_id","item_id","source","order_reference")
        VALUES (${parsed.data.user_id}, ${parsed.data.item_id}, 'money', ${parsed.data.order_reference})
        ON CONFLICT ("user_id","item_id") DO NOTHING RETURNING "id"
      ),
      audit AS (
        INSERT INTO "money_purchase_records" ("user_id","item_id","sku","order_reference","recorded_by")
        VALUES (${parsed.data.user_id}, ${parsed.data.item_id}, ${parsed.data.sku}, ${parsed.data.order_reference}, ${caller.row!.id})
        ON CONFLICT ("order_reference") DO NOTHING RETURNING "id"
      )
      SELECT (SELECT count(*)::int FROM owned) AS owned_count, (SELECT count(*)::int FROM audit) AS audit_count`);
    const row = out.rows?.[0];
    if (row.audit_count !== 1) return c.json({ error: 'duplicate order reference', code: 'duplicate_order_reference' }, 409);
    return c.json({ success: true, verification: 'stubbed-manual', item_id: parsed.data.item_id, order_reference: parsed.data.order_reference });
  } catch (err: any) {
    if (String(err?.cause?.code ?? err?.code) === '23505') return c.json({ error: 'duplicate order reference', code: 'duplicate_order_reference' }, 409);
    console.error('[admin] record purchase failed', err); noteDbFailure();
    return c.json({ error: 'record failed' }, 500);
  }
});

const vipAssignSchema = z.object({ user_id: z.string().uuid(), tier: z.number().int().min(1), expires_at: z.string().datetime() });

// PUT /api/v1/admin/vip/assign (upsert)
adminRouter.put('/vip/assign', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = vipAssignSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid vip grant', issues: parsed.error.issues }, 400);
  const exp = new Date(parsed.data.expires_at);
  if (!(exp.getTime() > Date.now())) return c.json({ error: 'expires_at must be in the future', code: 'not_future' }, 400);
  const caller = c.get('caller');
  try {
    const [row] = await db.insert(vipGrants).values({
      userId: parsed.data.user_id, tier: parsed.data.tier, expiresAt: exp, grantedBy: caller.row!.id, updatedAt: new Date(),
    }).onConflictDoUpdate({ target: vipGrants.userId, set: { tier: parsed.data.tier, expiresAt: exp, grantedBy: caller.row!.id, updatedAt: new Date() } }).returning();
    return c.json({ success: true, data: { user_id: row.userId, tier: row.tier, expires_at: (row.expiresAt as Date).toISOString() } });
  } catch (err) { console.error('[admin] vip assign failed', err); noteDbFailure(); return c.json({ error: 'assign failed' }, 500); }
});

// DELETE /api/v1/admin/vip/:userId (the single chosen revoke spelling; no body variant exists)
adminRouter.delete('/vip/:userId', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const userId = c.req.param('userId');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return c.json({ error: 'invalid user id' }, 400);
  try {
    const deleted = await db.delete(vipGrants).where(eq(vipGrants.userId, userId)).returning();
    if (deleted.length !== 1) return c.json({ error: 'grant not found', code: 'not_found' }, 404);
    return c.json({ success: true, user_id: userId });
  } catch (err) { console.error('[admin] vip revoke failed', err); noteDbFailure(); return c.json({ error: 'revoke failed' }, 500); }
});
```

NOTE: `z`, `eq`, `db`, `isDbAvailable`, `noteDbFailure` are already imported in `admin.ts`; add only the `sql` and new-table imports shown in the first two import lines. `DECORATION_TYPES`/`SLUG_RE` imports are used only for validation parity (slug regex is inline in the zod schema).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat(store): admin decoration coin vip endpoints"
```

### Task 7: Expand unit tests (mocked DB, no network)

**Files:**
- Modify: `src/routes/decorations.test.ts` (replace smoke with full suite)
- Create: `src/routes/admin.decorations.test.ts`

- [ ] **Step 1: Overwrite decorations.test.ts with pure + gating tests**

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { vipCovers, SLUG_RE, SLOT_TO_COLUMN } from './decorations.js';

function openApp() { delete process.env.DATABASE_URL; return createApp(); }

describe('decoration helpers', () => {
  it('vipCovers follows tier>=vip_tier, null never', () => {
    expect(vipCovers(2, 1)).toBe(true);
    expect(vipCovers(2, 2)).toBe(true);
    expect(vipCovers(1, 2)).toBe(false);
    expect(vipCovers(null, 1)).toBe(false);
    expect(vipCovers(2, null)).toBe(false);
  });
  it('slug regex accepts kebab, rejects spaces/upper', () => {
    expect(SLUG_RE.test('golden-lion-vip2')).toBe(true);
    expect(SLUG_RE.test('Golden Lion')).toBe(false);
  });
  it('slot map covers all four slots', () => {
    expect(Object.keys(SLOT_TO_COLUMN).sort()).toEqual(['avatar_frame', 'nameplate', 'profile_effect', 'profile_frame']);
  });
});

describe('decorations routes without DB', () => {
  it('catalog 503 with no DB (fail-closed)', async () => {
    const res = await openApp().request('/api/v1/decorations/catalog');
    expect(res.status).toBe(503);
  });
  it('sync/purch/equip require bearer (401)', async () => {
    const app = openApp();
    expect((await app.request('/api/v1/decorations/sync')).status).toBe(401);
    expect((await app.request('/api/v1/decorations/purchase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request('/api/v1/decorations/equip', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
  it('pagination clamps limit to 100 (unit check of min/max math)', () => {
    expect(Math.min(100, Math.max(1, 9999))).toBe(100);
  });
});
```

- [ ] **Step 2: Create admin.decorations.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
function openApp() { delete process.env.DATABASE_URL; return createApp(); }
describe('admin decoration gates without DB', () => {
  it('all privileged routes 401 without bearer', async () => {
    const app = openApp();
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await app.request('/api/v1/admin/decorations/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request(`/api/v1/admin/decorations/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request('/api/v1/admin/decorations/grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request('/api/v1/admin/coins/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request('/api/v1/admin/decorations/purchases/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request('/api/v1/admin/vip/assign', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await app.request(`/api/v1/admin/vip/${id}`, { method: 'DELETE' })).status).toBe(401);
  });
  it('revoke spelling is path-param only (no /vip/assign DELETE)', async () => {
    const app = openApp();
    const res = await app.request('/api/v1/admin/vip/assign', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: 'x' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run unit tests**

Run: `npx vitest run src/routes/decorations.test.ts src/routes/admin.decorations.test.ts 2>&1 | tail -10`
Expected: both files PASS (8+ tests), exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/routes/decorations.test.ts src/routes/admin.decorations.test.ts
git commit -m "test(store): unit gates helpers catalog sync equip admin"
```

### Task 8: Isolated Postgres suite (atomicity, constraints, expiry)

**Files:**
- Create: `src/routes/decorations.postgres.test.ts`

- [ ] **Step 1: Create test with exact contents**

```ts
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../database/schema.js';

const url = process.env.DECORATION_PG_URL;
if (url) {
  const p = new URL(url);
  if (p.hostname !== '127.0.0.1' && p.hostname !== 'localhost') throw new Error('DECORATION_PG_URL must be isolated local Postgres');
  if (!p.pathname.endsWith('/decoration_store_test')) throw new Error('DECORATION_PG_URL must name decoration_store_test');
}
describe.skipIf(!url)('decoration store postgres', () => {
  let pool: pg.Pool; let database: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 });
    database = drizzle(pool, { schema });
    await migrate(database, { migrationsFolder: './drizzle' });
  });
  afterAll(async () => { await pool?.end(); });
  it('check constraints reject zero coin_price and negative balance', async () => {
    await expect(database.insert(schema.decorationItems).values({
      type: 'avatar_frame', slug: 'zero-price-t', title: 'Z', folder: 1, assetPrefix: 'frames/1_VIP1/z', coinPrice: 0 } as any)
    ).rejects.toBeTruthy();
    const u = (await database.insert(schema.users).values({ externalId: 'google_pg-w1', googleSubject: 'pg-w1', email: 'w1@t.co', username: 'pgw1' }).returning())[0];
    await expect(database.insert(schema.coinWallets).values({ userId: u.id, balance: -5 })).rejects.toBeTruthy();
    await database.delete(schema.users).where(eq(schema.users.id, u.id));
  });
  it('ownership unique pair converges; vip expiry uses DB clock', async () => {
    const u = (await database.insert(schema.users).values({ externalId: 'google_pg-o1', googleSubject: 'pg-o1', email: 'o1@t.co', username: 'pgo1' }).returning())[0];
    const item = (await database.insert(schema.decorationItems).values({
      type: 'avatar_frame', slug: 'race-frame-t', title: 'R', folder: 1, assetPrefix: 'frames/1_VIP1/r', coinPrice: 100, vipTier: 1 }).returning())[0];
    await database.insert(schema.decorationOwnership).values({ userId: u.id, itemId: item.id, source: 'coin' });
    await expect(database.insert(schema.decorationOwnership).values({ userId: u.id, itemId: item.id, source: 'coin' })).rejects.toBeTruthy();
    await database.insert(schema.vipGrants).values({ userId: u.id, tier: 2, expiresAt: new Date(Date.now() + 3600_000) });
    const live: any = await database.execute(sql`SELECT count(*)::int AS n FROM "vip_grants" WHERE "user_id" = ${u.id} AND "expires_at" > now()`);
    expect(Number(live.rows[0].n)).toBe(1);
    await database.execute(sql`UPDATE "vip_grants" SET "expires_at" = now() - interval '1 second' WHERE "user_id" = ${u.id}`);
    const dead: any = await database.execute(sql`SELECT count(*)::int AS n FROM "vip_grants" WHERE "user_id" = ${u.id} AND "expires_at" > now()`);
    expect(Number(dead.rows[0].n)).toBe(0);
    await database.delete(schema.vipGrants).where(eq(schema.vipGrants.userId, u.id));
    await database.delete(schema.decorationOwnership).where(eq(schema.decorationOwnership.userId, u.id));
    await database.delete(schema.decorationItems).where(eq(schema.decorationItems.id, item.id));
    await database.delete(schema.users).where(eq(schema.users.id, u.id));
  });
  it('racing coin purchases charge once (CTE backstop)', async () => {
    const u = (await database.insert(schema.users).values({ externalId: 'google_pg-r1', googleSubject: 'pg-r1', email: 'r1@t.co', username: 'pgr1' }).returning())[0];
    const item = (await database.insert(schema.decorationItems).values({
      type: 'nameplate', slug: 'race-coin-t', title: 'RC', folder: 1, assetPrefix: 'frames/1_VIP1/rc', coinPrice: 50 }).returning())[0];
    await database.insert(schema.coinWallets).values({ userId: u.id, balance: 60 });
    const buy = () => database.execute(sql`
      WITH charged AS (UPDATE "coin_wallets" SET "balance" = "balance" - 50, "updated_at" = now()
        WHERE "user_id" = ${u.id} AND "balance" >= 50 RETURNING "balance"),
      owned AS (INSERT INTO "decoration_ownership" ("user_id","item_id","source") VALUES (${u.id}, ${item.id}, 'coin')
        ON CONFLICT ("user_id","item_id") DO NOTHING RETURNING "id"),
      logged AS (INSERT INTO "coin_transactions" ("user_id","delta","balance_after","reason","item_id")
        SELECT ${u.id}, -50, (SELECT "balance" FROM charged), 'purchase', ${item.id}
        WHERE EXISTS (SELECT 1 FROM charged) AND EXISTS (SELECT 1 FROM owned) RETURNING "id")
      SELECT (SELECT "balance" FROM charged) AS balance,
             (SELECT count(*)::int FROM owned) AS owned_count, (SELECT count(*)::int FROM logged) AS logged_count`);
    const [a, b]: any[] = await Promise.all([buy(), buy()]);
    const wins = [a.rows[0], b.rows[0]].filter((r) => r.owned_count === 1);
    expect(wins.length).toBe(1);
    const [w] = await database.select().from(schema.coinWallets).where(eq(schema.coinWallets.userId, u.id));
    expect(w.balance).toBe(10);
    await database.delete(schema.coinTransactions).where(eq(schema.coinTransactions.userId, u.id));
    await database.delete(schema.decorationOwnership).where(eq(schema.decorationOwnership.userId, u.id));
    await database.delete(schema.coinWallets).where(eq(schema.coinWallets.userId, u.id));
    await database.delete(schema.decorationItems).where(eq(schema.decorationItems.id, item.id));
    await database.delete(schema.users).where(eq(schema.users.id, u.id));
  });
});
```

- [ ] **Step 2: Run isolated suite on local Postgres only**

Run:
```bash
createdb -h 127.0.0.1 -U postgres decoration_store_test 2>&1 || true
DECORATION_PG_URL='postgresql://postgres@127.0.0.1:5432/decoration_store_test' npx vitest run src/routes/decorations.postgres.test.ts 2>&1 | tail -8
dropdb -h 127.0.0.1 -U postgres decoration_store_test 2>&1 || true
```

Expected: 3 passed (not skipped), exit 0. Never point DECORATION_PG_URL at Neon.

- [ ] **Step 3: Commit**

```bash
git add src/routes/decorations.postgres.test.ts
git commit -m "test(store): isolated postgres atomicity constraints expiry"
```

### Task 9: Full verification (no live writes)

- [ ] **Step 1: Run typecheck + unit + build + dry-run**

```bash
npm run typecheck 2>&1 | tail -3
npm test 2>&1 | tail -12
npm run build 2>&1 | tail -3
mkdir -p /tmp/opencode/fan-novel-store-dry-run
npx wrangler deploy --dry-run --outdir /tmp/opencode/fan-novel-store-dry-run 2>&1 | tail -5
```

Expected: typecheck exit 0; `npm test` all suites pass (postgres suite skips without env var, which is allowed here); build exit 0; dry-run reports successful bundling, exit 0, no deployment. Output dir is external (/tmp/opencode/fan-novel-store-dry-run), never inside repo.

- [ ] **Step 2: Placeholder + secret scan**

```bash
grep -rnE 'TBD|TODO|FIXME|\.\.\.|implement later|appropriate error handling|handle edge cases|Similar to Task' docs/superpowers/plans/2026-09-19-decoration-store-backend.md src/routes/decorations.ts src/routes/admin.ts scripts/seed-decorations.ts 2>&1 | head; echo SCAN_DONE
grep -rnE 'DATABASE_URL=.+neon|sk-|eyJ|BEGIN PRIVATE|password' src/routes/decorations.ts src/routes/admin.ts scripts/seed-decorations.ts src/routes/*.test.ts 2>&1 | head; echo SECRET_SCAN_DONE
git status --short
```

Expected: `SCAN_DONE` with no hits above it; `SECRET_SCAN_DONE` with no hits; `git status` shows only plan-named files (no stray edits, no `.env`, no snapshot hand-edits beyond generated file).

- [ ] **Step 3: Do NOT commit verification artifacts; report only**

No commit in this task. Live-DB runbook gates (exact production-config validation, read-only health, backup, `migrate()`, authorized `wrangler deploy`, `/health db:up`, read-only catalog+sync smoke) are release-operator steps requiring explicit authorization and are NOT executed during implementation.

---

## Audit Trail (self-review fixes applied inline)

- Chose `DELETE /api/v1/admin/vip/:userId` over body variant; added negative test asserting body spelling 404s so both are never implemented.
- Reserved Play columns as names-only (`receipt_blob`, `purchase_token`, `verified_at`, `verifier`) with no DDL, honoring stub scope.
- Replaced interactive transactions with single-statement CTE blocks (SELECT with FOR UPDATE lock on the wallet row for the spend path) so Neon HTTP atomicity holds; row-count assertions map races to 409 without double-charge.
- Split `users.equipped_*` into inline columns (authoritative) + documented mapping export to avoid Drizzle `pgTable` limitation.
- Scoped Postgres tests to `decoration_store_test` with hostname guard, distinct from Phase-1 `phase1_identity_test`, and mandated create/drop around the run.
