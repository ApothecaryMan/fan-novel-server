import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { novels } from '../database/schema.js';
import { requireAuthOrPat } from '../middleware/authorToken.js';
import { ensureNovelOwner, getCaller } from '../middleware/ownership.js';
import { getEnv } from '../config/env.js';

export const novelsRouter = new Hono();

export interface NovelData {
  id: string;
  sourceId?: string;
  title: string;
  originalTitle?: string;
  author: string;
  translator?: string;
  category: string;
  status: string;
  rating: number;
  readersCount: string;
  totalChapters: number;
  coverUrl: string;
  summary: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// In-memory fallback when DATABASE_URL is unset/unreachable (dev / free tier without DB)
export const NOVELS_STORE: Map<string, NovelData> = new Map();

type NovelRow = typeof novels.$inferSelect;

function toApi(row: NovelRow): NovelData {
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.originalTitle ?? '',
    author: row.author,
    translator: row.translator ?? '',
    category: row.category,
    status: row.status,
    rating: (row.rating ?? 50) / 10,
    readersCount: row.readersCount ?? '0',
    totalChapters: row.totalChapters ?? 0,
    coverUrl: row.coverUrl ?? '',
    summary: row.summary ?? '',
    tags: (row.tags as string[]) ?? [],
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

function normalizeTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === 'string' && input) return input.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

const createNovelSchema = z.object({
  id: z.string().max(100).optional(),
  title: z.string().min(1).max(255),
  author: z.string().min(1).max(150),
  category: z.string().min(1).max(100),
  originalTitle: z.string().max(255).optional(),
  translator: z.string().max(150).optional(),
  status: z.string().max(50).optional(),
  rating: z.number().min(0).max(5).optional(),
  readersCount: z.string().max(50).optional(),
  totalChapters: z.number().int().min(0).optional(),
  coverUrl: z.string().max(2000).optional(),
  summary: z.string().max(50000).optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  kind: z.enum(['author', 'translator']).optional(),
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

// GET /api/v1/novels?page&limit&category&status&q&sortBy
novelsRouter.get('/', async (c) => {
  const category = c.req.query('category');
  const status = c.req.query('status');
  const q = c.req.query('q')?.toLowerCase();
  const sortBy = c.req.query('sortBy') ?? 'latest';
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));

  if (isDbAvailable()) {
    try {
      const filters = [];
      if (category && category !== 'الكل') filters.push(eq(novels.category, category));
      if (status) filters.push(eq(novels.status, status));
      if (q) {
        const like = `%${q}%`;
        filters.push(or(ilike(novels.title, like), ilike(novels.author, like), ilike(novels.category, like))!);
      }
      const where = filters.length ? and(...filters) : undefined;
      const order =
        sortBy === 'rating' ? desc(novels.rating)
        : sortBy === 'popular' ? desc(novels.totalChapters)
        : sortBy === 'rank' ? desc(novels.featuredRank)
        : desc(novels.updatedAt);
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(novels)
        .where(where);
      const rows = await db
        .select()
        .from(novels)
        .where(where)
        .orderBy(order)
        .limit(limit)
        .offset((page - 1) * limit);
      const data = rows.map(toApi);
      const total = Number(count ?? data.length);
      return c.json({ success: true, total, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
    } catch (err) {
      console.error('[novels] db list failed, falling back to memory', err); noteDbFailure();
    }
  }

  let data = Array.from(NOVELS_STORE.values());
  if (category && category !== 'الكل') data = data.filter((n) => n.category.includes(category) || n.tags?.includes(category));
  if (status) data = data.filter((n) => n.status === status);
  if (q) {
    data = data.filter((n) =>
      n.title.toLowerCase().includes(q) ||
      n.author.toLowerCase().includes(q) ||
      n.category.toLowerCase().includes(q) ||
      n.tags?.some((t) => t.toLowerCase().includes(q))
    );
  }
  if (sortBy === 'rating') data = [...data].sort((a, b) => b.rating - a.rating);
  const total = data.length;
  const items = data.slice((page - 1) * limit, page * limit);
  return c.json({ success: true, total, data: items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
});

// GET /api/v1/novels/:id
novelsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (isDbAvailable()) {
    try {
      const rows = await db.select().from(novels).where(eq(novels.id, id)).limit(1);
      if (rows[0]) return c.json({ success: true, data: toApi(rows[0]) });
    } catch (err) {
      console.error('[novels] db get failed', err); noteDbFailure();
    }
  }
  const novel = NOVELS_STORE.get(id);
  if (!novel) return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);
  return c.json({ success: true, data: novel });
});

// POST /api/v1/novels
novelsRouter.post('/', prodGuard(requireAuthOrPat), async (c) => {
  const parsed = createNovelSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: 'حقول غير صالحة', issues: parsed.error.issues }, 400);
  const body = parsed.data;
  const id = body.id || `novel_${Date.now()}`;
  const kind = body.kind ?? 'author';

  // Closed mode: require the matching grant and stamp ownership.
  let ownerPatch: { authorUserId?: string | null; translatorUserId?: string | null } = {};
  if (!getEnv().syncOpen) {
    const caller = await getCaller(c);
    if (!caller.row) return c.json({ success: false, error: 'غير مصرح: مطلوب تسجيل الدخول' }, 401);
    const allowed = caller.isAdmin || (kind === 'author' ? Boolean(caller.row.isAuthor) : Boolean(caller.row.isTranslator));
    if (!allowed) return c.json({ success: false, error: 'غير مسموح: تحتاج إذن ' + (kind === 'author' ? 'التأليف' : 'الترجمة') }, 403);
    ownerPatch = kind === 'author' ? { authorUserId: caller.row.id } : { translatorUserId: caller.row.id };
  }

  if (isDbAvailable()) {
    try {
      const now = new Date();
      await db.insert(novels).values({
        id,
        title: body.title,
        originalTitle: body.originalTitle ?? null,
        author: body.author,
        translator: body.translator ?? null,
        category: body.category,
        status: body.status ?? 'مستمرة',
        rating: body.rating != null ? Math.round(body.rating * 10) : 50,
        readersCount: body.readersCount ?? '0',
        totalChapters: body.totalChapters ?? 0,
        coverUrl: body.coverUrl ?? '',
        summary: body.summary ?? '',
        tags: normalizeTags(body.tags),
        ...ownerPatch,
        createdAt: now,
        updatedAt: now,
      });
      const rows = await db.select().from(novels).where(eq(novels.id, id)).limit(1);
      return c.json({ success: true, message: 'تم إضافة الرواية بنجاح', data: toApi(rows[0]) }, 201);
    } catch (err: any) {
      console.error('[novels] db insert failed', err); noteDbFailure();
    }
  }

  const now = new Date().toISOString();
  const novel: NovelData = {
    id, title: body.title, originalTitle: body.originalTitle || '', author: body.author,
    translator: body.translator || '', category: body.category, status: body.status || 'مستمرة',
    rating: body.rating ?? 5.0, readersCount: body.readersCount || '0', totalChapters: body.totalChapters ?? 0,
    coverUrl: body.coverUrl || '', summary: body.summary || '', tags: normalizeTags(body.tags),
    createdAt: now, updatedAt: now,
  };
  NOVELS_STORE.set(id, novel);
  return c.json({ success: true, message: 'تم إضافة الرواية بنجاح', data: novel }, 201);
});

