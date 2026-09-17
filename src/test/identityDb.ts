import { vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { users } from '../database/schema.js';

type Row = typeof users.$inferSelect;
export function identityDb() {
  const rows: Row[] = [];
  let unavailable = false;
  let failure: unknown = null;
  let nextInsertError: unknown = null;
  const dialect = new PgDialect();
  function matches(row: Row, condition?: SQL) {
    if (!condition) return true;
    const query = dialect.sqlToQuery(condition);
    const column = /"users"\."([a-z_]+)"/.exec(query.sql)?.[1];
    const key = ({ google_subject: 'googleSubject', external_id: 'externalId', id: 'id',
      username: 'username', email: 'email' } as Record<string, keyof Row>)[column ?? ''];
    if (!key) throw new Error('unexpected test query');
    return row[key] === query.params[0];
  }
  function check() { if (failure) throw failure; }
  function query(table: unknown, condition?: SQL): any {
    const execute = async () => { check(); return table === users ? rows.filter((r) => matches(r, condition)) : []; };
    const builder = {
      where: (value: SQL) => query(table, value),
      limit: (_value: number) => execute(),
      orderBy: (_value: unknown) => builder,
      then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) => execute().then(resolve, reject),
    };
    return builder;
  }
  const insert = vi.fn((table: unknown) => ({ values: (value: Partial<Row>) => {
    const execute = async () => {
      check();
      if (nextInsertError) { const error = nextInsertError; nextInsertError = null; throw error; }
      if (table !== users) return [];
      const row = { id: crypto.randomUUID(), email: null, googleSubject: null, externalId: null,
        username: null, displayName: null, passwordHash: null, avatarUrl: null, bannerUrl: null,
        role: 'reader', isAuthor: false, isTranslator: false, createdAt: new Date(), updatedAt: new Date(), ...value } as Row;
      for (const key of ['externalId', 'googleSubject', 'email', 'username'] as const) {
        if (row[key] !== null && rows.some((existing) => existing[key] === row[key])) throw { code: '23505' };
      }
      rows.push(row); return [row];
    };
    return { returning: execute, onConflictDoNothing: async () => {
      try { return await execute(); } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        return [];
      }
    } };
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
  const database = { select: vi.fn(() => ({ from: (table: unknown) => query(table) })), insert, update };
  return { rows, db: database, isDbAvailable: () => !unavailable, noteDbFailure: vi.fn(),
    unavailable: (value: boolean) => { unavailable = value; },
    fail: (value: unknown) => { failure = value; },
    failNextInsert: (value: unknown) => { nextInsertError = value; },
    reset: () => { rows.length = 0; unavailable = false; failure = null; nextInsertError = null;
      insert.mockClear(); update.mockClear(); database.select.mockClear(); },
  };
}

export const productionBindings = {
  NODE_ENV: 'production', SYNC_OPEN: 'false', DATABASE_URL: 'postgresql://local:local@localhost/fixture',
  JWT_SECRET: 'fixture-production-signing-key-32-bytes-minimum', GOOGLE_WEB_CLIENT_ID: 'web-client', ADMIN_EMAILS: 'admin@test.com',
};
