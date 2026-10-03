import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, gte, lte, asc, inArray, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { chapters, novels } from '../database/schema.js';
import { NOVELS_STORE, type NovelData } from './novels.js';
import { requireAuthOrPat } from '../middleware/authorToken.js';
import { ensureNovelOwner } from '../middleware/ownership.js';
import { getEnv } from '../config/env.js';

export const chaptersRouter = new Hono();
export const chaptersTimelineRouter = new Hono();

export interface ChapterData {
  id: number;
  novelId: string;
  chapterNumber: number;
  title: string;
  content: string;
  wordCount?: number;
  createdAt: string;
}

export interface ChapterTimelineItem {
  id: number;
  chapterNumber: number;
  title: string;
  wordCount?: number;
  createdAt: string;
  timestamp: number;
  dayOfWeek: number;
  dateStr: string;
  novel: { id: string; title: string; author: string; coverUrl: string; category: string; sourceId?: string };
}

export interface NovelTimelineGroup {
  novelId: string;
  sourceId?: string;
  novelTitle: string;
  novelCover: string;
  novelAuthor: string;
  category: string;
  chapterCount: number;
  latestChapterNumber: number;
  latestChapterTitle: string;
  latestCreatedAt: string;
  chapters: Array<{ id: number; chapterNumber: number; title: string; createdAt: string }>;
}

export const CHAPTERS_STORE: Map<string, ChapterData[]> = new Map();

function ensureSeedData() {
  if (CHAPTERS_STORE.size > 0) return;
  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const twentyMinsAgo = new Date(now - 20 * 60 * 1000).toISOString();
  if (!NOVELS_STORE.has('1')) {
    NOVELS_STORE.set('1', {
      id: '1', title: 'سيد الكينونة الأبدية', author: 'جينغ شو', category: 'فانتازيا',
      status: 'مستمرة', rating: 4.8, readersCount: '12.4k', totalChapters: 46,
      coverUrl: '', summary: 'في عالم تتصادم فيه قوى السحر والداو...',
      tags: ['فانتازيا', 'مغامرات'], commentsEnabled: true, createdAt: twoHoursAgo, updatedAt: twentyMinsAgo,
    });
  }
  CHAPTERS_STORE.set('1', [
    { id: 101, novelId: '1', chapterNumber: 45, title: 'الفصل 45: استيقاظ التنين', content: 'محتوى الفصل التجريبي...', wordCount: 1540, createdAt: twoHoursAgo },
    { id: 102, novelId: '1', chapterNumber: 46, title: 'الفصل 46: كسر القيود', content: 'محتوى الفصل الثاني التجريبي...', wordCount: 1820, createdAt: twentyMinsAgo },
  ]);
}
ensureSeedData();

type ChapterRow = typeof chapters.$inferSelect;

function rowToListItem(r: ChapterRow) {
  return {
    id: r.id, novelId: r.novelId, chapterNumber: r.chapterNumber, title: r.title,
    wordCount: r.wordCount ?? 0, hash: (r as { contentHash?: string | null }).contentHash ?? null,
    createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
  };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s ?? ''));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function rowToContent(r: ChapterRow) {
  return {
    id: r.id, novelId: r.novelId, chapterNumber: r.chapterNumber, title: r.title,
    content: r.contentRaw ?? '', wordCount: r.wordCount ?? 0,
    createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
  };
}

const addChapterSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().min(1).max(500000),
  chapterNumber: z.number().int().min(1).optional(),
  id: z.number().int().optional(),
});

