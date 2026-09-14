import { pgTable, varchar, text, integer, boolean, timestamp, uuid, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

// 1. جدول المستخدمين (Users Table)
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  username: varchar('username', { length: 100 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
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

// 5. جدول الروايات في مكتبة المستخدم (User Library)
export const userLibrary = pgTable('user_library', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  novelId: varchar('novel_id', { length: 100 }).references(() => novels.id, { onDelete: 'cascade' }).notNull(),
  categoryIds: jsonb('category_ids').$type<number[]>().default([]).notNull(),
  isCurrentlyReading: boolean('is_currently_reading').default(true).notNull(),
  addedAt: timestamp('added_at').defaultNow().notNull()
}, (table) => ({
  userLibraryIdx: uniqueIndex('user_library_idx').on(table.userId, table.novelId)
}));

// 6. جدول مزامنة موضع القراءة (Reading Progress Sync)
export const userReadingProgress = pgTable('user_reading_progress', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  novelId: varchar('novel_id', { length: 100 }).references(() => novels.id, { onDelete: 'cascade' }).notNull(),
  chapterId: integer('chapter_id').notNull(),
  scrollY: integer('scroll_y').default(0).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  userNovelProgressIdx: uniqueIndex('user_novel_progress_idx').on(table.userId, table.novelId)
}));

// Helper function for serial primary key type
function serial(name: string) {
  return integer(name).generatedAlwaysAsIdentity();
}
