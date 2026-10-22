import { sql } from 'drizzle-orm';
import { pgTable, varchar, text, integer, smallint, real, boolean, timestamp, uuid, jsonb, bigint, uniqueIndex, index, check, primaryKey, foreignKey } from 'drizzle-orm/pg-core';
import type { ProfileDecorations } from '../domain/profileDecorations.js';

// 1. جدول المستخدمين (Users Table)
// Production identity is google_<verified subject>; sync cannot create accounts.
// googleSubject is the permanent verified-identity anchor, not a migration aid.
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  externalId: varchar('external_id', { length: 255 }).unique(),
  googleSubject: varchar('google_subject', { length: 255 }).unique(),
  email: varchar('email', { length: 255 }).unique(),
  username: varchar('username', { length: 100 }).unique(),
  displayName: varchar('display_name', { length: 100 }),
  passwordHash: text('password_hash'),
  avatarUrl: text('avatar_url'),
  bannerUrl: text('banner_url'),
  // Display-name effect, banner wash and avatar frame, all three in ONE atomic
  // value: a half-updated card is impossible, and a decoration added later needs
  // no migration. NULL means "never picked" and costs one bit in the null map.
  // No DEFAULT on purpose — a default would force a full table rewrite on the
  // migration; nullable + no default is a catalog-only change in PG 11+.
  // Shape is gated by zod at the write (PATCH /auth/me) and re-read trust-nothing
  // via parseProfileDecorations on the way out. See domain/profileDecorations.ts.
  profileDecorations: jsonb('profile_decorations').$type<ProfileDecorations | null>(),
  bio: varchar('bio', { length: 500 }),
  // Owner-set weekly reading target, in hours (the "reading time this week"
  // card's goal). NULL means unset: the card shows its set-target placeholder.
  // Nullable + no DEFAULT keeps the migration a catalog-only change.
  weeklyReadingGoalHours: integer('weekly_reading_goal_hours'),
  role: varchar('role', { length: 20 }).default('reader').notNull(), // 'reader' | 'admin'
  readingStatsPlan: varchar('reading_stats_plan', { length: 10 }).default('free').notNull(),
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
  isAuthor: boolean('is_author').default(false).notNull(),
  isTranslator: boolean('is_translator').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  readingStatsPlanCheck: check('users_reading_stats_plan_check', sql`${table.readingStatsPlan} in ('free', 'pro')`),
  readingStatsPlanStatusCheck: check('users_reading_stats_plan_status_check', sql`${table.readingStatsPlanStatus} in ('free', 'active', 'expired', 'cancelled')`),
}));

// 1b. Pro subscription event log (append-only audit; never updated).
// Counters on users answer "how much"; these rows answer "who, when, from
// what expiry to what expiry, and why". Grant/renew/revoke writes commit
// atomically with the users update; expired rows are best-effort idempotent
// observations (partial unique on user + previous expiry where type=expired).
export const subscriptionEvents = pgTable('subscription_events', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  type: varchar('type', { length: 16 }).notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  previousExpiresAt: bigint('previous_expires_at', { mode: 'number' }),
  newExpiresAt: bigint('new_expires_at', { mode: 'number' }),
  durationDays: integer('duration_days'),
  reason: varchar('reason', { length: 500 }),
  occurredAt: bigint('occurred_at', { mode: 'number' }).notNull(),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
}, (table) => ({
  subscriptionEventsTypeCheck: check('subscription_events_type_check', sql`${table.type} in ('grant', 'renew', 'revoke', 'expired')`),
  subscriptionEventsUserOccurredIdx: index('subscription_events_user_occurred_idx').on(table.userId, table.occurredAt, table.id),
  subscriptionEventsExpiredUniqueIdx: uniqueIndex('subscription_events_expired_unique_idx').on(table.userId, table.previousExpiresAt).where(sql`${table.type} = 'expired'`),
}));

