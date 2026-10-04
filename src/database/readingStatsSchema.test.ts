import { readFileSync } from 'node:fs';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  chapters,
  novels,
  readingNovels,
  readingSessions,
  subscriptionEvents,
  userLibrary,
  users,
} from './schema.js';

type ColumnSpec = {
  type: string;
  notNull: boolean;
  primary?: boolean;
  hasDefault?: boolean;
  default?: unknown;
  identity?: string;
};

function column(
  type: string,
  notNull: boolean,
  options: Omit<ColumnSpec, 'type' | 'notNull'> = {},
): ColumnSpec {
  return { type, notNull, ...options };
}

function expectColumns(table: PgTable, expected: Record<string, ColumnSpec>) {
  const actual = Object.fromEntries(getTableConfig(table).columns.map((column) => {
    const value: Record<string, unknown> = {
      type: column.getSQLType(),
      notNull: column.notNull,
      primary: column.primary,
      hasDefault: column.hasDefault,
      identity: column.generatedIdentity?.type,
    };
    if (Object.prototype.hasOwnProperty.call(expected[column.name] ?? {}, 'default')) {
      value.default = column.default;
    }
    return [column.name, value];
  }));

  // Column order is not a useful contract for this test; names, types, and
  // nullability are. Keeping the set comparison also makes additions fail
  // loudly instead of being silently missed by a partial object assertion.
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [name, spec] of Object.entries(expected)) {
    const checks: Record<string, unknown> = {
      type: spec.type,
      notNull: spec.notNull,
    };
    if (spec.primary !== undefined) checks.primary = spec.primary;
    if (spec.hasDefault !== undefined) checks.hasDefault = spec.hasDefault;
    if (spec.identity !== undefined) checks.identity = spec.identity;
    if (Object.prototype.hasOwnProperty.call(spec, 'default')) checks.default = spec.default;
    expect(actual[name], `column ${name}`).toMatchObject(checks);
  }
}

function indexesByName(table: PgTable) {
  return Object.fromEntries(getTableConfig(table).indexes.map(({ config }) => [
    config.name,
    {
      unique: config.unique,
      columns: config.columns.map((column) => (column as { name: string }).name),
    },
  ]));
}

function uniqueColumns(table: PgTable) {
  return getTableConfig(table).columns
    .filter((column) => column.isUnique)
    .map((column) => column.name)
    .sort();
}

function foreignKeysByName(table: PgTable) {
  return Object.fromEntries(getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return [foreignKey.getName(), {
      columns: reference.columns.map((column) => column.name),
      foreignTable: getTableConfig(reference.foreignTable).name,
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      onDelete: foreignKey.onDelete,
      onUpdate: foreignKey.onUpdate,
    }];
  }));
}

function checksByName(table: PgTable) {
  const dialect = new PgDialect();
  return Object.fromEntries(getTableConfig(table).checks.map((check) => [
    check.name,
    dialect.sqlToQuery(check.value).sql.replace(/\s+/g, ' ').trim(),
  ]));
}

function migration(name: string) {
  return readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8');
}