const timelineSchema = z.object({
  novelIds: z.array(z.union([z.string(), z.number()])).optional(),
  period: z.enum(['today', 'week', 'custom']).optional(),
  groupBy: z.enum(['novel', 'day', 'none']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional(),
});

function writeGuard() {
  return async (c: any, next: any) => {
    if (!getEnv().syncOpen) return requireAuthOrPat(c, next);
    await next();
  };
}

/** Run middlewares only in closed (prod) mode; open LAN keeps legacy behavior. */
function prodGuard(...mws: Array<(c: any, next: any) => unknown>) {
  return async (c: any, next: any) => {
    if (getEnv().syncOpen) {
      await next();
      return;
    }
    const dispatch = async (idx: number): Promise<Response | void> => {
      if (idx < mws.length) {
        // Mirror hono/compose: a middleware's returned Response finalizes the context.
        const res = await mws[idx](c, () => dispatch(idx + 1));
        if (res instanceof Response) {
          c.res = res;
          return res;
        }
        return;
      }
      await next();
    };
    const res = await dispatch(0);
    if (res instanceof Response) return res;
  };
}

function toTimelineItem(ch: { id: number; chapterNumber: number; title: string; wordCount: number; createdAt: string }, novel: NovelData | undefined, novelId: string): ChapterTimelineItem {
  const chTime = new Date(ch.createdAt).getTime();
  const d = new Date(chTime);
  return {
    id: ch.id, chapterNumber: ch.chapterNumber, title: ch.title, wordCount: ch.wordCount,
    createdAt: ch.createdAt, timestamp: chTime, dayOfWeek: d.getDay(), dateStr: d.toISOString().slice(0, 10),
    novel: {
      id: novelId, title: novel?.title || 'رواية بدون عنوان', author: novel?.author || 'غير معروف',
      coverUrl: novel?.coverUrl || '', category: novel?.category || 'عام', sourceId: novel?.sourceId,
    },
  };
}

async function collectTimelineItems(novelIds: Set<string> | null, since: number, until?: number): Promise<ChapterTimelineItem[]> {
  if (isDbAvailable()) {
    try {
      const chRows = await db
        .select({ ch: chapters, novel: novels })
        .from(chapters)
        .leftJoin(novels, eq(chapters.novelId, novels.id))
        .where(and(gte(chapters.createdAt, new Date(since)), until ? lte(chapters.createdAt, new Date(until)) : undefined))
        .orderBy(desc(chapters.createdAt))
        .limit(5000);
      const items: ChapterTimelineItem[] = [];
      for (const r of chRows) {
        const novelId = r.ch.novelId;
        if (novelIds && !novelIds.has(novelId)) continue;
        const createdAt = r.ch.createdAt?.toISOString() ?? new Date().toISOString();
        const t = new Date(createdAt).getTime();
        const d = new Date(t);
        items.push({
          id: r.ch.id, chapterNumber: r.ch.chapterNumber, title: r.ch.title, wordCount: r.ch.wordCount ?? 0,
          createdAt, timestamp: t, dayOfWeek: d.getDay(), dateStr: createdAt.slice(0, 10),
          novel: {
            id: novelId, title: r.novel?.title ?? 'رواية بدون عنوان', author: r.novel?.author ?? 'غير معروف',
            coverUrl: r.novel?.coverUrl ?? '', category: r.novel?.category ?? 'عام',
          },
        });
      }
      return items;
    } catch (err) {
      console.error('[chapters] db timeline failed, memory fallback', err); noteDbFailure();
    }
  }
  ensureSeedData();
  const items: ChapterTimelineItem[] = [];
  for (const [novelId, chList] of CHAPTERS_STORE.entries()) {
    if (novelIds && !novelIds.has(novelId)) continue;
    const novel = NOVELS_STORE.get(novelId);
    for (const ch of chList) {
      const t = new Date(ch.createdAt).getTime();
      if (t >= since && (!until || t <= until)) items.push(toTimelineItem({ ...ch, wordCount: ch.wordCount ?? 0 }, novel, novelId));
    }
  }
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

// POST /api/v1/chapters/timeline
chaptersTimelineRouter.post('/timeline', async (c) => {
  const parsed = timelineSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: 'invalid timeline payload', issues: parsed.error.issues }, 400);
  const { novelIds, period = 'today', groupBy = 'novel', limit, since: sinceRaw, until } = parsed.data;
  const now = Date.now();
  let since = sinceRaw;
  if (since === undefined) {
    if (period === 'week') since = now - 7 * 24 * 60 * 60 * 1000;
    else { const s = new Date(); s.setHours(0, 0, 0, 0); since = s.getTime(); }
  }
  const target = novelIds && novelIds.length ? new Set(novelIds.map(String)) : null;
  const list = await collectTimelineItems(target, since, until);

  if (groupBy === 'novel') {
    const map = new Map<string, NovelTimelineGroup>();
    for (const item of list) {
      let g = map.get(item.novel.id);
      if (!g) {
        g = {
          novelId: item.novel.id, sourceId: item.novel.sourceId, novelTitle: item.novel.title,
          novelCover: item.novel.coverUrl, novelAuthor: item.novel.author, category: item.novel.category,
          chapterCount: 0, latestChapterNumber: item.chapterNumber, latestChapterTitle: item.title, latestCreatedAt: item.createdAt, chapters: [],
        };
        map.set(item.novel.id, g);
      }
      g.chapterCount += 1;
      g.chapters.push({ id: item.id, chapterNumber: item.chapterNumber, title: item.title, createdAt: item.createdAt });
    }
    const groups = Array.from(map.values());
    const finalGroups = limit ? groups.slice(0, limit) : groups;
    return c.json({ success: true, total: finalGroups.length, period, data: finalGroups });
  }
  if (groupBy === 'day') {
    const map = new Map<string, ChapterTimelineItem[]>();
    for (const item of list) {
      const arr = map.get(item.dateStr) || [];
      arr.push(item);
      map.set(item.dateStr, arr);
    }
    const days = Array.from(map.entries()).map(([dateStr, items]) => ({ dateStr, dayOfWeek: items[0]?.dayOfWeek ?? 0, total: items.length, chapters: items }));
    return c.json({ success: true, total: days.length, period, data: days });
  }
  return c.json({ success: true, total: limit ? Math.min(limit, list.length) : list.length, period, data: limit ? list.slice(0, limit) : list });
});

