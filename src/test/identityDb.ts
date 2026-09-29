import { vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { comments, readingSessions, users } from '../database/schema.js';

type Row = typeof users.$inferSelect;

export interface FakeCommentSeed {
  userId: string | null;
  status: string;
  likesCount?: number | null;
}

export interface FakeSessionSeed {
  userId: string;
  seconds: number;
  readDay?: string;
  words?: number;
}

export interface FakeLibrarySeed {
  userId: string;
  /** Soft-deleted rows (non-null) are excluded, mirroring `deleted_at IS NULL`. */
  deletedAt?: number | null;
}

export interface FakeHistorySeed {
  userId: string;
}

export function identityDb() {
  const rows: Row[] = [];
  const commentRows: { userId: string | null; status: string; likesCount: number | null }[] = [];
  const sessionRows: { userId: string; seconds: number; readDay?: string; words?: number }[] = [];
  const libraryRows: { userId: string; deletedAt?: number | null }[] = [];
  const historyRows: { userId: string }[] = [];
  let unavailable = false;
  let failure: unknown = null;
  let nextInsertError: unknown = null;
  const dialect = new PgDialect();
  const USER_COL_KEYS = { google_subject: 'googleSubject', external_id: 'externalId', id: 'id',
    username: 'username', email: 'email', role: 'role' } as Record<string, keyof Row>;
  function matches(row: Row, condition?: SQL) {
    if (!condition) return true;
    const query = dialect.sqlToQuery(condition);
    // Each `"users"."<col>"` maps positionally to the same-index param
    // (drizzle emits $1, $2... in order). A top-level OR (the public user
    // resolver's id/externalId probe) matches when ANY pair hits; otherwise
    // every pair must hit. The resolver's ORDER BY is precedence-only and
    // ignored here — no fixture collides an id with another row's externalId.
    const cols = [...query.sql.matchAll(/"users"\."([a-z_]+)"/g)].map((m) => m[1]);
    const pairs = cols.map((column, i) => {
      const key = USER_COL_KEYS[column ?? ''];
      if (!key) throw new Error('unexpected test query');
      // Real `uuid =` comparison is case-insensitive (input is normalized);
      // `varchar` (external_id) is not. The fake must match each type, or an
      // uppercase UUID probe diverges (0 rows here, 1 row in Postgres).
      const actual = row[key] as unknown;
      const wanted = query.params[i] as unknown;
      if (column === 'id' && typeof actual === 'string' && typeof wanted === 'string') {
        return actual.toLowerCase() === wanted.toLowerCase();
      }
      return actual === wanted;
    });
    if (pairs.length === 0) throw new Error('unexpected test query');
    return /\bor\b/i.test(query.sql) ? pairs.some(Boolean) : pairs.every(Boolean);
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
      if (table === users) {
        // The resolver's OR probe (id/externalId) carries an ORDER BY that
        // ranks an id hit above an externalId-only hit. The fake honors the
        // same precedence so a UUID-shaped externalId can never shadow the
        // real row here either — a silently wrong row would be worse than a
        // loud divergence.
        let matched = rows.filter((r) => matches(r, condition));
        if (condition && /\bor\b/i.test(dialect.sqlToQuery(condition).sql)) {
          const probed = dialect.sqlToQuery(condition);
          const probedCols = [...probed.sql.matchAll(/"users"\."([a-z_]+)"/g)].map((m) => m[1]);
          const idParam = probed.params[probedCols.indexOf('id')];
          matched = [...matched].sort((a, b) => Number(b.id === idParam) - Number(a.id === idParam));
        }
        // The profile routes collapse their aggregates into scalar subqueries
        // over the resolved users row (one round trip). The fake answers the
        // same shape from fixtures: the matched row's id scopes the comment,
        // session, library, and history fixtures. Keys absent from the select
        // are still computed — the route only picks what it named, so extras
        // never leak. No matched row mirrors real Postgres exactly: a SELECT
        // over zero users rows returns zero rows, not one row of zeros.
        if (fields !== null && typeof fields === 'object' && fields !== undefined &&
          ['library', 'history', 'sessions', 'seconds', 'words', 'readDays',
            'commentsCount', 'likesReceived'].some((k) => k in (fields as Record<string, unknown>))) {
          if (matched.length === 0) return [];
          const userId = matched[0].id;
          const mine = commentRows.filter((cm) => cm.userId === userId && cm.status === 'visible');
          const mineSessions = sessionRows.filter((s) => s.userId === userId);
          // DISTINCT days newest-first, capped at 60 — mirrors the route's
          // days subquery (ORDER BY day DESC LIMIT 60).
          const readDays = [...new Set(mineSessions.map((s) => s.readDay).filter((d): d is string => typeof d === 'string' && d.length > 0))]
            .sort().reverse().slice(0, 60);
          return [{
            library: libraryRows.filter((l) => l.userId === userId && l.deletedAt == null).length,
            history: historyRows.filter((h) => h.userId === userId).length,
            sessions: mineSessions.length,
            seconds: mineSessions.reduce((sum, s) => sum + Math.max(0, s.seconds), 0),
            words: mineSessions.reduce((sum, s) => sum + Math.max(0, s.words ?? 0), 0),
            readDays,
            commentsCount: mine.length,
            likesReceived: mine.reduce((sum, cm) => sum + (cm.likesCount ?? 0), 0),
          }];
        }
        return matched;
      }
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
      if (table === readingSessions) {
        // SUM(seconds) for one user; positional params like commentFilter.
        let userId: string | undefined;
        if (condition) {
          const parsed = dialect.sqlToQuery(condition);
          const cols = [...parsed.sql.matchAll(/"reading_sessions"\."([a-z_]+)"/g)].map((m) => m[1]);
          cols.forEach((col, i) => {
            if (col === 'user_id') userId = parsed.params[i] as string;
          });
        }
        const seconds = sessionRows
          .filter((s) => userId === undefined || s.userId === userId)
          .reduce((sum, s) => sum + Math.max(0, s.seconds), 0);
        return [{ seconds }];
      }
      return [];
    };
    const builder = {
      where: (value: SQL) => query(table, value, fields),
      // Honor the cap: the real LIMIT applies before rows are read. The
      // previous ignore-all behavior returned every match, which masked an
      // unbounded read wherever a route relies on `.limit(1)`.
      limit: (n: number) => execute().then((r: any[]) => r.slice(0, n)),
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
  function seedSessions(list: FakeSessionSeed[]) {
    for (const item of list) {
      sessionRows.push({
        userId: item.userId,
        seconds: item.seconds,
        readDay: item.readDay,
        words: item.words ?? 0,
      });
    }
  }
  /** `user_library` fixtures. Omit `deletedAt` for a live row (IS NULL). */
  function seedLibrary(list: FakeLibrarySeed[]) {
    for (const item of list) libraryRows.push({ userId: item.userId, deletedAt: item.deletedAt ?? null });
  }
  /** `reading_history` fixtures. */
  function seedHistory(list: FakeHistorySeed[]) {
    for (const item of list) historyRows.push({ userId: item.userId });
  }
  return {
    rows, commentRows, sessionRows, libraryRows, historyRows,
    seedComments, seedSessions, seedLibrary, seedHistory, db: database,
    isDbAvailable: () => !unavailable, noteDbFailure: vi.fn(),
    unavailable: (value: boolean) => { unavailable = value; },
    fail: (value: unknown) => { failure = value; },
    failNextInsert: (value: unknown) => { nextInsertError = value; },
    reset: () => {
      rows.length = 0; commentRows.length = 0; sessionRows.length = 0;
      libraryRows.length = 0; historyRows.length = 0;
      unavailable = false; failure = null; nextInsertError = null;
      insert.mockClear(); update.mockClear(); database.select.mockClear();
    },
  };
}

export const productionBindings = {
  NODE_ENV: 'production', SYNC_OPEN: 'false', DATABASE_URL: 'postgresql://local:local@localhost/fixture',
  JWT_SECRET: 'fixture-production-signing-key-32-bytes-minimum', GOOGLE_WEB_CLIENT_ID: 'web-client', ADMIN_EMAILS: 'admin@test.com',
};