function normalizedMigration(name: string) {
  return migration(name)
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('reading statistics database schema', () => {
  it('defines every column affected by the 0009–0012 migrations', () => {
    expectColumns(chapters, {
      id: column('integer', true, { primary: true, hasDefault: true, identity: 'always' }),
      novel_id: column('varchar(100)', true),
      chapter_number: column('integer', true),
      title: column('varchar(255)', true),
      content_raw: column('text', false),
      content_hash: column('varchar(64)', false),
      word_count: column('integer', false, { hasDefault: true, default: 0 }),
      views_count: column('integer', false, { hasDefault: true, default: 0 }),
      created_at: column('timestamp', true, { hasDefault: true }),
    });

    expectColumns(users, {
      id: column('uuid', true, { primary: true, hasDefault: true }),
      external_id: column('varchar(255)', false),
      google_subject: column('varchar(255)', false),
      email: column('varchar(255)', false),
      username: column('varchar(100)', false),
      display_name: column('varchar(100)', false),
      password_hash: column('text', false),
      avatar_url: column('text', false),
      banner_url: column('text', false),
      // Owner decorations (name effect / banner wash / avatar frame). Nullable
      // with NO default on purpose: a default would force a full table rewrite
      // when 0015 adds it, whereas nullable+no-default is a catalog-only change.
      profile_decorations: column('jsonb', false),
      bio: column('varchar(500)', false),
      // Owner-set weekly reading target in hours (0017). Nullable with NO
      // default: unset is the "show the set-target placeholder" state.
      weekly_reading_goal_hours: column('integer', false),
      role: column('varchar(20)', true, { hasDefault: true, default: 'reader' }),
      reading_stats_plan: column('varchar(10)', true, { hasDefault: true, default: 'free' }),
      reading_stats_plan_started_at: column('bigint', false),
      reading_stats_plan_expires_at: column('bigint', false),
      reading_stats_trial_started_at: column('bigint', false),
      reading_stats_trial_ends_at: column('bigint', false),
      reading_stats_last_renewed_at: column('bigint', false),
      reading_stats_grace_until: column('bigint', false),
      reading_stats_plan_duration_days: column('integer', true, { hasDefault: true, default: 30 }),
      reading_stats_plan_status: column('varchar(20)', true, { hasDefault: true, default: 'free' }),
      reading_stats_renewal_count: column('integer', true, { hasDefault: true, default: 0 }),
      reading_stats_total_subscribed_ms: column('bigint', true, { hasDefault: true, default: 0 }),
      is_author: column('boolean', true, { hasDefault: true, default: false }),
      is_translator: column('boolean', true, { hasDefault: true, default: false }),
      created_at: column('timestamp', true, { hasDefault: true }),
      updated_at: column('timestamp', true, { hasDefault: true }),
    });

    expectColumns(novels, {
      id: column('varchar(100)', true, { primary: true }),
      title: column('varchar(255)', true),
      original_title: column('varchar(255)', false),
      author: column('varchar(150)', true),
      translator: column('varchar(150)', false),
      status: column('varchar(50)', true, { hasDefault: true, default: 'مستمرة' }),
      category: column('varchar(100)', true),
      tags: column('jsonb', true, { hasDefault: true, default: [] }),
      rating: column('integer', true, { hasDefault: true, default: 50 }),
      readers_count: column('varchar(50)', true, { hasDefault: true, default: '0' }),
      total_chapters: column('integer', true, { hasDefault: true, default: 0 }),
      cover_url: column('text', true),
      summary: column('text', true),
      featured_rank: column('integer', false),
      translation_rank: column('varchar(2)', false),
      comments_enabled: column('boolean', true, { hasDefault: true, default: true }),
      author_user_id: column('uuid', false),
      translator_user_id: column('uuid', false),
      created_at: column('timestamp', true, { hasDefault: true }),
      updated_at: column('timestamp', true, { hasDefault: true }),
    });

    expectColumns(userLibrary, {
      id: column('integer', true, { primary: true, hasDefault: true, identity: 'always' }),
      user_id: column('uuid', true),
      novel_id: column('varchar(100)', true),
      source_id: column('varchar(100)', false),
      category_ids: column('jsonb', true, { hasDefault: true, default: [] }),
      last_read_chapter_id: column('integer', false),
      last_read_chapter_number: column('integer', false),
      last_read_chapter_title: column('varchar(255)', false),
      progress_percent: column('real', true, { hasDefault: true, default: 0 }),
      last_read_at: column('timestamp', false),
      added_at: column('timestamp', true, { hasDefault: true }),
      updated_at: column('bigint', true),
      deleted_at: column('bigint', false),
      received_at: column('timestamp', true, { hasDefault: true }),
    });

    expectColumns(readingSessions, {
      id: column('integer', true, { primary: true, hasDefault: true, identity: 'always' }),
      user_id: column('uuid', true),
      client_session_id: column('varchar(64)', true),
      novel_id: column('varchar(100)', true),
      chapter_id: column('integer', true),
      progress_percent: column('real', true, { hasDefault: true, default: 0 }),
      completed: column('boolean', true, { hasDefault: true, default: false }),
      completion_signal_present: column('boolean', true, { hasDefault: true, default: false }),
      pro_fields_present: column('boolean', true, { hasDefault: true, default: false }),
      seconds: column('integer', true),
      words: column('integer', true),
      minute_of_day: column('integer', true),
      read_day: column('varchar(10)', true),
      ts: column('bigint', true),
      received_at: column('timestamp', true, { hasDefault: true }),
    });

    expectColumns(readingNovels, {
      id: column('integer', true, { primary: true, hasDefault: true, identity: 'always' }),
      user_id: column('uuid', true),
      novel_id: column('varchar(100)', true),
      title: column('varchar(255)', true, { hasDefault: true, default: '' }),
      genre: column('varchar(100)', true, { hasDefault: true, default: '' }),
      source_id: column('varchar(100)', false),
      total_chapters: column('integer', false),
      updated_at: column('bigint', true),
      received_at: column('timestamp', true, { hasDefault: true }),
    });

    expectColumns(subscriptionEvents, {
      id: column('integer', true, { primary: true, hasDefault: true, identity: 'always' }),
      user_id: column('uuid', true),
      type: column('varchar(16)', true),
      actor_id: column('uuid', false),
      previous_expires_at: column('bigint', false),
      new_expires_at: column('bigint', false),
      duration_days: column('integer', false),
      reason: column('varchar(500)', false),
      occurred_at: column('bigint', true),
      received_at: column('timestamp', true, { hasDefault: true }),
    });
  });

  it('keeps column uniqueness, check constraints, and foreign-key actions explicit', () => {
    expect(uniqueColumns(users)).toEqual(['email', 'external_id', 'google_subject', 'username']);
    expect(uniqueColumns(userLibrary)).toEqual([]);
    expect(uniqueColumns(readingSessions)).toEqual([]);
    expect(uniqueColumns(readingNovels)).toEqual([]);

    const userChecks = checksByName(users);
    expect(Object.keys(userChecks).sort()).toEqual(['users_reading_stats_plan_check', 'users_reading_stats_plan_status_check']);
    expect(userChecks.users_reading_stats_plan_check).toMatch(
      /"reading_stats_plan" in \('free', 'pro'\)/,
    );
    expect(userChecks.users_reading_stats_plan_status_check).toMatch(
      /"reading_stats_plan_status" in \('free', 'active', 'expired', 'cancelled'\)/,
    );
    expect(checksByName(readingNovels)).toEqual({});
    const eventChecks = checksByName(subscriptionEvents);
    expect(Object.keys(eventChecks)).toEqual(['subscription_events_type_check']);
    expect(eventChecks.subscription_events_type_check).toMatch(
      /"type" in \('grant', 'renew', 'revoke', 'expired'\)/,
    );

    expect(foreignKeysByName(users)).toEqual({});
    expect(foreignKeysByName(userLibrary)).toEqual({
      user_library_user_id_users_id_fk: {
        columns: ['user_id'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'no action',
      },
    });
    expect(foreignKeysByName(readingSessions)).toEqual({
      reading_sessions_user_id_users_id_fk: {
        columns: ['user_id'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'no action',
      },
    });
    expect(foreignKeysByName(readingNovels)).toEqual({
      reading_novels_user_id_users_id_fk: {
        columns: ['user_id'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'no action',
      },
    });
    expect(foreignKeysByName(subscriptionEvents)).toEqual({
      subscription_events_user_id_users_id_fk: {
        columns: ['user_id'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'no action',
      },
      subscription_events_actor_id_users_id_fk: {
        columns: ['actor_id'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'set null',
        onUpdate: 'no action',
      },
    });
    expect(foreignKeysByName(chapters)).toEqual({
      chapters_novel_id_novels_id_fk: {
        columns: ['novel_id'],
        foreignTable: 'novels',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'no action',
      },
    });
    expect(foreignKeysByName(novels)).toEqual({
      novels_author_user_id_users_id_fk: {
        columns: ['author_user_id'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'set null',
        onUpdate: 'no action',
      },
      novels_translator_user_id_users_id_fk: {
        columns: ['translator_user_id'],
        foreignTable: 'users',
        foreignColumns: ['id'],
        onDelete: 'set null',
        onUpdate: 'no action',
      },
    });
  });

  it('defines the exact index set', () => {
    expect(indexesByName(userLibrary)).toEqual({
      user_library_idx: { unique: true, columns: ['user_id', 'novel_id'] },
      library_user_updated_id_idx: { unique: false, columns: ['user_id', 'updated_at', 'id'] },
    });
    expect(indexesByName(readingSessions)).toEqual({
      sessions_user_client_idx: { unique: true, columns: ['user_id', 'client_session_id'] },
      sessions_user_novel_chapter_idx: { unique: false, columns: ['user_id', 'novel_id', 'chapter_id'] },
      sessions_user_read_day_idx: { unique: false, columns: ['user_id', 'read_day'] },
      sessions_user_ts_id_idx: { unique: false, columns: ['user_id', 'ts', 'id'] },
    });
    expect(indexesByName(readingNovels)).toEqual({
      reading_novels_user_novel_idx: { unique: true, columns: ['user_id', 'novel_id'] },
    });
    expect(indexesByName(subscriptionEvents)).toEqual({
      subscription_events_user_occurred_idx: { unique: false, columns: ['user_id', 'occurred_at', 'id'] },
      subscription_events_expired_unique_idx: { unique: true, columns: ['user_id', 'previous_expires_at'] },
    });
  });

  it('keeps additive SQL assertions independent of whitespace and statement order', () => {
    const commentsToggle = normalizedMigration('0009_novel_comments_toggle.sql');
    expect(commentsToggle).toMatch(
      /ALTER TABLE "novels" ADD COLUMN "comments_enabled" boolean DEFAULT true NOT NULL;/,
    );
    expect(commentsToggle).not.toMatch(/DROP\s+(?:INDEX|COLUMN|CONSTRAINT)/i);

    const planMigration = normalizedMigration('0010_reading_stats_sync.sql');
    expect(planMigration).toContain(
      'ALTER TABLE "users" ADD COLUMN "reading_stats_plan" varchar(10) DEFAULT \'free\' NOT NULL;',
    );
    expect(planMigration).toContain(
      'ALTER TABLE "users" ADD CONSTRAINT "users_reading_stats_plan_check" CHECK ("reading_stats_plan" in (\'free\', \'pro\'));',
    );
    for (const columnName of ['progress_percent', 'completed', 'completion_signal_present', 'pro_fields_present']) {
      expect(planMigration).toMatch(new RegExp(`ALTER TABLE "reading_sessions" ADD COLUMN "${columnName}"`));
    }
    for (const indexName of [
      'library_user_updated_id_idx',
      'history_user_read_at_id_idx',
      'sessions_user_novel_chapter_idx',
      'sessions_user_read_day_idx',
      'sessions_user_ts_id_idx',
    ]) {
      expect(planMigration).toContain(`CREATE INDEX IF NOT EXISTS "${indexName}"`);
    }
    expect(planMigration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(planMigration).toContain("SET LOCAL statement_timeout = '30min'");
    expect(planMigration).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i);
    expect(planMigration).not.toMatch(/DROP\s+(?:INDEX|COLUMN|CONSTRAINT)/i);

    const proMigration = normalizedMigration('0011_pro_reading_data.sql');
    expect(proMigration).toMatch(/CREATE TABLE "reading_chapter_state"/);
    expect(proMigration).toMatch(/CREATE TABLE "reading_novels"/);
    expect(proMigration).toContain('reading_chapter_state_origin_check');
    expect(proMigration).toContain('reading_chapter_state_user_id_users_id_fk');
    expect(proMigration).toContain('reading_novels_user_id_users_id_fk');
    expect(proMigration).toContain('CREATE UNIQUE INDEX "reading_chapter_state_user_novel_chapter_idx"');
    expect(proMigration).toContain('CREATE UNIQUE INDEX "reading_novels_user_novel_idx"');
    expect(proMigration).not.toContain('reading_chapter_state_user_novel_idx');
  });
});
