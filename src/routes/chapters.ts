import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, gte, lte, asc, inArray, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { chapters, novels } from '../database/schema.js';
import { NOVELS_STORE, type NovelData } from './novels.js';
import { requireAuthOrPat } from '../middleware/authorToken.js';
import { verifySubject } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
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
  viewsCount?: number;
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
  /** Backend id repeated as url so clients can merge with local groups keyed by novelUrl. */
  novelUrl?: string;
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

// Every row in the novels table is a backend-published novel. The novels table
// itself has no source column — source identity lives on the client — so the
// timeline stamps the client-known id here. Without it a group opened from
// "today's chapters" navigates without ?src= and the details screen cannot
// resolve a backend string id, rendering an empty page with an add button.
export const PUBLISHED_SOURCE_ID = 'internal:published';

export const CHAPTERS_STORE: Map<string, ChapterData[]> = new Map();

type ChapterRow = typeof chapters.$inferSelect;

function rowToListItem(r: ChapterRow) {
  return {
    id: r.id, novelId: r.novelId, chapterNumber: r.chapterNumber, title: r.title,
    wordCount: r.wordCount ?? 0, viewsCount: r.viewsCount ?? 0, hash: (r as { contentHash?: string | null }).contentHash ?? null,
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
    content: r.contentRaw ?? '', wordCount: r.wordCount ?? 0, viewsCount: r.viewsCount ?? 0,
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
      coverUrl: novel?.coverUrl || '', category: novel?.category || 'عام', sourceId: novel?.sourceId ?? PUBLISHED_SOURCE_ID,
    },
  };
}

