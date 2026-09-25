import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, type SQL } from 'drizzle-orm';
import type { FreeSession } from './contracts.js';

// ==========================================
// Storage-level behavior of the Free session store that the route suite cannot
// observe deterministically: losing an INSERT race against a concurrent push.
//
// The single multi-row insert is what makes this reachable in one statement, so
// the race is simulated at exactly that seam: a hook fires between the
// pre-flight read and the insert, seeding a committed winner for one id. The
// database then refuses that row and the store must classify it from the winner.
// ==========================================

type InsertHook = (rows: StoredRow[]) => void;

const holder = vi.hoisted(() => ({ fake: null as FakeDb | null }));
vi.mock('../../database/db.js', () => ({
  db: new Proxy({}, { get: (_target, key) => (holder.fake!.database as any)[key] }),
}));

interface StoredRow {
  clientSessionId: string;
  novelId: string;
  chapterId: number;
  seconds: number;
  progressPercent: number;
  completed: boolean;
  ts: number;
}

interface FakeDb {
  database: Record<string, unknown>;
  rows: StoredRow[];
  /** Fires once, immediately before the multi-row insert. */
  onBeforeInsert: (hook: InsertHook | null) => void;
  /**
   * Models a refusal the follow-up read cannot resolve: the statement inserts
   * nothing and no winner is visible. Unreachable against a real PostgreSQL
   * (an aborted winner lets ON CONFLICT DO NOTHING proceed with the insert), so
   * it exists to pin the store's fail-closed answer.
   */
  refuseWithoutWinner: boolean;
  insertStatements: number;
  selectStatements: number;
}

function createFakeDb(): FakeDb {
  const rows: StoredRow[] = [];
  const dialect = new PgDialect();
  let insertHook: InsertHook | null = null;
  const state = {
    database: {} as Record<string, unknown>,
    rows,
    onBeforeInsert: (hook: InsertHook | null) => { insertHook = hook; },
    refuseWithoutWinner: false,
    insertStatements: 0,
    selectStatements: 0,
  };

  // The store's read is `user_id = $1 and client_session_id in ($2, $3, ...)`,
  // so params[0] is the user and the rest are the ids, in order.
  const readIds = (condition?: SQL): string[] => {
    const query = dialect.sqlToQuery(condition as SQL);
    return query.params.slice(1).map(String);
  };

  state.database = {
    select: () => ({
      from: (table: unknown) => {
        // Identity is by table name, not by object reference: the store may hold
        // its own module instance of the schema.
        expect(getTableName(table as never)).toBe('reading_sessions');
        const builder: Record<string, unknown> = {
          where: (condition: SQL) => {
            state.selectStatements += 1;
            const ids = new Set(readIds(condition));
            return Promise.resolve(rows.filter((row) => ids.has(row.clientSessionId)));
          },
        };
        return builder;
      },
    }),
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoNothing: () => {
          const run = () => {
            state.insertStatements += 1;
            insertHook?.(rows);
            insertHook = null;
            const pending = values as StoredRow[];
            if (state.refuseWithoutWinner) return Promise.resolve([]);
            // ON CONFLICT DO NOTHING: a row whose id is already stored is not
            // inserted and is not returned.
            const inserted = pending.filter((row) =>
              !rows.some((existing) => existing.clientSessionId === row.clientSessionId));
            rows.push(...inserted);
            return Promise.resolve(inserted);
          };
          return { returning: run, then: run };
        },
      }),
    }),
  };
  return state;
}

const session = (overrides: Partial<FreeSession> = {}): FreeSession => ({
  clientSessionId: 'm-abc123-7',
  novelId: '42',
  chapterId: 7,
  seconds: 83,
  progressPercent: 91,
  completed: true,
  ts: 1782470400000,
  ...overrides,
});

let store: typeof import('./freeStore.js').storeFreeSessions;

beforeEach(async () => {
  holder.fake = createFakeDb();
  ({ storeFreeSessions: store } = await import('./freeStore.js'));
});
afterEach(() => { holder.fake = null; });
const fake = () => holder.fake!;

