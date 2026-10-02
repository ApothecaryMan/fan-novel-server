import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, {
    columns: Record<string, unknown>;
    indexes: Record<string, unknown>;
  }>;
};

function snapshot(name: string): Snapshot {
  return JSON.parse(readFileSync(join(root, 'drizzle', 'meta', `${name}_snapshot.json`), 'utf8')) as Snapshot;
}

describe('Drizzle migration ledger', () => {
  it('keeps every journal entry aligned with a chained snapshot', () => {
    const journal = JSON.parse(readFileSync(join(root, 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const snapshotCount = readdirSync(join(root, 'drizzle', 'meta'))
      .filter((name) => /^\d{4}_snapshot\.json$/.test(name)).length;
    const output = execFileSync(process.execPath, [join(root, 'scripts', 'check-migrations.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(output).toContain(`${journal.entries.length} journal entries`);
    expect(output).toContain(`${snapshotCount} chained snapshots`);
    expect(output).toContain('unique table/column/index operations');

    const tags = journal.entries.map(({ tag }) => tag);
    expect(tags).toEqual(expect.arrayContaining([
      '0008_add_content_hash',
      '0009_novel_comments_toggle',
      '0010_reading_stats_sync',
      '0011_pro_reading_data',
    ]));

    // 0007 is the recovered bio snapshot, 0008 is the preserved content-hash
    // state, and 0009 must contain only the comments-toggle delta.
    const bio = snapshot('0007');
    const contentHash = snapshot('0008');
    const commentsToggle = snapshot('0009');
    expect(contentHash.prevId).toBe(bio.id);
    expect(bio.tables['public.users'].columns).toHaveProperty('bio');
    expect(bio.tables['public.chapters'].columns).not.toHaveProperty('content_hash');
    expect(commentsToggle.prevId).toBe(contentHash.id);
    expect(commentsToggle.tables['public.novels'].columns).toHaveProperty('comments_enabled');
    expect(commentsToggle.tables['public.reading_sessions'].columns).not.toHaveProperty('progress_percent');

    const stats = snapshot('0010');
    const pro = snapshot('0011');
    expect(stats.prevId).toBe(commentsToggle.id);
    expect(stats.tables['public.reading_sessions'].columns).toHaveProperty('progress_percent');
    expect(stats.tables['public.users'].columns).toHaveProperty('reading_stats_plan');
    expect(pro.prevId).toBe(stats.id);
    expect(pro.tables['public.reading_chapter_state'].indexes).toEqual({
      reading_chapter_state_user_novel_chapter_idx: expect.any(Object),
    });
    expect(pro.tables['public.reading_chapter_state'].indexes).not.toHaveProperty('reading_chapter_state_user_novel_idx');
    // Spawns `check-migrations.mjs`; under a parallel run that can exceed the
    // 5s default and fail as a TIMEOUT rather than an integrity error.
  }, 60_000);

  it('does not generate a new migration from the checked-in schema', () => {
    const temp = mkdtempSync(join(tmpdir(), 'fan-novel-drizzle-check-'));
    try {
      cpSync(join(root, 'drizzle'), join(temp, 'drizzle'), { recursive: true });
      cpSync(join(root, 'drizzle.config.ts'), join(temp, 'drizzle.config.ts'));
      cpSync(join(root, 'package.json'), join(temp, 'package.json'));
      cpSync(join(root, 'tsconfig.json'), join(temp, 'tsconfig.json'));
      cpSync(join(root, 'src', 'database', 'schema.ts'), join(temp, 'src', 'database', 'schema.ts'), {
        recursive: false,
      });
      symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');

      const cli = join(root, 'node_modules', '.bin', 'drizzle-kit');
      const output = execFileSync(cli, ['generate', '--config=drizzle.config.ts', '--name=drift-check'], {
        cwd: temp,
        encoding: 'utf8',
      });
      expect(output).toMatch(/No schema changes/i);
      // A generated migration would be named `<entries.length>_drift-check.sql`.
      // Any such file means the checked-in snapshot disagrees with schema.ts.
      expect(readdirSync(join(temp, 'drizzle')).some((n) => n.endsWith('_drift-check.sql'))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    // Spawns drizzle-kit, which loads its whole module graph per run. Under
    // parallel CPU load this blows the 5s default and reports a timeout.
  }, 60_000);

  it('documents the transaction-safe index rollout and tests the concurrent preflight', () => {
    const migration = readFileSync(join(root, 'drizzle', '0010_reading_stats_sync.sql'), 'utf8');
    const statements = migration.replace(/--[^\n]*/g, '');
    const helper = readFileSync(join(root, 'scripts', 'apply-reading-indexes-concurrently.mjs'), 'utf8');
    const runbook = readFileSync(join(root, 'docs', 'DATABASE_MIGRATIONS.md'), 'utf8');

    expect(statements).toMatch(/SET LOCAL lock_timeout = '5s'/);
    expect(statements).toMatch(/SET LOCAL statement_timeout = '30min'/);
    expect(statements).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(statements).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i);
    expect(helper).toMatch(/create\s+index\s+concurrently/i);
    expect(helper).not.toMatch(/client\.query\(\s*['"`]begin/i);
    expect(runbook).toMatch(/CREATE INDEX CONCURRENTLY/);
    expect(runbook).toMatch(/maintenance window|low-write/i);
    expect(runbook).toMatch(/IF NOT EXISTS/);
  });
});
