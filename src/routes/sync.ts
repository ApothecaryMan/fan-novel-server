import { Hono, type Context } from 'hono';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../database/db.js';
import { users, userLibrary, readingHistory, readingSessions } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';

export const syncRouter = new Hono();

// ==========================================
// Delta sync for offline-first clients.
// Ordering authority = CLIENT edit-time clocks (updated_at/read_at/deleted_at,
// UTC epoch ms). received_at is audit/GC only and is never compared.
// Tombstone beats live regardless of clock; else larger updatedAt wins;
// ties union category_ids. Sessions are append-only + idempotent.
// Auth: SYNC_OPEN=false requires Bearer JWT; default true auto-provisions
// the user by external_id (LAN-first threat model).
// ==========================================

export const CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const clampTs = (ts: number, now: number): number =>
  ts > now + CLIENT_CLOCK_SKEW_MS ? now : ts;

const unionStrings = (a: string[], b: string[]): string[] => {
  const seen = new Set<string>();
  return [...a, ...b].map(String).filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
};

async function provisionUser(externalId: string, email?: string, name?: string) {
  const cleanEmail = (email || '').trim().toLowerCase() || null;
  const cleanName = (name || '').slice(0, 100) || null;
  await db
    .insert(users)
    .values({
      externalId,
      email: cleanEmail,
      username: `user_${externalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'x'}`,
      avatarUrl: null
    })
    .onConflictDoNothing({ target: users.externalId });
  const row = await db.select().from(users).where(eq(users.externalId, externalId)).then((r) => r[0]);
  if (!row) throw new Error('user provision failed');
  if ((cleanEmail && row.email !== cleanEmail) || (cleanName && !row.avatarUrl)) {
    await db
      .update(users)
      .set({ email: cleanEmail ?? row.email, updatedAt: new Date() })
      .where(eq(users.id, row.id));
  }
  void cleanName;
  return row;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strDef = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const dateOrNull = (v: unknown): Date | null => {
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

// POST /api/v1/sync/push
syncRouter.post('/push', async (c) => {
  if (process.env.SYNC_OPEN === 'false') {
    const gate = await requireAuthFetch(c);
    if (gate) return gate;
  }
  const body = await c.req.json().catch(() => null);
  const externalId = typeof body?.user?.externalId === 'string' ? body.user.externalId : '';
  if (!externalId) return c.json({ error: 'user.externalId is required' }, 400);
  const now = Date.now();
  const user = await provisionUser(externalId, body.user?.email, body.user?.name);

  let appliedLibrary = 0;
  for (const e of Array.isArray(body.library) ? body.library : []) {
    const novelId = String(e.novelId ?? '');
    if (!novelId) continue;
    const updatedAt = clampTs(num(e.updatedAt, now), now);
    const deletedAt = e.deletedAt == null ? null : clampTs(num(e.deletedAt), now);
    const existing = await db
      .select()
      .from(userLibrary)
      .where(and(eq(userLibrary.userId, user.id), eq(userLibrary.novelId, novelId)))
      .then((r) => r[0]);
    const values = {
      userId: user.id,
      novelId,
      sourceId: str(e.sourceId),
      categoryIds: Array.isArray(e.categoryIds) ? e.categoryIds.map(String) : [],
      lastReadChapterId: e.lastReadChapterId == null ? null : num(e.lastReadChapterId),
      lastReadChapterNumber: e.lastReadChapterNumber == null ? null : num(e.lastReadChapterNumber),
      lastReadChapterTitle: str(e.lastReadChapterTitle),
      progressPercent: num(e.progressPercent),
      lastReadAt: dateOrNull(e.lastReadAt),
      addedAt: dateOrNull(e.addedAt) ?? new Date(),
      updatedAt,
      deletedAt
    };
    if (!existing) {
      await db.insert(userLibrary).values(values);
      appliedLibrary++;
      continue;
    }
    const oldTomb = existing.deletedAt != null;
    const newTomb = deletedAt != null;
    if (oldTomb !== newTomb) {
      if (!newTomb) continue; // tombstone wins: live incoming loses to stored delete
      await db.update(userLibrary).set(values).where(eq(userLibrary.id, existing.id));
      appliedLibrary++;
    } else if (updatedAt > (existing.updatedAt ?? 0)) {
      await db.update(userLibrary).set(values).where(eq(userLibrary.id, existing.id));
      appliedLibrary++;
    } else if (updatedAt === (existing.updatedAt ?? 0) && !newTomb) {
      const merged = unionStrings(existing.categoryIds ?? [], values.categoryIds);
      if (merged.length !== (existing.categoryIds ?? []).length) {
        await db.update(userLibrary).set({ categoryIds: merged }).where(eq(userLibrary.id, existing.id));
        appliedLibrary++;
      }
    }
  }

  let appliedHistory = 0;
  for (const e of Array.isArray(body.history) ? body.history : []) {
    const novelId = String(e.novelId ?? '');
    const chapterId = num(e.chapterId, -1);
    if (!novelId || chapterId < 0) continue;
    const readAt = clampTs(num(e.readAt, now), now);
    const updatedAt = clampTs(num(e.updatedAt, readAt), now);
    const existing = await db
      .select()
      .from(readingHistory)
      .where(
        and(
          eq(readingHistory.userId, user.id),
          eq(readingHistory.novelId, novelId),
          eq(readingHistory.chapterId, chapterId)
        )
      )
      .then((r) => r[0]);
    if (!existing || readAt > (existing.readAt ?? 0) || (readAt === (existing.readAt ?? 0) && updatedAt > (existing.updatedAt ?? 0))) {
      const values = {
        userId: user.id,
        novelId,
        novelTitle: strDef(e.novelTitle),
        novelCover: strDef(e.novelCover),
        novelAuthor: strDef(e.novelAuthor),
        category: strDef(e.category),
        sourceId: str(e.sourceId),
        chapterId,
        chapterNumber: num(e.chapterNumber),
        chapterTitle: strDef(e.chapterTitle),
        progressPercent: num(e.progressPercent),
        readDay: strDef(e.readDay),
        readAt,
        updatedAt
      };
      if (!existing) await db.insert(readingHistory).values(values);
      else await db.update(readingHistory).set(values).where(eq(readingHistory.id, existing.id));
      appliedHistory++;
    }
  }

  let appliedSessions = 0;
  for (const e of Array.isArray(body.sessions) ? body.sessions : []) {
    const key = typeof e.clientSessionId === 'string' ? e.clientSessionId : '';
    if (!key) continue;
    const r = await db
      .insert(readingSessions)
      .values({
        userId: user.id,
        clientSessionId: key,
        novelId: String(e.novelId ?? ''),
        chapterId: num(e.chapterId),
        seconds: num(e.seconds),
        words: num(e.words),
        minuteOfDay: num(e.minuteOfDay),
        readDay: strDef(e.readDay),
        genre: strDef(e.genre),
        ts: num(e.ts, now)
      })
      .onConflictDoNothing({ target: [readingSessions.userId, readingSessions.clientSessionId] })
      .returning({ id: readingSessions.id });
    if (r.length > 0) appliedSessions++;
  }

  return c.json({ success: true, applied: { library: appliedLibrary, history: appliedHistory, sessions: appliedSessions }, serverNow: now });
});

// POST /api/v1/sync/pull
syncRouter.post('/pull', async (c) => {
  if (process.env.SYNC_OPEN === 'false') {
    const gate = await requireAuthFetch(c);
    if (gate) return gate;
  }
  const body = await c.req.json().catch(() => null);
  const externalId = typeof body?.user?.externalId === 'string' ? body.user.externalId : '';
  if (!externalId) return c.json({ error: 'user.externalId is required' }, 400);
  const since = num(body?.since, 0);
  const user = await provisionUser(externalId, body.user?.email, body.user?.name);

  const library = await db
    .select()
    .from(userLibrary)
    .where(and(eq(userLibrary.userId, user.id), gt(userLibrary.updatedAt, since)))
    .orderBy(userLibrary.updatedAt)
    .limit(5000);
  const history = await db
    .select()
    .from(readingHistory)
    .where(and(eq(readingHistory.userId, user.id), gt(readingHistory.updatedAt, since)))
    .orderBy(readingHistory.updatedAt)
    .limit(5000);
  const sessions = await db
    .select()
    .from(readingSessions)
    .where(and(eq(readingSessions.userId, user.id), gt(readingSessions.ts, since)))
    .orderBy(readingSessions.ts)
    .limit(5000);

  return c.json({
    success: true,
    serverNow: Date.now(),
    library: library.map((r) => ({
      novelId: r.novelId,
      sourceId: r.sourceId,
      categoryIds: r.categoryIds,
      lastReadChapterId: r.lastReadChapterId,
      lastReadChapterNumber: r.lastReadChapterNumber,
      lastReadChapterTitle: r.lastReadChapterTitle,
      progressPercent: r.progressPercent,
      lastReadAt: r.lastReadAt?.toISOString() ?? null,
      addedAt: r.addedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt
    })),
    history: history.map((r) => ({
      novelId: r.novelId,
      novelTitle: r.novelTitle,
      novelCover: r.novelCover,
      novelAuthor: r.novelAuthor,
      category: r.category,
      sourceId: r.sourceId,
      chapterId: r.chapterId,
      chapterNumber: r.chapterNumber,
      chapterTitle: r.chapterTitle,
      progressPercent: r.progressPercent,
      readDay: r.readDay,
      readAt: r.readAt,
      updatedAt: r.updatedAt
    })),
    sessions: sessions.map((r) => ({
      clientSessionId: r.clientSessionId,
      novelId: r.novelId,
      chapterId: r.chapterId,
      seconds: r.seconds,
      words: r.words,
      minuteOfDay: r.minuteOfDay,
      readDay: r.readDay,
      genre: r.genre,
      ts: r.ts
    }))
  });
});

// GET /api/v1/sync/stats — row counts per user (debug/status UI).
syncRouter.post('/stats', async (c) => {
  const body = await c.req.json().catch(() => null);
  const externalId = typeof body?.user?.externalId === 'string' ? body.user.externalId : '';
  if (!externalId) return c.json({ error: 'user.externalId is required' }, 400);
  const user = await provisionUser(externalId);
  const lib = await db.select({ id: userLibrary.id }).from(userLibrary).where(eq(userLibrary.userId, user.id));
  const hist = await db.select({ id: readingHistory.id }).from(readingHistory).where(eq(readingHistory.userId, user.id));
  const sess = await db.select({ id: readingSessions.id }).from(readingSessions).where(eq(readingSessions.userId, user.id));
  return c.json({ success: true, library: lib.length, history: hist.length, sessions: sess.length, serverNow: Date.now() });
});

// Optional gate: with SYNC_OPEN=false the caller must present a valid Bearer
// JWT (mobile userAccount.token). Returns a rejection Response, else null.
async function requireAuthFetch(c: Context): Promise<Response | null> {
  let nextCalled = false;
  const out = await requireAuth(c, async () => {
    nextCalled = true;
  });
  if (nextCalled) return null;
  return out ?? c.json({ error: 'unauthorized' }, 401);
}