// 2. جدول الروايات (Novels Table)
export const novels = pgTable('novels', {
  id: varchar('id', { length: 100 }).primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  originalTitle: varchar('original_title', { length: 255 }),
  author: varchar('author', { length: 150 }).notNull(),
  translator: varchar('translator', { length: 150 }),
  status: varchar('status', { length: 50 }).default('مستمرة').notNull(),
  category: varchar('category', { length: 100 }).notNull(),
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  rating: integer('rating').default(50).notNull(),
  readersCount: varchar('readers_count', { length: 50 }).default('0').notNull(),
  // Denormalized sum of chapters.views_count. Incremented atomically with the
  // chapter counter on POST .../chapters/:n/view; never written by clients.
  viewsCount: integer('views_count').default(0).notNull(),
  totalChapters: integer('total_chapters').default(0).notNull(),
  coverUrl: text('cover_url').notNull(),
  summary: text('summary').notNull(),
  featuredRank: integer('featured_rank'),
  /**
   * Editorial translation-quality grade shown on the novel details screen.
   * One of TRANSLATION_RANKS ('B' | 'A' | 'S' | 'S+'). Nullable: a novel with
   * no grade set must stay unranked on the client, never default to a tier.
   */
  translationRank: varchar('translation_rank', { length: 2 }),
  commentsEnabled: boolean('comments_enabled').default(true).notNull(),
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  translatorUserId: uuid('translator_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// 3. جدول فصول الروايات (Chapters Table)
export const chapters = pgTable('chapters', {
  id: serial('id').primaryKey(),
  novelId: varchar('novel_id', { length: 100 }).references(() => novels.id, { onDelete: 'cascade' }).notNull(),
  chapterNumber: integer('chapter_number').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  contentRaw: text('content_raw'),
  contentHash: varchar('content_hash', { length: 64 }),
  wordCount: integer('word_count').default(0),
  viewsCount: integer('views_count').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  novelChapterUnique: uniqueIndex('novel_chapter_idx').on(table.novelId, table.chapterNumber)
}));

// 4. جدول أقسام المكتبة المخصصة (Tachiyomi Style Categories)
export const userCategories = pgTable('user_categories', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  orderIndex: integer('order_index').default(0).notNull(),
  isSystemDefault: boolean('is_system_default').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

// 5. مكتبة المستخدم للمزامنة (Sync mirror of mobile library_items).
// novelId has NO foreign key on purpose: most library novels are local
// (file:import / extensions) and never exist in the server novels table.
// Clocks are BIGINT UTC epoch ms generated on-device (ordering authority);
// received_at is audit/GC only and NEVER participates in LWW comparison.
export const userLibrary = pgTable('user_library', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  novelId: varchar('novel_id', { length: 100 }).notNull(),
  sourceId: varchar('source_id', { length: 100 }),
  categoryIds: jsonb('category_ids').$type<string[]>().default([]).notNull(),
  lastReadChapterId: integer('last_read_chapter_id'),
  lastReadChapterNumber: integer('last_read_chapter_number'),
  lastReadChapterTitle: varchar('last_read_chapter_title', { length: 255 }),
  progressPercent: real('progress_percent').default(0).notNull(),
  lastReadAt: timestamp('last_read_at'),
  addedAt: timestamp('added_at').defaultNow().notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
  receivedAt: timestamp('received_at').defaultNow().notNull()
}, (table) => ({
  userLibraryIdx: uniqueIndex('user_library_idx').on(table.userId, table.novelId),
  libraryCursorIdx: index('library_user_updated_id_idx').on(table.userId, table.updatedAt, table.id)
}));

// 7. جلسات القراءة (append-only; idempotent via client_session_id).
export const readingSessions = pgTable('reading_sessions', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  clientSessionId: varchar('client_session_id', { length: 64 }).notNull(),
  novelId: varchar('novel_id', { length: 100 }).notNull(),
  chapterId: integer('chapter_id').notNull(),
  progressPercent: real('progress_percent').default(0).notNull(),
  completed: boolean('completed').default(false).notNull(),
  completionSignalPresent: boolean('completion_signal_present').default(false).notNull(),
  proFieldsPresent: boolean('pro_fields_present').default(false).notNull(),
  seconds: integer('seconds').notNull(),
  words: integer('words').notNull(),
  minuteOfDay: integer('minute_of_day').notNull(),
  readDay: varchar('read_day', { length: 10 }).notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  receivedAt: timestamp('received_at').defaultNow().notNull()
}, (table) => ({
  sessionsUserClientIdx: uniqueIndex('sessions_user_client_idx').on(table.userId, table.clientSessionId),
  sessionsUserNovelChapterIdx: index('sessions_user_novel_chapter_idx').on(table.userId, table.novelId, table.chapterId),
  sessionsUserReadDayIdx: index('sessions_user_read_day_idx').on(table.userId, table.readDay),
  sessionsUserTsIdIdx: index('sessions_user_ts_id_idx').on(table.userId, table.ts, table.id),
  leaderboardReadDayIdx: index('leaderboard_read_day_idx')
    .on(table.readDay, table.userId)
    .where(sql`${table.completionSignalPresent} AND ${table.progressPercent} >= 85`)
}));

// Small per-user metadata cache for local/extension novels and Pro aggregates.
export const readingNovels = pgTable('reading_novels', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  novelId: varchar('novel_id', { length: 100 }).notNull(),
  title: varchar('title', { length: 255 }).default('').notNull(),
  genre: varchar('genre', { length: 100 }).default('').notNull(),
  sourceId: varchar('source_id', { length: 100 }),
  totalChapters: integer('total_chapters'),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  receivedAt: timestamp('received_at').defaultNow().notNull()
}, (table) => ({
  readingNovelsUserNovelIdx: uniqueIndex('reading_novels_user_novel_idx').on(table.userId, table.novelId)
}));

