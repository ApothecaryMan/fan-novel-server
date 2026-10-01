import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../database/db.js';
import {
  readingChapterState,
  readingHistory,
  readingNovels,
  readingSessions,
  userLibrary,
} from '../../database/schema.js';
import { calculateProStats } from './calculations.js';
import type {
  ProReadingSyncPullResponse,
  ProReadingSyncPush,
  ProSession,
  ProStats,
} from './contracts.js';
import {
  MAX_COLLECTION_ROWS,
  type ReadingSyncChapterState,
  type ReadingSyncHistoryItem,
  type ReadingSyncLibraryItem,
  type ReadingSyncNovelMetadata,
} from './contracts.js';

const PROGRESS_EPSILON = 1e-4;

export interface ProSessionWriteResult {
  applied: number;
  acceptedSessionIds: string[];
  conflictingSessionIds: string[];
}

export interface ProCollectionCounts {
  library: number;
  history: number;
  chapterStates: number;
  novels: number;
}

export interface ProPushWriteResult extends ProSessionWriteResult {
  collections: ProCollectionCounts;
}

const clampTs = (value: number, now: number, skewMs: number): number =>
  value > now + skewMs ? now : value;

const nonEmpty = (value: string | null | undefined, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

function sameProSession(a: ProSession, b: ProSession): boolean {
  return a.novelId === b.novelId
    && a.chapterId === b.chapterId
    && a.seconds === b.seconds
    && a.words === b.words
    && a.minuteOfDay === b.minuteOfDay
    && a.readDay === b.readDay
    && Math.abs(a.progressPercent - b.progressPercent) <= PROGRESS_EPSILON
    && a.completed === b.completed
    && a.ts === b.ts;
}

async function storedProSessions(userId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(readingSessions)
    .where(and(eq(readingSessions.userId, userId), inArray(readingSessions.clientSessionId, [...ids])));
}

export async function storeProSessions(
  userId: string,
  sessions: readonly ProSession[],
): Promise<ProSessionWriteResult> {
  const first = new Map<string, ProSession>();
  const inconsistent = new Set<string>();
  for (const session of sessions) {
    const previous = first.get(session.clientSessionId);
    if (!previous) first.set(session.clientSessionId, session);
    else if (!sameProSession(previous, session)) inconsistent.add(session.clientSessionId);
  }
  if (inconsistent.size > 0) {
    return { applied: 0, acceptedSessionIds: [], conflictingSessionIds: [...inconsistent] };
  }
  const unique = [...first.values()];
  if (unique.length === 0) return { applied: 0, acceptedSessionIds: [], conflictingSessionIds: [] };

  const stored = await storedProSessions(userId, unique.map((s) => s.clientSessionId));
  const storedById = new Map(stored.map((row) => [row.clientSessionId, row]));
  const pending: ProSession[] = [];
  const accepted: string[] = [];
  const conflicts: string[] = [];
  for (const session of unique) {
    const row = storedById.get(session.clientSessionId);
    if (!row) { pending.push(session); continue; }
    const same = row.novelId === session.novelId
      && Number(row.chapterId) === session.chapterId
      && Number(row.seconds) === session.seconds
      && Number(row.words) === session.words
      && Number(row.minuteOfDay) === session.minuteOfDay
      && row.readDay === session.readDay
      && Math.abs(Number(row.progressPercent) - session.progressPercent) <= PROGRESS_EPSILON
      && row.completed === session.completed
      && Number(row.ts) === session.ts;
    (same ? accepted : conflicts).push(session.clientSessionId);
  }
  if (conflicts.length > 0) return { applied: 0, acceptedSessionIds: [], conflictingSessionIds: conflicts };
  if (pending.length === 0) return { applied: 0, acceptedSessionIds: accepted, conflictingSessionIds: [] };

  const inserted = await db
    .insert(readingSessions)
    .values(pending.map((session) => ({
      userId,
      clientSessionId: session.clientSessionId,
      novelId: session.novelId,
      chapterId: session.chapterId,
      progressPercent: session.progressPercent,
      completed: session.completed,
      completionSignalPresent: true,
      proFieldsPresent: true,
      seconds: session.seconds,
      words: session.words,
      minuteOfDay: session.minuteOfDay,
      readDay: session.readDay,
      ts: session.ts,
    })))
    .onConflictDoNothing({ target: [readingSessions.userId, readingSessions.clientSessionId] })
    .returning();
  const insertedIds = new Set(inserted.map((row) => row.clientSessionId));
  const raced = pending.filter((s) => !insertedIds.has(s.clientSessionId)).map((s) => s.clientSessionId);
  if (raced.length > 0) {
    const winners = await storedProSessions(userId, raced);
    const byId = new Map(pending.map((s) => [s.clientSessionId, s]));
    for (const row of winners) {
      const pushed = byId.get(row.clientSessionId);
      if (!pushed) { conflicts.push(row.clientSessionId); continue; }
      const same = row.novelId === pushed.novelId
        && Number(row.chapterId) === pushed.chapterId
        && Number(row.seconds) === pushed.seconds
        && Number(row.words) === pushed.words
        && Number(row.minuteOfDay) === pushed.minuteOfDay
        && row.readDay === pushed.readDay
        && Math.abs(Number(row.progressPercent) - pushed.progressPercent) <= PROGRESS_EPSILON
        && row.completed === pushed.completed
        && Number(row.ts) === pushed.ts;
      (same ? accepted : conflicts).push(row.clientSessionId);
    }
    for (const id of raced) {
      if (!winners.some((row) => row.clientSessionId === id)) conflicts.push(id);
    }
  }
  if (conflicts.length > 0) {
    return { applied: insertedIds.size, acceptedSessionIds: accepted, conflictingSessionIds: conflicts };
  }
  return {
    applied: insertedIds.size,
    acceptedSessionIds: [...accepted, ...insertedIds],
    conflictingSessionIds: [],
  };
}

/**
 * Dedupe a batch by its conflict key.
 *
 * Postgres refuses to affect the same row twice in one `ON CONFLICT DO UPDATE`
 * statement, so a repeated key would abort the whole push. Last write wins,
 * matching the coalesced outbox that produced the batch.
 */
function dedupeBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

async function storeLibrary(
  userId: string,
  rows: readonly ReadingSyncLibraryItem[],
  now: number,
  skewMs: number,
): Promise<number> {
  const unique = dedupeBy(rows, (row) => row.novelId);
  if (unique.length === 0) return 0;

  const values = unique.map((row) => {
    const updatedAt = clampTs(row.updatedAt ?? now, now, skewMs);
    const deletedAt = row.deletedAt == null ? null : clampTs(row.deletedAt, now, skewMs);
    return {
      userId,
      novelId: row.novelId,
      sourceId: row.sourceId ?? null,
      categoryIds: row.categoryIds ?? [],
      lastReadChapterId: row.lastReadChapterId ?? null,
      lastReadChapterNumber: row.lastReadChapterNumber ?? null,
      lastReadChapterTitle: row.lastReadChapterTitle ?? null,
      progressPercent: row.progressPercent ?? 0,
      lastReadAt: row.lastReadAt ? new Date(row.lastReadAt) : null,
      addedAt: row.addedAt ? new Date(row.addedAt) : new Date(now),
      updatedAt,
      deletedAt,
    };
  });

  // A tombstone beats a live row whatever the clock says; otherwise the newer
  // write wins. One statement for the whole batch, and RETURNING reports only
  // the rows actually inserted or updated.
  const result = await db
    .insert(userLibrary)
    .values(values)
    .onConflictDoUpdate({
      target: [userLibrary.userId, userLibrary.novelId],
      set: {
        sourceId: sql`excluded.source_id`,
        categoryIds: sql`excluded.category_ids`,
        lastReadChapterId: sql`excluded.last_read_chapter_id`,
        lastReadChapterNumber: sql`excluded.last_read_chapter_number`,
        lastReadChapterTitle: sql`excluded.last_read_chapter_title`,
        progressPercent: sql`excluded.progress_percent`,
        lastReadAt: sql`excluded.last_read_at`,
        addedAt: sql`excluded.added_at`,
        updatedAt: sql`excluded.updated_at`,
        deletedAt: sql`excluded.deleted_at`,
      },
      setWhere: sql`(excluded.deleted_at IS NOT NULL AND ${userLibrary.deletedAt} IS NULL)
        OR (excluded.updated_at > ${userLibrary.updatedAt}
            AND (excluded.deleted_at IS NOT NULL OR ${userLibrary.deletedAt} IS NULL))`,
    });
  return result.rowCount ?? 0;
}

async function storeHistory(
  userId: string,
  rows: readonly ReadingSyncHistoryItem[],
  now: number,
  skewMs: number,
): Promise<number> {
  const unique = dedupeBy(rows, (row) => `${row.novelId}\u0000${row.chapterId}`);
  if (unique.length === 0) return 0;

  const values = unique.map((row) => {
    const readAt = clampTs(row.readAt ?? now, now, skewMs);
    const updatedAt = clampTs(row.updatedAt ?? readAt, now, skewMs);
    return {
      userId,
      novelId: row.novelId,
      chapterId: row.chapterId,
      novelTitle: nonEmpty(row.novelTitle),
      novelCover: '',
      novelAuthor: nonEmpty(row.novelAuthor),
      category: nonEmpty(row.category),
      sourceId: row.sourceId ?? null,
      chapterNumber: row.chapterNumber ?? 0,
      chapterTitle: nonEmpty(row.chapterTitle),
      progressPercent: row.progressPercent ?? 0,
      readDay: row.readDay ?? new Date(readAt).toISOString().slice(0, 10),
      readAt,
      updatedAt,
    };
  });

  const result = await db
    .insert(readingHistory)
    .values(values)
    .onConflictDoUpdate({
      target: [readingHistory.userId, readingHistory.novelId, readingHistory.chapterId],
      set: {
        novelTitle: sql`excluded.novel_title`,
        novelCover: sql`excluded.novel_cover`,
        novelAuthor: sql`excluded.novel_author`,
        category: sql`excluded.category`,
        sourceId: sql`excluded.source_id`,
        chapterNumber: sql`excluded.chapter_number`,
        chapterTitle: sql`excluded.chapter_title`,
        progressPercent: sql`excluded.progress_percent`,
        readDay: sql`excluded.read_day`,
        readAt: sql`excluded.read_at`,
        updatedAt: sql`excluded.updated_at`,
      },
      // Later read wins; a tie falls back to the edit clock.
      setWhere: sql`excluded.read_at > ${readingHistory.readAt}
        OR (excluded.read_at = ${readingHistory.readAt}
            AND excluded.updated_at > ${readingHistory.updatedAt})`,
    });
  return result.rowCount ?? 0;
}

async function storeChapterStates(
  userId: string,
  rows: readonly ReadingSyncChapterState[],
): Promise<number> {
  const unique = dedupeBy(rows, (row) => `${row.novelId}\u0000${row.chapterId}`);
  if (unique.length === 0) return 0;

  const result = await db
    .insert(readingChapterState)
    .values(unique.map((row) => ({ userId, ...row })))
    .onConflictDoUpdate({
      target: [
        readingChapterState.userId,
        readingChapterState.novelId,
        readingChapterState.chapterId,
      ],
      set: {
        isRead: sql`excluded.is_read`,
        // A manual mark is sticky: once manual, always manual.
        origin: sql`CASE WHEN excluded.origin = 'manual' OR ${readingChapterState.origin} = 'manual'
          THEN 'manual' ELSE excluded.origin END`,
        updatedAt: sql`excluded.updated_at`,
      },
      // Newer wins. On an exact tie the read flag may only rise, never fall.
      setWhere: sql`excluded.updated_at > ${readingChapterState.updatedAt}
        OR (excluded.updated_at = ${readingChapterState.updatedAt}
            AND (excluded.is_read OR NOT ${readingChapterState.isRead}))`,
    });
  return result.rowCount ?? 0;
}

async function storeNovels(
  userId: string,
  rows: readonly ReadingSyncNovelMetadata[],
): Promise<number> {
  const unique = dedupeBy(rows, (row) => row.novelId);
  if (unique.length === 0) return 0;

  const result = await db
    .insert(readingNovels)
    .values(unique.map((row) => ({
      userId,
      novelId: row.novelId,
      title: row.title,
      genre: row.genre,
      sourceId: row.sourceId ?? null,
      totalChapters: row.totalChapters ?? null,
      updatedAt: row.updatedAt,
    })))
    .onConflictDoUpdate({
      target: [readingNovels.userId, readingNovels.novelId],
      set: {
        // An empty incoming label never blanks a known one.
        title: sql`COALESCE(NULLIF(excluded.title, ''), ${readingNovels.title})`,
        genre: sql`COALESCE(NULLIF(excluded.genre, ''), ${readingNovels.genre})`,
        sourceId: sql`COALESCE(excluded.source_id, ${readingNovels.sourceId})`,
        totalChapters: sql`COALESCE(excluded.total_chapters, ${readingNovels.totalChapters})`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`excluded.updated_at >= ${readingNovels.updatedAt}`,
    });
  return result.rowCount ?? 0;
}

export async function storeProPush(
  userId: string,
  payload: ProReadingSyncPush,
  now: number,
  skewMs: number,
): Promise<ProPushWriteResult> {
  const sessions = await storeProSessions(userId, payload.sessions);
  if (sessions.conflictingSessionIds.length > 0) return { ...sessions, collections: { library: 0, history: 0, chapterStates: 0, novels: 0 } };
  // The four collections are independent tables, so they overlap rather than
  // queueing: four sequential HTTPS round trips to Neon become one.
  const [library, history, chapterStates, novels] = await Promise.all([
    storeLibrary(userId, payload.library ?? [], now, skewMs),
    storeHistory(userId, payload.history ?? [], now, skewMs),
    storeChapterStates(userId, payload.chapterStates ?? []),
    storeNovels(userId, payload.novels ?? []),
  ]);
  return { ...sessions, collections: { library, history, chapterStates, novels } };
}

export async function loadProStats(
  userId: string,
  options?: { asOfDay?: string; year?: number },
): Promise<ProStats> {
  const [sessionRows, stateRows, novelRows] = await Promise.all([
    db.select().from(readingSessions).where(eq(readingSessions.userId, userId)),
    db.select().from(readingChapterState).where(eq(readingChapterState.userId, userId)),
    db.select().from(readingNovels).where(eq(readingNovels.userId, userId)),
  ]);
  return calculateProStats({
    sessions: sessionRows.map((row) => ({
      novelId: row.novelId,
      chapterId: Number(row.chapterId),
      seconds: Number(row.seconds),
      words: Number(row.words),
      minuteOfDay: Number(row.minuteOfDay),
      readDay: row.readDay,
      ts: Number(row.ts),
      progressPercent: Number(row.progressPercent),
      completed: row.completed,
      completionSignalPresent: row.completionSignalPresent,
      proFieldsPresent: row.proFieldsPresent,
    })),
    chapterStates: stateRows.map((row) => ({
      novelId: row.novelId,
      chapterId: Number(row.chapterId),
      isRead: row.isRead,
      updatedAt: Number(row.updatedAt),
    })),
    novels: novelRows.map((row) => ({
      novelId: row.novelId,
      title: row.title,
      sourceId: row.sourceId,
      totalChapters: row.totalChapters,
      updatedAt: Number(row.updatedAt),
    })),
    asOfDay: options?.asOfDay,
    year: options?.year,
  });
}

type Cursor = { ts: number; id: number };

function encodeCursor(value: Cursor | null): string | null {
  return value == null ? null : Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    return Number.isSafeInteger(parsed.ts) && Number.isSafeInteger(parsed.id) ? parsed : null;
  } catch { return null; }
}

export async function pullProData(
  userId: string,
  query: { libraryCursor: string | null; historyCursor: string | null; sessionCursor: string | null; year: number },
  asOfDay?: string,
): Promise<ProReadingSyncPullResponse> {
  const limit = MAX_COLLECTION_ROWS;
  const libraryCursor = decodeCursor(query.libraryCursor);
  const historyCursor = decodeCursor(query.historyCursor);
  const sessionCursor = decodeCursor(query.sessionCursor);
  const [libraryRows, historyRows, sessionRows] = await Promise.all([
    db.select().from(userLibrary).where(and(
      eq(userLibrary.userId, userId),
      libraryCursor ? or(gt(userLibrary.updatedAt, libraryCursor.ts), sql`${userLibrary.updatedAt} = ${libraryCursor.ts} AND ${userLibrary.id} > ${libraryCursor.id}`) : undefined,
    )).orderBy(asc(userLibrary.updatedAt), asc(userLibrary.id)).limit(limit),
    db.select().from(readingHistory).where(and(
      eq(readingHistory.userId, userId),
      historyCursor ? or(gt(readingHistory.readAt, historyCursor.ts), sql`${readingHistory.readAt} = ${historyCursor.ts} AND ${readingHistory.id} > ${historyCursor.id}`) : undefined,
    )).orderBy(asc(readingHistory.readAt), asc(readingHistory.id)).limit(limit),
    db.select().from(readingSessions).where(and(
      eq(readingSessions.userId, userId),
      sessionCursor ? or(gt(readingSessions.ts, sessionCursor.ts), sql`${readingSessions.ts} = ${sessionCursor.ts} AND ${readingSessions.id} > ${sessionCursor.id}`) : undefined,
    )).orderBy(asc(readingSessions.ts), asc(readingSessions.id)).limit(limit),
  ]);
  const last = <T extends { id: number }>(rows: T[], clock: (row: T) => number) => {
    if (rows.length < limit) return null;
    const row = rows[rows.length - 1];
    return { ts: clock(row), id: Number(row.id) };
  };
  return {
    success: true,
    plan: 'pro',
    library: {
      rows: libraryRows.map((row) => ({
        novelId: row.novelId,
        sourceId: row.sourceId,
        categoryIds: row.categoryIds,
        lastReadChapterId: row.lastReadChapterId,
        lastReadChapterNumber: row.lastReadChapterNumber,
        lastReadChapterTitle: row.lastReadChapterTitle,
        progressPercent: row.progressPercent,
        lastReadAt: row.lastReadAt?.toISOString() ?? null,
        addedAt: row.addedAt?.toISOString() ?? null,
        updatedAt: Number(row.updatedAt),
        deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
      })),
      nextCursor: encodeCursor(last(libraryRows, (row) => Number(row.updatedAt))),
    },
    history: {
      rows: historyRows.map((row) => ({
        novelId: row.novelId,
        novelTitle: row.novelTitle,
        novelAuthor: row.novelAuthor,
        category: row.category,
        sourceId: row.sourceId,
        chapterId: Number(row.chapterId),
        chapterNumber: Number(row.chapterNumber),
        chapterTitle: row.chapterTitle,
        progressPercent: row.progressPercent,
        readDay: row.readDay,
        readAt: Number(row.readAt),
        updatedAt: Number(row.updatedAt),
      })),
      nextCursor: encodeCursor(last(historyRows, (row) => Number(row.readAt))),
    },
    sessions: {
      rows: sessionRows.map((row) => ({
        clientSessionId: row.clientSessionId,
        novelId: row.novelId,
        chapterId: Number(row.chapterId),
        seconds: Number(row.seconds),
        words: Number(row.words),
        minuteOfDay: Number(row.minuteOfDay),
        readDay: row.readDay,
        progressPercent: Number(row.progressPercent),
        completed: row.completed,
        ts: Number(row.ts),
      })),
      nextCursor: encodeCursor(last(sessionRows, (row) => Number(row.ts))),
    },
    stats: await loadProStats(userId, { asOfDay, year: query.year }),
  };
}
