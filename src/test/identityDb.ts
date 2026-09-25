import { vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { comments, users } from '../database/schema.js';

type Row = typeof users.$inferSelect;

export interface FakeCommentSeed {
  userId: string | null;
  status: string;
  likesCount?: number | null;
}

export function identityDb() {
  const rows: Row[] = [];
  const commentRows: { userId: string | null; status: string; likesCount: number | null }[] = [];
  let unavailable = false;
  let failure: unknown = null;
  let nextInsertError: unknown = null;
  const dialect = new PgDialect();
  function matches(row: Row, condition?: SQL) {
    if (!condition) return true;
    const query = dialect.sqlToQuery(condition);
    const column = /"users"\."([a-z_]+)"/.exec(query.sql)?.[1];
    const key = ({ google_subject: 'googleSubject', external_id: 'externalId', id: 'id',
      username: 'username', email: 'email', role: 'role' } as Record<string, keyof Row>)[column ?? ''];
    if (!key) throw new Error('unexpected test query');
    return row[key] === query.params[0];
  }
  // Parse a comments WHERE clause generically: each `"comments"."<col>"`
  // maps positionally to the same-index query param (drizzle emits $1, $2... in order).
  function commentFilter(condition?: SQL): { userId?: string | null; status?: string } {
    if (!condition) return {};
    const query = dialect.sqlToQuery(condition);
    const cols = [...query.sql.matchAll(/"comments"\."([a-z_]+)"/g)].map((m) => m[1]);
    const out: { userId?: string | null; status?: string } = {};
    cols.forEach((col, i) => {
      if (col === 'user_id') out.userId = query.params[i] as string | null;
      if (col === 'status') out.status = query.params[i] as string;
    });
    return out;
  }
  function check() { if (failure) throw failure; }
  function query(table: unknown, condition?: SQL, fields?: unknown): any {
    const execute = async () => {
      check();
      // Unmodeled reads answer `[]` (see the insert NOTE): a count/sum over a
      // table with no fixtures is legitimately zero.
      if (table === users) return rows.filter((r) => matches(r, condition));
      if (table === comments) {
        const filter = commentFilter(condition);
        const visible = commentRows.filter((cm) =>
          (filter.userId === undefined || cm.userId === filter.userId) &&
          (filter.status === undefined || cm.status === filter.status));
        if (fields !== null && typeof fields === 'object' && fields !== undefined &&
          ('commentsCount' in (fields as Record<string, unknown>) ||
           'likesReceived' in (fields as Record<string, unknown>))) {
          const commentsCount = visible.length;
          const likesReceived = visible.reduce((sum, cm) => sum + (cm.likesCount ?? 0), 0);
          return [{ commentsCount, likesReceived }];
        }
        return visible;
      }
      return [];
    };
    const builder = {
      where: (value: SQL) => query(table, value, fields),
      limit: (_value: number) => execute(),
      orderBy: (_value: unknown) => builder,
      then: (resolve: (value: any[]) => unknown, reject?: (reason: unknown) => unknown) => execute().then(resolve, reject),
    };
    return builder;
  }
  const insert = vi.fn((table: unknown) => ({ values: (value: Partial<Row> | Partial<Row>[]) => {
    const execute = async () => {
      check();
      if (nextInsertError) { const error = nextInsertError; nextInsertError = null; throw error; }
      // NOTE: this fake models `users` only. A write to any other table is a
      // TEST BUG, not an empty result: a silent `[]` makes "the row was
      // written" indistinguishable from "the table is not modeled here", which
      // quietly weakens every storage assertion downstream. Reads of unmodeled
      // tables DO return `[]` (see query()), because "no rows" is a legitimate
      // answer for a count/sum aggregate on a table with no fixtures.
      if (table !== users) throw new Error('identityDb fake: unexpected insert into an unmodeled table');
      if (Array.isArray(value)) throw new Error('identityDb fake: multi-row users insert is not modeled');
      const row = { id: crypto.randomUUID(), email: null, googleSubject: null, externalId: null,
        username: null, displayName: null, passwordHash: null, avatarUrl: null, bannerUrl: null, bio: null,
        role: 'reader', isAuthor: false, isTranslator: false, createdAt: new Date(), updatedAt: new Date(), ...value } as Row;
      for (const key of ['externalId', 'googleSubject', 'email', 'username'] as const) {
        if (row[key] !== null && rows.some((existing) => existing[key] === row[key])) throw { code: '23505' };
      }
      rows.push(row); return [row];
    };
    // A conflicting insert is "no rows", not a throw: ON CONFLICT DO NOTHING is
    // exactly that. Both chain forms are supported, because drizzle supports
    // both — `.onConflictDoNothing(...)` awaited directly and
    // `.onConflictDoNothing(...).returning()`.
    const conflictTolerant = async () => {
      try { return await execute(); } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        return [];
      }
    };
    return { returning: execute, onConflictDoNothing: () => ({
      returning: execute,
      then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        conflictTolerant().then(resolve, reject),
    }) };
  } }));
  const update = vi.fn((_table: unknown) => ({ set: (patch: Partial<Row>) => ({ where: (condition: SQL) => {
    const execute = async () => {
      check();
      const targets = rows.filter((row) => matches(row, condition));
      for (const target of targets) {
        for (const key of ['email', 'username'] as const) {
          if (patch[key] != null && rows.some((other) => other !== target && other[key] === patch[key])) throw { cause: { code: '23505' } };
        }
      }
      targets.forEach((target) => Object.assign(target, patch)); return targets;
    };
    return { returning: execute, then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) => execute().then(resolve, reject) };
  } }) }));
  const database = { select: vi.fn((fields?: unknown) => ({ from: (table: unknown) => query(table, undefined, fields) })), insert, update };
  function seedComments(list: FakeCommentSeed[]) {
    for (const item of list) {
      commentRows.push({ userId: item.userId, status: item.status, likesCount: item.likesCount ?? 0 });
    }
  }
  return { rows, commentRows, seedComments, db: database, isDbAvailable: () => !unavailable, noteDbFailure: vi.fn(),
    unavailable: (value: boolean) => { unavailable = value; },
    fail: (value: unknown) => { failure = value; },
    failNextInsert: (value: unknown) => { nextInsertError = value; },
    reset: () => { rows.length = 0; commentRows.length = 0; unavailable = false; failure = null; nextInsertError = null;
      insert.mockClear(); update.mockClear(); database.select.mockClear(); },
  };
}

export const productionBindings = {
  NODE_ENV: 'production', SYNC_OPEN: 'false', DATABASE_URL: 'postgresql://local:local@localhost/fixture',
  JWT_SECRET: 'fixture-production-signing-key-32-bytes-minimum', GOOGLE_WEB_CLIENT_ID: 'web-client', ADMIN_EMAILS: 'admin@test.com',
};