describe('Free session insert races', () => {
  it('writes the whole pending batch in one statement and one follow-up read', async () => {
    const result = await store('user-1', [
      session({ clientSessionId: 'm-a' }),
      session({ clientSessionId: 'm-b' }),
      session({ clientSessionId: 'm-c' }),
    ]);
    expect(result).toEqual({
      applied: 3,
      acceptedSessionIds: ['m-a', 'm-b', 'm-c'],
      conflictingSessionIds: [],
    });
    // The regression this pins: the per-row writer issued one statement per
    // row, so a 500-row push cost 500 round trips (and 500 race windows).
    expect(fake().insertStatements).toBe(1);
    expect(fake().selectStatements).toBe(1);
  });

  it('skips the write entirely when every id is already stored', async () => {
    await store('user-1', [session({ clientSessionId: 'm-a' })]);
    const retry = await store('user-1', [session({ clientSessionId: 'm-a' })]);
    expect(retry).toEqual({ applied: 0, acceptedSessionIds: ['m-a'], conflictingSessionIds: [] });
    expect(fake().insertStatements).toBe(1);
    expect(fake().rows).toHaveLength(1);
  });

  it('acknowledges a duplicate winner of a lost race without overwriting it', async () => {
    const identical = session({ clientSessionId: 'm-race' });
    fake().onBeforeInsert((rows) => { rows.push({ ...identical }); });
    const result = await store('user-1', [identical]);
    expect(result).toEqual({
      applied: 0,
      acceptedSessionIds: ['m-race'],
      conflictingSessionIds: [],
    });
    expect(fake().rows).toEqual([identical]);
  });

  it('reports a differing winner of a lost race as a conflict and keeps its row', async () => {
    const pushed = session({ clientSessionId: 'm-race', seconds: 83 });
    const winner = { ...pushed, seconds: 120 };
    fake().onBeforeInsert((rows) => { rows.push(winner); });
    const result = await store('user-1', [pushed]);
    expect(result).toEqual({
      applied: 0,
      acceptedSessionIds: [],
      conflictingSessionIds: ['m-race'],
    });
    // No overwrite: the winner stays exactly as the concurrent push stored it.
    expect(fake().rows).toEqual([winner]);
    // One insert plus ONE bounded read for every refused id — not one read per row.
    expect(fake().insertStatements).toBe(1);
    expect(fake().selectStatements).toBe(2);
  });

  // A mid-batch race is the only case where a 409 can be truthful about
  // accepted ids: the rows the statement DID create are immutable valid events,
  // so the client must be able to drop them from its outbox.
  it('reports the ids it did create alongside the raced conflict', async () => {
    const raced = session({ clientSessionId: 'm-raced' });
    fake().onBeforeInsert((rows) => { rows.push({ ...raced, chapterId: 99 }); });
    const result = await store('user-1', [
      session({ clientSessionId: 'm-first' }),
      raced,
      session({ clientSessionId: 'm-last' }),
    ]);
    expect(result.applied).toBe(2);
    expect(result.conflictingSessionIds).toEqual(['m-raced']);
    expect(result.acceptedSessionIds).toEqual(['m-first', 'm-last']);
    // Only the raced id has a row beyond the two this request created.
    expect(fake().rows.map((row) => row.clientSessionId).sort())
      .toEqual(['m-first', 'm-last', 'm-raced']);
  });

  it('never acknowledges an id the database refused and the read cannot resolve', async () => {
    // A refused row with no visible winner is unverified: it must be reported,
    // because a client that drops the id would lose the event entirely.
    fake().refuseWithoutWinner = true;
    const result = await store('user-1', [session({ clientSessionId: 'm-vanished' })]);
    expect(result).toEqual({
      applied: 0,
      acceptedSessionIds: [],
      conflictingSessionIds: ['m-vanished'],
    });
    // Still cheap: one insert, one classification read.
    expect(fake().insertStatements).toBe(1);
    expect(fake().selectStatements).toBe(2);
  });

  it('refuses a self-contradictory batch before touching storage', async () => {
    const result = await store('user-1', [
      session({ clientSessionId: 'm-dup', seconds: 10 }),
      session({ clientSessionId: 'm-dup', seconds: 20 }),
    ]);
    expect(result.conflictingSessionIds).toEqual(['m-dup']);
    expect(fake().insertStatements).toBe(0);
    expect(fake().selectStatements).toBe(0);
    expect(fake().rows).toHaveLength(0);
  });
});