// 8. أغلفة الروايات (DEPRECATED: reads/writes removed now covers live in R2;
// table kept until a drop migration runs. Prod holds 0 rows as of 2026-10-03).
export const coverBlobs = pgTable('cover_blobs', {
  filename: varchar('filename', { length: 255 }).primaryKey(),
  mime: varchar('mime', { length: 50 }).notNull(),
  dataBase64: text('data_base64').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

// 8. طلبات الأذونات (author/translator grant requests; admin approves).
export const roleRequests = pgTable('role_requests', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(), // 'author' | 'translator'
  status: varchar('status', { length: 20 }).default('pending').notNull(), // 'pending' | 'approved' | 'rejected'
  note: varchar('note', { length: 500 }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  userKindPendingIdx: uniqueIndex('user_kind_pending_idx').on(table.userId, table.kind, table.status)
}));

// 9. Author API tokens (PATs for agent/MCP publishing).
// Only the sha256 hash is stored; plaintext is returned once at creation.
// Accepted only on authoring routes, and the owner's grant flags still apply.
export const authorApiKeys = pgTable('author_api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
  scopes: jsonb('scopes').$type<string[]>().default(['novels:write']).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at')
});

// Helper function for serial primary key type
function serial(name: string) {
  return integer(name).generatedAlwaysAsIdentity();
}

function bigserial(name: string) {
  return bigint(name, { mode: 'number' }).generatedAlwaysAsIdentity();
}

