import { pgTable, varchar, text, integer, real, boolean, timestamp, uuid, jsonb, bigint, uniqueIndex } from 'drizzle-orm/pg-core';

// 1. جدول المستخدمين (Users Table)
// externalId = stable client identity (mobile `google_<id>`). Auto-provisioned
// on first sync so offline-first clients never need a prior signup call.
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  externalId: varchar('external_id', { length: 255 }).unique(),
  email: varchar('email', { length: 255 }).unique(),
  username: varchar('username', { length: 100 }).unique(),
  passwordHash: text('password_hash'),
  avatarUrl: text('avatar_url'),
  role: varchar('role', { length: 20 }).default('reader').notNull(), // 'reader' | 'admin'
  isAuthor: boolean('is_author').default(false).notNull(),
  isTranslator: boolean('is_translator').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

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
  totalChapters: integer('total_chapters').default(0).notNull(),
  coverUrl: text('cover_url').notNull(),
  summary: text('summary').notNull(),
  featuredRank: integer('featured_rank'),
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
  userLibraryIdx: uniqueIndex('user_library_idx').on(table.userId, table.novelId)
}));

// 6. لقطات القراءة للمزامنة (Sync mirror of mobile reading_history).
// One "last read" row per (user, novel, chapter); merge keeps max read_at.
export const readingHistory = pgTable('reading_history', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  novelId: varchar('novel_id', { length: 100 }).notNull(),
  novelTitle: varchar('novel_title', { length: 255 }).default('').notNull(),
  novelCover: text('novel_cover').default('').notNull(),
  novelAuthor: varchar('novel_author', { length: 150 }).default('').notNull(),
  category: varchar('category', { length: 100 }).default('').notNull(),
  sourceId: varchar('source_id', { length: 100 }),
  chapterId: integer('chapter_id').notNull(),
  chapterNumber: integer('chapter_number').notNull(),
  chapterTitle: varchar('chapter_title', { length: 255 }).default('').notNull(),
  progressPercent: real('progress_percent').default(0).notNull(),
  readDay: varchar('read_day', { length: 10 }).notNull(),
  readAt: bigint('read_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  receivedAt: timestamp('received_at').defaultNow().notNull()
}, (table) => ({
  historyUserNovelChapterIdx: uniqueIndex('history_user_novel_chapter_idx').on(table.userId, table.novelId, table.chapterId)
}));

// 7. جلسات القراءة (append-only; idempotent via client_session_id).
export const readingSessions = pgTable('reading_sessions', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  clientSessionId: varchar('client_session_id', { length: 64 }).notNull(),
  novelId: varchar('novel_id', { length: 100 }).notNull(),
  chapterId: integer('chapter_id').notNull(),
  seconds: integer('seconds').notNull(),
  words: integer('words').notNull(),
  minuteOfDay: integer('minute_of_day').notNull(),
  readDay: varchar('read_day', { length: 10 }).notNull(),
  genre: varchar('genre', { length: 100 }).default('').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  receivedAt: timestamp('received_at').defaultNow().notNull()
}, (table) => ({
  sessionsUserClientIdx: uniqueIndex('sessions_user_client_idx').on(table.userId, table.clientSessionId)
}));

// 8. أغلفة الروايات (DB blob fallback when no object storage is bound).
// Covers average ~200KB; 0.5GB Neon holds ~2500 of them. Replaced by R2 when bound.
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

// Helper function for serial primary key type
function serial(name: string) {
  return integer(name).generatedAlwaysAsIdentity();
}
