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
    && a.genre === b.genre
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
      && row.genre === session.genre
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
      genre: session.genre,
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
        && row.genre === pushed.genre
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

async function storeLibrary(
  userId: string,
  rows: readonly ReadingSyncLibraryItem[],
  now: number,
  skewMs: number,
): Promise<number> {
  let applied = 0;
  for (const row of rows) {
    const updatedAt = clampTs(row.updatedAt ?? now, now, skewMs);
    const deletedAt = row.deletedAt == null ? null : clampTs(row.deletedAt, now, skewMs);
    const [existing] = await db
      .select()
      .from(userLibrary)
      .where(and(eq(userLibrary.userId, userId), eq(userLibrary.novelId, row.novelId)))
      .limit(1);
    const values = {
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
    if (!existing) {
      await db.insert(userLibrary).values({ userId, novelId: row.novelId, ...values });
      applied++;
    } else if (existing.deletedAt == null && deletedAt != null) {
      await db.update(userLibrary).set(values).where(eq(userLibrary.id, existing.id));
      applied++;
    } else if (existing.deletedAt != null && deletedAt == null) {
      // Tombstone wins regardless of clock.
    } else if (updatedAt > Number(existing.updatedAt ?? 0)) {
      await db.update(userLibrary).set(values).where(eq(userLibrary.id, existing.id));
      applied++;
    }
  }
  return applied;
}

async function storeHistory(
  userId: string,
  rows: readonly ReadingSyncHistoryItem[],
  now: number,
  skewMs: number,
): Promise<number> {
  let applied = 0;
  for (const row of rows) {
    const readAt = clampTs(row.readAt ?? now, now, skewMs);
    const updatedAt = clampTs(row.updatedAt ?? readAt, now, skewMs);
    const [existing] = await db
      .select()
      .from(readingHistory)
      .where(and(
        eq(readingHistory.userId, userId),
        eq(readingHistory.novelId, row.novelId),
        eq(readingHistory.chapterId, row.chapterId),
      ))
      .limit(1);
    const values = {
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
    if (!existing) {
      await db.insert(readingHistory).values({ userId, novelId: row.novelId, chapterId: row.chapterId, ...values });
      applied++;
    } else if (readAt > Number(existing.readAt)
      || (readAt === Number(existing.readAt) && updatedAt > Number(existing.updatedAt))) {
      await db.update(readingHistory).set(values).where(eq(readingHistory.id, existing.id));
      applied++;
    }
  }
  return applied;
}

async function storeChapterStates(
  userId: string,
  rows: readonly ReadingSyncChapterState[],
): Promise<number> {
  let applied = 0;
  for (const row of rows) {
    const [existing] = await db
      .select()
      .from(readingChapterState)
      .where(and(
        eq(readingChapterState.userId, userId),
        eq(readingChapterState.novelId, row.novelId),
        eq(readingChapterState.chapterId, row.chapterId),
      ))
      .limit(1);
    if (!existing) {
      await db.insert(readingChapterState).values({ userId, ...row });
      applied++;
      continue;
    }
    const incomingManual = row.origin === 'manual';
    const existingManual = existing.origin === 'manual';
    if (row.updatedAt < Number(existing.updatedAt)) continue;
    const origin = incomingManual || existingManual ? 'manual' : row.origin;
    if (row.updatedAt === Number(existing.updatedAt) && !row.isRead && existing.isRead) continue;
    await db
      .update(readingChapterState)
      .set({ isRead: row.isRead, origin, updatedAt: row.updatedAt })
      .where(eq(readingChapterState.id, existing.id));
    applied++;
  }
  return applied;
}

async function storeNovels(
  userId: string,
  rows: readonly ReadingSyncNovelMetadata[],
): Promise<number> {
  let applied = 0;
  for (const row of rows) {
    const [existing] = await db
      .select()
      .from(readingNovels)
      .where(and(eq(readingNovels.userId, userId), eq(readingNovels.novelId, row.novelId)))
      .limit(1);
    if (!existing) {
      await db.insert(readingNovels).values({
        userId,
        novelId: row.novelId,
        title: row.title,
        genre: row.genre,
        sourceId: row.sourceId ?? null,
        totalChapters: row.totalChapters ?? null,
        updatedAt: row.updatedAt,
      });
      applied++;
      continue;
    }
    if (row.updatedAt < Number(existing.updatedAt)) continue;
    await db
      .update(readingNovels)
      .set({
        title: row.title || existing.title,
        genre: row.genre || existing.genre,
        sourceId: row.sourceId ?? existing.sourceId,
        totalChapters: row.totalChapters ?? existing.totalChapters ?? null,
        updatedAt: row.updatedAt,
      })
      .where(eq(readingNovels.id, existing.id));
    applied++;
  }
  return applied;
}

export async function storeProPush(
  userId: string,
  payload: ProReadingSyncPush,
  now: number,
  skewMs: number,
): Promise<ProPushWriteResult> {
  const sessions = await storeProSessions(userId, payload.sessions);
  if (sessions.conflictingSessionIds.length > 0) return { ...sessions, collections: { library: 0, history: 0, chapterStates: 0, novels: 0 } };
  const collections = {
    library: await storeLibrary(userId, payload.library ?? [], now, skewMs),
    history: await storeHistory(userId, payload.history ?? [], now, skewMs),
    chapterStates: await storeChapterStates(userId, payload.chapterStates ?? []),
    novels: await storeNovels(userId, payload.novels ?? []),
  };
  return { ...sessions, collections };
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
      genre: row.genre,
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
      genre: row.genre,
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
        genre: row.genre,
        progressPercent: Number(row.progressPercent),
        completed: row.completed,
        ts: Number(row.ts),
      })),
      nextCursor: encodeCursor(last(sessionRows, (row) => Number(row.ts))),
    },
    stats: await loadProStats(userId, { asOfDay, year: query.year }),
  };
}