// PUT /api/v1/novels/:id
novelsRouter.put('/:id', prodGuard(requireAuthOrPat, ensureNovelOwner()), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const tags = body.tags !== undefined ? normalizeTags(body.tags) : undefined;

  if (isDbAvailable()) {
    try {
      const rows = await db.select().from(novels).where(eq(novels.id, id)).limit(1);
      if (!rows[0]) return c.json({ success: false, error: 'الرواية غير موجودة للتعديل' }, 404);
      await db.update(novels).set({
        title: body.title ?? undefined,
        originalTitle: body.originalTitle ?? undefined,
        author: body.author ?? undefined,
        translator: body.translator ?? undefined,
        category: body.category ?? undefined,
        status: body.status ?? undefined,
        rating: body.rating != null ? Math.round(Number(body.rating) * 10) : undefined,
        readersCount: body.readersCount ?? undefined,
        totalChapters: body.totalChapters ?? undefined,
        coverUrl: body.coverUrl ?? undefined,
        summary: body.summary ?? undefined,
        tags: tags ?? undefined,
        updatedAt: new Date(),
      }).where(eq(novels.id, id));
      const updated = await db.select().from(novels).where(eq(novels.id, id)).limit(1);
      return c.json({ success: true, message: 'تم تعديل بيانات الرواية بنجاح', data: toApi(updated[0]) });
    } catch (err) {
      console.error('[novels] db update failed', err); noteDbFailure();
    }
  }

  const existing = NOVELS_STORE.get(id);
  if (!existing) return c.json({ success: false, error: 'الرواية غير موجودة للتعديل' }, 404);
  const updated: NovelData = { ...existing, ...body, tags: tags ?? existing.tags, updatedAt: new Date().toISOString() };
  NOVELS_STORE.set(id, updated);
  return c.json({ success: true, message: 'تم تعديل بيانات الرواية بنجاح', data: updated });
});

// DELETE /api/v1/novels/:id
novelsRouter.delete('/:id', prodGuard(requireAuthOrPat, ensureNovelOwner()), async (c) => {
  const id = c.req.param('id');
  if (isDbAvailable()) {
    try {
      await db.delete(novels).where(eq(novels.id, id));
      return c.json({ success: true, message: 'تم حذف الرواية بنجاح' });
    } catch (err) {
      console.error('[novels] db delete failed', err); noteDbFailure();
    }
  }
  if (!NOVELS_STORE.has(id) && !isDbAvailable()) return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);
  NOVELS_STORE.delete(id);
  return c.json({ success: true, message: 'تم حذف الرواية بنجاح' });
});