// GET /api/v1/chapters/today
chaptersTimelineRouter.get('/today', async (c) => {
  const param = c.req.query('novelIds');
  const target = param ? new Set(param.split(',')) : null;
  const s = new Date(); s.setHours(0, 0, 0, 0);
  const list = await collectTimelineItems(target, s.getTime());
  return c.json({ success: true, total: list.length, data: list });
});

// GET /api/v1/novels/:novelId/chapters?page&limit&order
chaptersRouter.get('/:novelId/chapters', async (c) => {
  const novelId = c.req.param('novelId');
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
  const order = c.req.query('order') === 'desc' ? desc(chapters.chapterNumber) : asc(chapters.chapterNumber);

  if (isDbAvailable()) {
    try {
      const where = eq(chapters.novelId, novelId);
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(chapters).where(where);
      const rows = await db.select().from(chapters).where(where).orderBy(order).limit(limit).offset((page - 1) * limit);
      const items = rows.map(rowToListItem);
      c.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=3600');
      return c.json({ success: true, total, data: items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
    } catch (err) {
      console.error('[chapters] db list failed', err); noteDbFailure();
    }
  }
  const all = [...(CHAPTERS_STORE.get(novelId) || [])].sort((a, b) => order === desc(chapters.chapterNumber) as any ? 0 : a.chapterNumber - b.chapterNumber);
  const sorted = c.req.query('order') === 'desc' ? [...all].reverse() : all;
  const total = sorted.length;
  const items = sorted.slice((page - 1) * limit, page * limit).map((ch) => ({ id: ch.id, novelId: ch.novelId, chapterNumber: ch.chapterNumber, title: ch.title, wordCount: ch.wordCount, createdAt: ch.createdAt }));
  return c.json({ success: true, total, data: items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
});

// GET /api/v1/novels/:novelId/chapters/manifest — ultra-light change detection.
// Returns [{ n, hash, words }] for ALL chapters (no pagination, no titles).
// Lets clients download only new/changed chapters instead of full re-crawls.
chaptersRouter.get('/:novelId/chapters/manifest', async (c) => {
  const novelId = c.req.param('novelId');
  if (isDbAvailable()) {
    try {
      const rows = await db.select({
        chapterNumber: chapters.chapterNumber,
        contentHash: chapters.contentHash,
        wordCount: chapters.wordCount,
      }).from(chapters).where(eq(chapters.novelId, novelId)).orderBy(asc(chapters.chapterNumber));
      const items = rows.map((r) => ({ n: r.chapterNumber, hash: r.contentHash ?? null, words: r.wordCount ?? 0 }));
      c.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=3600');
      return c.json({ success: true, total: items.length, data: items });
    } catch (err) {
      console.error('[chapters] db manifest failed', err); noteDbFailure();
    }
  }
  const list = CHAPTERS_STORE.get(novelId) || [];
  return c.json({
    success: true, total: list.length,
    data: [...list].sort((a, b) => a.chapterNumber - b.chapterNumber).map((ch) => ({ n: ch.chapterNumber, hash: null, words: ch.wordCount ?? 0 })),
  });
});

// GET /api/v1/novels/:novelId/chapters/watermark — cheap change-detection token.
// Client polls this (~60 bytes) hourly and only fetches manifest/batch when it moves.
chaptersRouter.get('/:novelId/chapters/watermark', async (c) => {
  const novelId = c.req.param('novelId');
  if (isDbAvailable()) {
    try {
      const [row] = await db.select({
        total: sql<number>`count(*)::int`,
        maxN: sql<number>`coalesce(max(${chapters.chapterNumber}), 0)::int`,
        maxId: sql<number>`coalesce(max(${chapters.id}), 0)::int`,
        maxCreated: sql<Date>`max(${chapters.createdAt})`,
      }).from(chapters).where(eq(chapters.novelId, novelId));
      const total = Number(row?.total ?? 0);
      const maxN = Number(row?.maxN ?? 0);
      const maxId = Number(row?.maxId ?? 0);
      const watermark = total ? `${total}:${maxN}:${maxId}` : '0';
      c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
      return c.json({
        success: true,
        data: {
          watermark, total, maxChapterNumber: maxN, maxId,
          lastCreatedAt: row?.maxCreated ? new Date(row.maxCreated as unknown as string).toISOString() : null,
        },
      });
    } catch (err) {
      console.error('[chapters] db watermark failed', err); noteDbFailure();
    }
  }
  const mem = CHAPTERS_STORE.get(novelId) || [];
  const maxN = mem.reduce((m, ch) => Math.max(m, ch.chapterNumber), 0);
  const maxId = mem.reduce((m, ch) => Math.max(m, ch.id), 0);
  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
  return c.json({
    success: true,
    data: {
      watermark: mem.length ? `${mem.length}:${maxN}:${maxId}` : '0',
      total: mem.length, maxChapterNumber: maxN, maxId,
      lastCreatedAt: mem.length ? [...mem].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0].createdAt : null,
    },
  });
});

const batchSchema = z.object({
  numbers: z.array(z.number().int().min(1)).min(1).max(100),
});

// POST /api/v1/novels/:novelId/chapters/batch — fetch up to 100 chapter
// contents in ONE round trip (bulk download without N sequential requests).
chaptersRouter.post('/:novelId/chapters/batch', async (c) => {
  const novelId = c.req.param('novelId');
  const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: 'numbers[1..100] مطلوبة' }, 400);
  const nums = [...new Set(parsed.data.numbers)].sort((a, b) => a - b);

  if (isDbAvailable()) {
    try {
      const rows = await db.select().from(chapters)
        .where(and(eq(chapters.novelId, novelId), inArray(chapters.chapterNumber, nums)))
        .orderBy(asc(chapters.chapterNumber));
      return c.json({ success: true, total: rows.length, data: rows.map(rowToContent) });
    } catch (err) {
      console.error('[chapters] db batch failed', err); noteDbFailure();
    }
  }
  const list = CHAPTERS_STORE.get(novelId) || [];
  const found = list.filter((ch) => nums.includes(ch.chapterNumber)).sort((a, b) => a.chapterNumber - b.chapterNumber);
  return c.json({ success: true, total: found.length, data: found });
});

// GET /api/v1/novels/:novelId/chapters/:chapterNumber
chaptersRouter.get('/:novelId/chapters/:chapterNumber', async (c) => {
  const { novelId, chapterNumber } = c.req.param();
  const num = parseInt(chapterNumber, 10);
  if (Number.isNaN(num)) return c.json({ success: false, error: 'رقم الفصل غير صالح' }, 400);

  if (isDbAvailable()) {
    try {
      const rows = await db.select().from(chapters).where(and(eq(chapters.novelId, novelId), eq(chapters.chapterNumber, num))).limit(1);
      const byId = rows[0] ?? (await db.select().from(chapters).where(and(eq(chapters.novelId, novelId), eq(chapters.id, num))).limit(1))[0];
      if (byId) {
        const siblings = await db.select({ chapterNumber: chapters.chapterNumber, id: chapters.id }).from(chapters).where(eq(chapters.novelId, novelId));
        const nums = new Set(siblings.map((s) => s.chapterNumber));
        const ids = new Map(siblings.map((s) => [s.chapterNumber, s.id] as const));
        c.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        return c.json({
          success: true,
          data: {
            ...rowToContent(byId),
            nextChapterId: nums.has(byId.chapterNumber + 1) ? ids.get(byId.chapterNumber + 1) ?? null : null,
            prevChapterId: nums.has(byId.chapterNumber - 1) ? ids.get(byId.chapterNumber - 1) ?? null : null,
            totalChapters: siblings.length,
          },
        });
      }
    } catch (err) {
      console.error('[chapters] db get failed', err); noteDbFailure();
    }
  }
  const list = CHAPTERS_STORE.get(novelId) || [];
  const chapter = list.find((ch) => ch.chapterNumber === num || ch.id === num);
  if (!chapter) return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
  const next = list.find((ch) => ch.chapterNumber === num + 1);
  const prev = list.find((ch) => ch.chapterNumber === num - 1);
  c.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  return c.json({ success: true, data: { ...chapter, nextChapterId: next?.id ?? null, prevChapterId: prev?.id ?? null, totalChapters: list.length } });
});

// POST /api/v1/novels/:novelId/chapters
chaptersRouter.post('/:novelId/chapters', prodGuard(requireAuthOrPat, ensureNovelOwner()), async (c) => {
  const novelId = c.req.param('novelId');
  const parsed = addChapterSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: 'عنوان ومحتوى الفصل حقول مطلوبة', issues: parsed.error.issues }, 400);
  const body = parsed.data;
  const wordCount = body.content.trim().split(/\s+/).length;

  if (isDbAvailable()) {
    try {
      const existing = await db.select().from(chapters).where(eq(chapters.novelId, novelId));
      const chapterNumber = body.chapterNumber ?? existing.length + 1;
      if (existing.some((r) => r.chapterNumber === chapterNumber)) return c.json({ success: false, error: 'رقم الفصل موجود مسبقاً' }, 409);
      const inserted = await db.insert(chapters).values({
        novelId, chapterNumber, title: body.title, contentRaw: body.content, wordCount,
        contentHash: await sha256Hex(body.content), createdAt: new Date(),
      }).returning();
      await db.update(novels).set({ totalChapters: existing.length + 1, updatedAt: new Date() }).where(eq(novels.id, novelId));
      return c.json({ success: true, message: 'تم إضافة الفصل بنجاح', data: rowToContent(inserted[0]) }, 201);
    } catch (err) {
      console.error('[chapters] db insert failed', err); noteDbFailure();
    }
  }
  const current = CHAPTERS_STORE.get(novelId) || [];
  const chapterNumber = body.chapterNumber ?? current.length + 1;
  const novel: ChapterData = {
    id: body.id ?? (current.length ? Math.max(...current.map((ch) => ch.id)) + 1 : 1),
    novelId, chapterNumber, title: body.title, content: body.content, wordCount, createdAt: new Date().toISOString(),
  };
  current.push(novel);
  CHAPTERS_STORE.set(novelId, current);
  return c.json({ success: true, message: 'تم إضافة الفصل بنجاح', data: novel }, 201);
});

const editChapterSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  content: z.string().min(1).max(500000).optional(),
});

// PUT /api/v1/novels/:novelId/chapters/:chapterNumber (owner or admin)
chaptersRouter.put('/:novelId/chapters/:chapterNumber', prodGuard(requireAuthOrPat, ensureNovelOwner()), async (c) => {
  const { novelId, chapterNumber } = c.req.param();
  const num = parseInt(chapterNumber, 10);
  if (Number.isNaN(num)) return c.json({ success: false, error: 'رقم الفصل غير صالح' }, 400);
  const parsed = editChapterSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: 'حقول غير صالحة', issues: parsed.error.issues }, 400);
  if (!parsed.data.title && !parsed.data.content) return c.json({ success: false, error: 'لا يوجد ما يُعدَّل' }, 400);

  if (isDbAvailable()) {
    try {
      const rows = await db.select().from(chapters)
        .where(and(eq(chapters.novelId, novelId), eq(chapters.chapterNumber, num))).limit(1);
      if (!rows[0]) return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
      const wordCount = parsed.data.content != null ? parsed.data.content.trim().split(/\s+/).length : undefined;
      await db.update(chapters).set({
        title: parsed.data.title ?? undefined,
        contentRaw: parsed.data.content ?? undefined,
        contentHash: parsed.data.content != null ? await sha256Hex(parsed.data.content) : undefined,
        wordCount,
      }).where(eq(chapters.id, rows[0].id));
      const updated = await db.select().from(chapters).where(eq(chapters.id, rows[0].id)).limit(1);
      return c.json({ success: true, message: 'تم تعديل الفصل بنجاح', data: rowToContent(updated[0]) });
    } catch (err) {
      console.error('[chapters] db update failed', err); noteDbFailure();
    }
  }
  const list = CHAPTERS_STORE.get(novelId) || [];
  const ch = list.find((x) => x.chapterNumber === num);
  if (!ch) return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
  if (parsed.data.title) ch.title = parsed.data.title;
  if (parsed.data.content) { ch.content = parsed.data.content; ch.wordCount = parsed.data.content.trim().split(/\s+/).length; }
  return c.json({ success: true, message: 'تم تعديل الفصل بنجاح', data: ch });
});