// 10. Native comments (app-native novels only: sourceId 'internal:published').
// Threading: parentId NULL = root; reply sets parentId + rootId + depth 1..3.
// chapterNumber NULL = novel-level comment, else chapter-scoped.
// Soft moderation via status; counters denormalized (no count(*) per request).
export const comments = pgTable('comments', {
  id: bigserial('id').primaryKey(),
  novelId: varchar('novel_id', { length: 100 }).references(() => novels.id, { onDelete: 'cascade' }).notNull(),
  chapterNumber: integer('chapter_number'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  parentId: bigint('parent_id', { mode: 'number' }),
  rootId: bigint('root_id', { mode: 'number' }),
  depth: smallint('depth').default(0).notNull(),
  body: text('body').notNull(),
  bodyHash: varchar('body_hash', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).default('visible').notNull(), // visible|pending|hidden|deleted
  likesCount: integer('likes_count').default(0).notNull(),
  repliesCount: integer('replies_count').default(0).notNull(),
  reportsCount: integer('reports_count').default(0).notNull(),
  editCount: integer('edit_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedReason: varchar('decided_reason', { length: 500 }),
}, (t) => ({
  rootsNewIdx: index('comments_roots_new').on(t.novelId, t.chapterNumber, t.createdAt, t.id),
  rootsTopIdx: index('comments_roots_top').on(t.novelId, t.chapterNumber, t.likesCount, t.id),
  threadIdx: index('comments_thread').on(t.rootId, t.createdAt, t.id),
  parentIdx: index('comments_parent').on(t.parentId, t.createdAt, t.id),
  userIdx: index('comments_user').on(t.userId, t.createdAt, t.id),
}));

// 11. Comment votes (like/dislike). PK doubles as toggle uniqueness guard.
export const commentVotes = pgTable('comment_votes', {
  commentId: bigint('comment_id', { mode: 'number' }).references(() => comments.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  value: smallint('value').default(1).notNull(), // 1 | -1 (UI may expose like-only v1)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  votesPk: uniqueIndex('comment_votes_pkey').on(t.commentId, t.userId),
  userLookupIdx: index('comment_votes_user').on(t.userId, t.commentId),
}));

// 12. Moderation audit log (append-only; never updated).
export const commentModLog = pgTable('comment_mod_log', {
  id: bigserial('id').primaryKey(),
  commentId: bigint('comment_id', { mode: 'number' }).references(() => comments.id, { onDelete: 'cascade' }).notNull(),
  action: varchar('action', { length: 20 }).notNull(), // hide|restore|approve|delete|hard_delete|report
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  reason: varchar('reason', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 13b. Achievement unlock deltas (client-evaluated, cosmetic v1).
// One row per (user, achievement). Push merges MIN(first_seen_at) and
// MAX(level); the server never evaluates thresholds. Higher catalog_version
// wins on mismatch. updated_at is LWW for GC/debugging only.
export const userAchievementUnlocks = pgTable('user_achievement_unlocks', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  achievementId: varchar('achievement_id', { length: 100 }).notNull(),
  level: smallint('level').notNull(),
  firstSeenAt: bigint('first_seen_at', { mode: 'number' }).notNull(),
  catalogVersion: integer('catalog_version').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  userAchievementUnlocksPk: uniqueIndex('user_achievement_unlocks_pkey').on(t.userId, t.achievementId),
  userAchievementUnlocksLevelCheck: check('user_achievement_unlocks_level_check', sql`${t.level} >= 2 AND ${t.level} <= 6`),
}));

// 13. Global chapter-view dedup (powers public view counters).
// One row per (novel, chapter, viewer). Counters live on chapters.views_count
// and novels.views_count; this table only answers "did this viewer already
// count this chapter inside the revisit window?" so a re-open within 12 hours
// does not inflate the public counter. viewer_key is `u:<userId>` for signed
// requests, else `ip:<sha256(ip|ua)>` — no raw IP is stored.
export const chapterViewDedup = pgTable('chapter_view_dedup', {
  novelId: varchar('novel_id', { length: 100 }).references(() => novels.id, { onDelete: 'cascade' }).notNull(),
  chapterNumber: integer('chapter_number').notNull(),
  viewerKey: varchar('viewer_key', { length: 64 }).notNull(),
  lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  chapterViewDedupPk: uniqueIndex('chapter_view_dedup_pk').on(t.novelId, t.chapterNumber, t.viewerKey),
  chapterViewDedupRecentIdx: index('chapter_view_dedup_recent_idx').on(t.lastViewedAt),
}));

// 14. Store catalog (open types via code registry, not DB enum).
export const storeItems = pgTable('store_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  sku: varchar('sku', { length: 100 }).notNull().unique(),
  type: varchar('type', { length: 32 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  pricePoints: integer('price_points').notNull(),
  currency: varchar('currency', { length: 16 }).default('free').notNull(),
  rarity: varchar('rarity', { length: 32 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  availableFrom: timestamp('available_from', { withTimezone: true }),
  availableUntil: timestamp('available_until', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pricePositive: check('store_items_price_positive', sql`${t.pricePoints} > 0`),
  currencyCheck: check('store_items_currency', sql`${t.currency} in ('free','pro')`),
}));

// 15. Points ledger (append-only via trigger, source of truth).
export const pointTransactions = pgTable('point_transactions', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  amount: integer('amount').notNull(),
  balanceAfter: integer('balance_after').notNull(),
  currency: varchar('currency', { length: 16 }).default('free').notNull(),
  type: varchar('type', { length: 32 }).notNull(),
  referenceType: varchar('reference_type', { length: 64 }),
  referenceId: varchar('reference_id', { length: 128 }),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  reason: varchar('reason', { length: 500 }),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdemUq: uniqueIndex('ptx_user_idem_uq').on(t.userId, t.idempotencyKey),
  userCreatedIdx: index('ptx_user_created_idx').on(t.userId, t.createdAt),
  amountNonzero: check('ptx_amount_nonzero', sql`${t.amount} <> 0`),
  currencyCheck: check('ptx_currency', sql`${t.currency} in ('free','pro')`),
  typeCheck: check('ptx_type_check', sql`${t.type} in ('reward','iap_purchase','spend','refund','admin_adjust')`),
}));

// 16. Cached balances (lock rows for FOR UPDATE).
export const userCoinBalances = pgTable('user_coin_balances', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  currency: varchar('currency', { length: 16 }).notNull(),
  balance: integer('balance').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.currency] }),
  check('ucb_currency', sql`${t.currency} in ('free','pro')`),
]);

// 17. Owned items (one row per user+item).
export const userInventory = pgTable('user_inventory', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  itemId: uuid('item_id').references(() => storeItems.id, { onDelete: 'restrict' }).notNull(),
  source: varchar('source', { length: 32 }).notNull(),
  pricePaid: integer('price_paid').notNull(),
  currency: varchar('currency', { length: 16 }).notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('inv_user_item_uq').on(t.userId, t.itemId),
  check('inv_currency', sql`${t.currency} in ('free','pro')`),
]);

// 18. Equipped slots (source of truth, cache in users.profile_decorations).
export const userEquipped = pgTable('user_equipped', {
  userId: uuid('user_id').notNull(),
  slot: varchar('slot', { length: 32 }).notNull(),
  itemId: uuid('item_id').notNull(),
  equippedAt: timestamp('equipped_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.slot] }),
  foreignKey({ columns: [t.userId, t.itemId], foreignColumns: [userInventory.userId, userInventory.itemId] }),
]);

// 19. IAP purchases (server-verified, token dedup).
export const iapPurchases = pgTable('iap_purchases', {
  purchaseToken: varchar('purchase_token', { length: 255 }).primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
  sku: varchar('sku', { length: 100 }).notNull(),
  pointsGranted: integer('points_granted').notNull(),
  currency: varchar('currency', { length: 16 }).notNull(),
  status: varchar('status', { length: 20 }).default('granted').notNull(),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  currencyCheck: check('iap_currency', sql`${t.currency} in ('free','pro')`),
}));
