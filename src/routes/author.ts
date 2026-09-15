import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { novels, roleRequests } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getCaller } from '../middleware/ownership.js';

export const authorRouter = new Hono();

// All /author/* routes require login (even on open LAN: creations are identity-bound).
authorRouter.use('*', requireAuth);

const requestSchema = z.object({
  kind: z.enum(['author', 'translator']),
  note: z.string().max(500).optional(),
});

// POST /api/v1/author/requests — request author/translator grant
authorRouter.post('/requests', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'نوع الطلب غير صالح', issues: parsed.error.issues }, 400);
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'غير مصرح' }, 401);

  const has = parsed.data.kind === 'author' ? caller.row.isAuthor : caller.row.isTranslator;
  if (has || caller.isAdmin) return c.json({ success: true, message: 'الإذن ممنوح مسبقاً' });
  try {
    const dup = await db.select().from(roleRequests).where(and(
      eq(roleRequests.userId, caller.row.id),
      eq(roleRequests.kind, parsed.data.kind),
      eq(roleRequests.status, 'pending'),
    )).limit(1);
    if (dup[0]) return c.json({ success: true, message: 'طلبك قيد المراجعة', data: dup[0] });
    const inserted = await db.insert(roleRequests).values({
      userId: caller.row.id, kind: parsed.data.kind, note: parsed.data.note ?? null,
    }).returning();
    return c.json({ success: true, message: 'تم إرسال الطلب للإدارة', data: inserted[0] }, 201);
  } catch (err) {
    console.error('[author] request failed', err); noteDbFailure();
    return c.json({ error: 'فشل إرسال الطلب' }, 500);
  }
});

// GET /api/v1/author/requests/mine — my pending/decided requests
authorRouter.get('/requests/mine', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'غير مصرح' }, 401);
  try {
    const rows = await db.select().from(roleRequests)
      .where(eq(roleRequests.userId, caller.row.id)).orderBy(desc(roleRequests.createdAt)).limit(50);
    return c.json({ success: true, data: rows });
  } catch (err) {
    console.error('[author] mine requests failed', err); noteDbFailure();
    return c.json({ error: 'فشل الجلب' }, 500);
  }
});

// GET /api/v1/author/mine?kind=author|translator — only my novels (ابداعاتي lists)
authorRouter.get('/mine', async (c) => {
  const kind = c.req.query('kind') === 'translator' ? 'translator' : 'author';
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'غير مصرح' }, 401);
  if (!isDbAvailable()) return c.json({ success: true, total: 0, data: [] });
  try {
    const col = kind === 'author' ? novels.authorUserId : novels.translatorUserId;
    const rows = await db.select().from(novels).where(eq(col, caller.row.id)).orderBy(desc(novels.updatedAt)).limit(200);
    return c.json({
      success: true,
      total: rows.length,
      data: rows.map((r) => ({
        id: r.id, title: r.title, author: r.author, category: r.category, status: r.status,
        totalChapters: r.totalChapters ?? 0, coverUrl: r.coverUrl ?? '',
        updatedAt: r.updatedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    console.error('[author] mine failed', err); noteDbFailure();
    return c.json({ error: 'فشل الجلب' }, 500);
  }
});