// DELETE /api/v1/novels/:novelId/chapters/:chapterNumber (owner or admin)
chaptersRouter.delete('/:novelId/chapters/:chapterNumber', prodGuard(requireAuthOrPat, ensureNovelOwner()), async (c) => {
  const { novelId, chapterNumber } = c.req.param();
  const num = parseInt(chapterNumber, 10);
  if (Number.isNaN(num)) return c.json({ success: false, error: 'رقم الفصل غير صالح' }, 400);

  if (isDbAvailable()) {
    try {
      const rows = await db.select().from(chapters)
        .where(and(eq(chapters.novelId, novelId), eq(chapters.chapterNumber, num))).limit(1);
      if (!rows[0]) return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
      await db.delete(chapters).where(eq(chapters.id, rows[0].id));
      const remaining = await db.select({ id: chapters.id }).from(chapters).where(eq(chapters.novelId, novelId));
      await db.update(novels).set({ totalChapters: remaining.length, updatedAt: new Date() }).where(eq(novels.id, novelId));
      return c.json({ success: true, message: 'تم حذف الفصل بنجاح' });
    } catch (err) {
      console.error('[chapters] db delete failed', err); noteDbFailure();
    }
  }
  const list = CHAPTERS_STORE.get(novelId) || [];
  const idx = list.findIndex((x) => x.chapterNumber === num);
  if (idx < 0) return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
  list.splice(idx, 1);
  return c.json({ success: true, message: 'تم حذف الفصل بنجاح' });
});
