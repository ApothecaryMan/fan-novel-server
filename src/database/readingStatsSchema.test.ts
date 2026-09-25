import { readFileSync } from 'node:fs';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  readingChapterState,
  readingHistory,
  readingNovels,
  readingSessions,
  userLibrary,
  users,
} from './schema.js';

function columnsBySqlName(table: PgTable) {
  return Object.fromEntries(getTableConfig(table).columns.map((column) => [column.name, column]));
}

function indexesByName(table: PgTable) {
  return Object.fromEntries(getTableConfig(table).indexes.map(({ config }) => [
    config.name,
    {
      unique: config.unique,
      columns: config.columns.map((column: any) => column.name),
    },
  ]));
}

function migration(name: string) {
  return readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8');
}

describe('reading statistics database schema', () => {
  it('defines the server-owned plan and legacy-safe session evidence columns', () => {
    const userColumns = columnsBySqlName(users);
    expect(userColumns.reading_stats_plan).toMatchObject({
      dataType: 'string',
      notNull: true,
      default: 'free',
    });
    expect(userColumns.reading_stats_plan.getSQLType()).toBe('varchar(10)');
    expect(getTableConfig(users).checks.map(({ name }) => name))
      .toEqual(['users_reading_stats_plan_check']);

    const sessionColumns = columnsBySqlName(readingSessions);
    expect(sessionColumns.progress_percent).toMatchObject({ dataType: 'number', notNull: true, default: 0 });
    expect(sessionColumns.progress_percent.getSQLType()).toBe('real');
    for (const name of ['completed', 'completion_signal_present', 'pro_fields_present']) {
      expect(sessionColumns[name]).toMatchObject({ dataType: 'boolean', notNull: true, default: false });
    }
  });

  it('keeps idempotency and adds calculation and deterministic cursor indexes', () => {
    expect(indexesByName(userLibrary)).toMatchObject({
      library_user_updated_id_idx: { unique: false, columns: ['user_id', 'updated_at', 'id'] },
    });
    expect(indexesByName(readingHistory)).toMatchObject({
      history_user_read_at_id_idx: { unique: false, columns: ['user_id', 'read_at', 'id'] },
    });
    expect(indexesByName(readingSessions)).toMatchObject({
      sessions_user_client_idx: { unique: true, columns: ['user_id', 'client_session_id'] },
      sessions_user_novel_chapter_idx: { unique: false, columns: ['user_id', 'novel_id', 'chapter_id'] },
      sessions_user_read_day_idx: { unique: false, columns: ['user_id', 'read_day'] },
      sessions_user_ts_id_idx: { unique: false, columns: ['user_id', 'ts', 'id'] },
    });
  });

  it('defines Pro chapter state and novel metadata with stable per-user keys', () => {
    expect(getTableConfig(readingChapterState).name).toBe('reading_chapter_state');
    expect(getTableConfig(readingChapterState).checks.map(({ name }) => name))
      .toEqual(['reading_chapter_state_origin_check']);
    expect(indexesByName(readingChapterState)).toMatchObject({
      reading_chapter_state_user_novel_chapter_idx: {
        unique: true,
        columns: ['user_id', 'novel_id', 'chapter_id'],
      },
      reading_chapter_state_user_novel_idx: { unique: false, columns: ['user_id', 'novel_id'] },
    });

    const chapterStateForeignKey = getTableConfig(readingChapterState).foreignKeys[0];
    expect(chapterStateForeignKey.onDelete).toBe('cascade');
    expect(chapterStateForeignKey.getName()).toBe('reading_chapter_state_user_id_users_id_fk');

    expect(getTableConfig(readingNovels).name).toBe('reading_novels');
    expect(indexesByName(readingNovels)).toMatchObject({
      reading_novels_user_novel_idx: { unique: true, columns: ['user_id', 'novel_id'] },
    });
    const novelForeignKey = getTableConfig(readingNovels).foreignKeys[0];
    expect(novelForeignKey.onDelete).toBe('cascade');
    expect(novelForeignKey.getName()).toBe('reading_novels_user_id_users_id_fk');
  });

  it('ships both additive migrations in Drizzle execution order', () => {
    const planMigration = migration('0011_reading_stats_sync.sql');
    expect(planMigration).toContain(
      'ALTER TABLE "users" ADD COLUMN "reading_stats_plan" varchar(10) DEFAULT \'free\' NOT NULL;',
    );
    expect(planMigration).toContain(
      'ALTER TABLE "users" ADD CONSTRAINT "users_reading_stats_plan_check" CHECK ("reading_stats_plan" in (\'free\', \'pro\'));',
    );
    expect(planMigration).toContain(
      'ALTER TABLE "reading_sessions" ADD COLUMN "completed" boolean DEFAULT false NOT NULL;',
    );
    expect(planMigration).toContain(
      'ALTER TABLE "reading_sessions" ADD COLUMN "completion_signal_present" boolean DEFAULT false NOT NULL;',
    );
    expect(planMigration).toContain(
      'ALTER TABLE "reading_sessions" ADD COLUMN "pro_fields_present" boolean DEFAULT false NOT NULL;',
    );
    expect(planMigration).toContain(
      'CREATE INDEX "history_user_read_at_id_idx" ON "reading_history" USING btree ("user_id","read_at","id");',
    );
    expect(planMigration).toContain(
      'CREATE INDEX "sessions_user_novel_chapter_idx" ON "reading_sessions" USING btree ("user_id","novel_id","chapter_id");',
    );
    expect(planMigration).toContain(
      'CREATE INDEX "sessions_user_read_day_idx" ON "reading_sessions" USING btree ("user_id","read_day");',
    );
    expect(planMigration).toContain(
      'CREATE INDEX "sessions_user_ts_id_idx" ON "reading_sessions" USING btree ("user_id","ts","id");',
    );
    expect(planMigration).toContain(
      'CREATE INDEX "library_user_updated_id_idx" ON "user_library" USING btree ("user_id","updated_at","id");',
    );
    expect(planMigration).not.toMatch(/DROP\s+(?:INDEX|COLUMN|CONSTRAINT)/i);

    const proMigration = migration('0012_pro_reading_data.sql');
    expect(proMigration).toContain('CREATE TABLE "reading_chapter_state"');
    expect(proMigration).toContain(
      'CONSTRAINT "reading_chapter_state_origin_check" CHECK ("origin" in (\'manual\', \'snapshot\'))',
    );
    expect(proMigration).toContain('CREATE TABLE "reading_novels"');
    expect(proMigration).toContain('ON DELETE cascade');
    expect(proMigration).toContain(
      'CREATE UNIQUE INDEX "reading_chapter_state_user_novel_chapter_idx"',
    );
    expect(proMigration).toContain(
      'CREATE UNIQUE INDEX "reading_novels_user_novel_idx"',
    );

    const journal = JSON.parse(migration('meta/_journal.json'));
    expect(journal.entries.slice(-2).map(({ tag }: { tag: string }) => tag)).toEqual([
      '0011_reading_stats_sync',
      '0012_pro_reading_data',
    ]);
  });
});