async function collectTimelineItems(novelIds: Set<string> | null, since: number, until?: number): Promise<ChapterTimelineItem[]> {
  if (isDbAvailable()) {
    try {
      const ids = novelIds ? [...novelIds].slice(0, 100) : null;
      const chRows = await db
        .select({
          id: chapters.id,
          novelId: chapters.novelId,
          chapterNumber: chapters.chapterNumber,
          title: chapters.title,
          wordCount: chapters.wordCount,
          createdAt: chapters.createdAt,
          novelTitle: novels.title,
          novelAuthor: novels.author,
          novelCover: novels.coverUrl,
          novelCategory: novels.category,
        })
        .from(chapters)
        .leftJoin(novels, eq(chapters.novelId, novels.id))
        .where(and(
          gte(chapters.createdAt, new Date(since)),
          until ? lte(chapters.createdAt, new Date(until)) : undefined,
          ids ? inArray(chapters.novelId, ids) : undefined,
        ))
        .orderBy(desc(chapters.createdAt))
        .limit(5000);
      const items: ChapterTimelineItem[] = [];
      for (const r of chRows) {
        const novelId = r.novelId;
        const createdAt = r.createdAt?.toISOString() ?? new Date().toISOString();
        const t = new Date(createdAt).getTime();
        const d = new Date(t);
        items.push({
          id: r.id, chapterNumber: r.chapterNumber, title: r.title, wordCount: r.wordCount ?? 0,
          createdAt, timestamp: t, dayOfWeek: d.getDay(), dateStr: createdAt.slice(0, 10),
          novel: {
            id: novelId, title: r.novelTitle ?? 'رواية بدون عنوان', author: r.novelAuthor ?? 'غير معروف',
            coverUrl: r.novelCover ?? '', category: r.novelCategory ?? 'عام', sourceId: PUBLISHED_SOURCE_ID,
          },
        });
      }
      return items;
    } catch (err) {
      console.error('[chapters] db timeline failed, memory fallback', err); noteDbFailure();
    }
  }
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
          novelId: item.novel.id, sourceId: item.novel.sourceId ?? PUBLISHED_SOURCE_ID, novelUrl: item.novel.id,
          novelTitle: item.novel.title,
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
  const items = sorted.slice((page - 1) * limit, page * limit).map((ch) => ({ id: ch.id, novelId: ch.novelId, chapterNumber: ch.chapterNumber, title: ch.title, wordCount: ch.wordCount, viewsCount: ch.viewsCount ?? 0, createdAt: ch.createdAt }));
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

// Global public view counter. GET never counts (it is CDN-cacheable); the
// client calls this POST once its local hook qualifies the read (15s active
// or 25% scroll). Anonymous callers count via an IP+UA hash, signed callers
// via their user id. Re-opens inside 30 min are deduped, not counted.
export const VIEW_SECONDS = 15;
export const VIEW_PROGRESS = 0.25;
export const VIEW_REVISIT_WINDOW_MS = 30 * 60 * 1000;

export function qualifiesForView(readSeconds: number | undefined, progress: number | undefined): boolean {
  return (readSeconds ?? 0) >= VIEW_SECONDS || (progress ?? 0) >= VIEW_PROGRESS;
}

const viewBodySchema = z.object({
  readSeconds: z.number().min(0).max(86400).optional(),
  progress: z.number().min(0).max(1).optional(),
});

const memoryViewDedup = new Map<string, number>();

export function memoryViewDedupKey(novelId: string, chapterNumber: number, viewerKey: string): string {
  return `${novelId}:${chapterNumber}:${viewerKey}`;
}

async function resolveViewerKey(c: { req: { header: (n: string) => string | undefined } }): Promise<string> {
  const subject = await verifySubject(c.req.header('Authorization'));
  if (subject) return `u:${subject}`;
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';
  const ua = c.req.header('user-agent') || '';
  return `ip:${(await sha256Hex(`${ip}|${ua}`)).slice(0, 32)}`;
}

chaptersRouter.post('/:novelId/chapters/:chapterNumber/view', rateLimit(60), async (c) => {
  const { novelId, chapterNumber } = c.req.param();
  const num = parseInt(chapterNumber, 10);
  if (Number.isNaN(num)) return c.json({ success: false, error: 'رقم الفصل غير صالح' }, 400);
  const parsed = viewBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: 'حقول غير صالحة', issues: parsed.error.issues }, 400);
  if (!qualifiesForView(parsed.data.readSeconds, parsed.data.progress)) {
    return c.json({ success: true, counted: false, reason: 'not_qualified' });
  }
  const viewerKey = await resolveViewerKey(c);
  const now = Date.now();

  if (isDbAvailable()) {
    try {
      const rows = await db.select().from(chapters).where(and(eq(chapters.novelId, novelId), eq(chapters.chapterNumber, num))).limit(1);
      const target = rows[0] ?? (await db.select().from(chapters).where(and(eq(chapters.novelId, novelId), eq(chapters.id, num))).limit(1))[0];
      if (!target) return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
      const canonical = target.chapterNumber;
      const at = new Date(now);
      // Single atomic statement: the row lock on the dedup PK serializes
      // concurrent hits from the same viewer, so a re-open inside 30 min
      // makes every downstream CTE a no-op with no race and one round trip.
      const raw = await db.execute(sql`
        WITH upsert AS (
          INSERT INTO "chapter_view_dedup" ("novel_id", "chapter_number", "viewer_key", "last_viewed_at")
          VALUES (${novelId}, ${canonical}, ${viewerKey}, ${at})
          ON CONFLICT ("novel_id", "chapter_number", "viewer_key") DO UPDATE
            SET "last_viewed_at" = ${at}
            WHERE "chapter_view_dedup"."last_viewed_at" <= ${at} - interval '30 minutes'
          RETURNING 1
        ),
        ch AS (
          UPDATE "chapters" SET "views_count" = "views_count" + 1
          WHERE "novel_id" = ${novelId} AND "chapter_number" = ${canonical}
            AND EXISTS (SELECT 1 FROM upsert)
          RETURNING "novel_id", "views_count"
        ),
        nv AS (
          UPDATE "novels" SET "views_count" = "views_count" + 1, "updated_at" = ${at}
          WHERE "id" = (SELECT "novel_id" FROM ch)
          RETURNING "views_count"
        )
        SELECT EXISTS (SELECT 1 FROM upsert) AS counted,
               (SELECT "views_count" FROM ch) AS chapter_views,
               (SELECT "views_count" FROM nv) AS novel_views
      `);
      const row = (((raw as unknown as { rows?: Record<string, unknown>[] }).rows ?? raw) as unknown as Record<string, unknown>[])[0] ?? {};
      if (!row.counted) {
        return c.json({ success: true, counted: false, reason: 'deduped', data: { viewsCount: target.viewsCount ?? 0 } });
      }
      return c.json({
        success: true, counted: true,
        data: { viewsCount: Number(row.chapter_views ?? (target.viewsCount ?? 0) + 1), totalViews: Number(row.novel_views ?? 0) },
      });
    } catch (err) {
      console.error('[chapters] db view failed', err); noteDbFailure();
    }
  }
  const list = CHAPTERS_STORE.get(novelId) || [];
  const chapter = list.find((ch) => ch.chapterNumber === num || ch.id === num);
  if (!chapter) return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
  const key = memoryViewDedupKey(novelId, chapter.chapterNumber, viewerKey);
  const lastMem = memoryViewDedup.get(key) ?? 0;
  if (now - lastMem < VIEW_REVISIT_WINDOW_MS) {
    return c.json({ success: true, counted: false, reason: 'deduped', data: { viewsCount: chapter.viewsCount ?? 0 } });
  }
  memoryViewDedup.set(key, now);
  chapter.viewsCount = (chapter.viewsCount ?? 0) + 1;
  const memNovel = NOVELS_STORE.get(novelId);
  if (memNovel) memNovel.viewsCount = (memNovel.viewsCount ?? 0) + 1;
  return c.json({ success: true, counted: true, data: { viewsCount: chapter.viewsCount, totalViews: memNovel?.viewsCount ?? 0 } });
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
      const parent = await db.select({ id: novels.id }).from(novels).where(eq(novels.id, novelId)).limit(1);
      if (!parent[0]) return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);
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
    novelId, chapterNumber, title: body.title, content: body.content, wordCount, viewsCount: 0, createdAt: new Date().toISOString(),
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
      const removedViews = rows[0].viewsCount ?? 0;
      await db.delete(chapters).where(eq(chapters.id, rows[0].id));
      const remaining = await db.select({ id: chapters.id }).from(chapters).where(eq(chapters.novelId, novelId));
      await db.update(novels).set({
        totalChapters: remaining.length,
        viewsCount: sql`greatest(0, ${novels.viewsCount} - ${removedViews})`,
        updatedAt: new Date(),
      }).where(eq(novels.id, novelId));
      return c.json({ success: true, message: 'تم حذف الفصل بنجاح' });
    } catch (err) {
      console.error('[chapters] db delete failed', err); noteDbFailure();
    }
  }
  const list = CHAPTERS_STORE.get(novelId) || [];
  const idx = list.findIndex((x) => x.chapterNumber === num);
  if (idx < 0) return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
  const [removed] = list.splice(idx, 1);
  const memNovel = NOVELS_STORE.get(novelId);
  if (memNovel) memNovel.viewsCount = Math.max(0, (memNovel.viewsCount ?? 0) - (removed.viewsCount ?? 0));
  return c.json({ success: true, message: 'تم حذف الفصل بنجاح' });
});
