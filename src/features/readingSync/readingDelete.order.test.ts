import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

// ==========================================
// Gate-first ordering of the delete flows.
//
// A partial failure must never leave deleted data without its gate: the
// stats_reset_at write (reset) and the tombstone upsert (novel delete) run
// before any session delete. On pg the sequence additionally runs in one
// transaction behind the per-user lock; on Workers (neon-http, no
// interactive transactions) the same order runs as sequential statements.
// ==========================================

const holder = vi.hoisted(() => ({
  fake: null as Record<string, any> | null,
  driver: 'pg' as 'pg' | 'neon-http',
  failOn: null as string | null,
}));

vi.mock('../../database/db.js', () => ({
  db: new Proxy({}, { get: (_target, key) => (holder.fake as any)[key] }),
  dbDriver: () => holder.driver,
}));

function tableName(table: unknown): string {
  try {
    return getTableName(table as never);
  } catch {
    return 'unknown';
  }
}

function makeShim(ops: string[], prefix: string) {
  const maybeThrow = (op: string) => {
    if (holder.failOn === op) throw new Error(`injected failure at ${op}`);
  };
  return {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => Promise.resolve([]),
      }),
    }),
    update: (table: unknown) => ({
      set: (_patch: unknown) => ({
        where: (_cond: unknown) => {
          const op = `${prefix}update ${tableName(table)}`;
          ops.push(op);
          maybeThrow(op);
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (_cond: unknown) => {
        const op = `${prefix}delete ${tableName(table)}`;
        ops.push(op);
        maybeThrow(op);
        return Promise.resolve([]);
      },
    }),
    insert: (table: unknown) => ({
      values: (_values: unknown) => ({
        onConflictDoUpdate: (_conf: unknown) => {
          const op = `${prefix}insert ${tableName(table)}`;
          ops.push(op);
          maybeThrow(op);
          return Promise.resolve([]);
        },
      }),
    }),
  };
}

let ops: string[];

beforeEach(() => {
  ops = [];
  holder.failOn = null;
  holder.driver = 'pg';
  const shim = makeShim(ops, '');
  const txShim = makeShim(ops, 'tx.');
  holder.fake = {
    ...shim,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      ops.push('transaction');
      return fn(txShim);
    },
  };
});

afterEach(() => {
  holder.fake = null;
});

describe('delete gate-first ordering', () => {
  it('reset writes the gate before every delete inside one pg transaction', async () => {
    const { resetUserReadingData } = await import('./readingDelete.js');
    const resetAt = await resetUserReadingData('user-1', 1_800_000_000_000);
    expect(resetAt).toBe(1_800_000_000_000);
    expect(ops).toEqual([
      'transaction',
      'tx.update users',
      'tx.delete reading_sessions',
      'tx.delete reading_novels',
      'tx.delete reading_novel_tombstones',
      'tx.delete user_achievement_unlocks',
    ]);
  });

  it('novel delete upserts the tombstone before the session deletes inside one pg transaction', async () => {
    const { deleteNovelReadingData } = await import('./readingDelete.js');
    const deletedAt = await deleteNovelReadingData('user-1', '42', 1_800_000_000_000);
    expect(deletedAt).toBe(1_800_000_000_000);
    expect(ops).toEqual([
      'transaction',
      'tx.insert reading_novel_tombstones',
      'tx.delete reading_sessions',
      'tx.delete reading_novels',
    ]);
  });

  it('a mid-sequence pg failure propagates and later statements never run', async () => {
    const { resetUserReadingData } = await import('./readingDelete.js');
    holder.failOn = 'tx.delete reading_sessions';
    await expect(resetUserReadingData('user-1', 1_800_000_000_000)).rejects.toThrow('injected failure');
    // Gate write landed first; nothing after the failure ran.
    expect(ops).toEqual([
      'transaction',
      'tx.update users',
      'tx.delete reading_sessions',
    ]);
  });

  it('neon-http runs the same gate-first order as sequential statements', async () => {
    holder.driver = 'neon-http';
    const { resetUserReadingData, deleteNovelReadingData } = await import('./readingDelete.js');
    await resetUserReadingData('user-1', 1_800_000_000_000);
    expect(ops).toEqual([
      'update users',
      'delete reading_sessions',
      'delete reading_novels',
      'delete reading_novel_tombstones',
      'delete user_achievement_unlocks',
    ]);
    expect(ops).not.toContain('transaction');

    ops.length = 0;
    holder.failOn = 'delete reading_sessions';
    await expect(deleteNovelReadingData('user-1', '42', 1_800_000_000_000)).rejects.toThrow('injected failure');
    // Tombstone (the gate) landed before the failing delete.
    expect(ops).toEqual([
      'insert reading_novel_tombstones',
      'delete reading_sessions',
    ]);
  });
});
