import { Hono } from 'hono';
import { z } from 'zod';
import { count, desc, eq } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { novels, roleRequests, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getCaller } from '../middleware/ownership.js';

export const adminRouter = new Hono();

// Every /admin/* route requires admin role.
adminRouter.use('*', requireAuth);
adminRouter.use('*', async (c, next) => {
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'غير مصرح' }, 401);
  if (!caller.isAdmin) return c.json({ error: 'غير مسموح: للإدارة فقط' }, 403);
  c.set('caller', caller);
  await next();
});

function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id, externalId: u.externalId, email: u.email, username: u.username,
    displayName: u.displayName, avatarUrl: u.avatarUrl, bannerUrl: u.bannerUrl,
    role: u.role, isAuthor: u.isAuthor, isTranslator: u.isTranslator,
    createdAt: u.createdAt?.toISOString() ?? null,
  };
}

// GET /api/v1/admin/users?page&limit&q
adminRouter.get('/users', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  try {
    const rows = await db.select().from(users).orderBy(desc(users.createdAt)).limit(limit).offset((page - 1) * limit);
    const [{ total }] = await db.select({ total: count() }).from(users);
    return c.json({ success: true, total: Number(total ?? rows.length), data: rows.map(publicUser) });
  } catch (err) {
    console.error('[admin] users failed', err); noteDbFailure();
    return c.json({ error: 'فشل الجلب' }, 500);
  }
});

const grantSchema = z.object({
  isAuthor: z.boolean().optional(),
  isTranslator: z.boolean().optional(),
  role: z.enum(['reader', 'admin']).optional(),
});

// PUT /api/v1/admin/users/:id — set grants/role (cannot demote the last admin)
adminRouter.put('/users/:id', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = grantSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'حقول غير صالحة', issues: parsed.error.issues }, 400);
  const id = c.req.param('id');
  try {
    const found = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const target = found[0];
    if (!target) return c.json({ error: 'المستخدم غير موجود' }, 404);
    if (parsed.data.role === 'reader' && target.role === 'admin') {
      const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
      if (admins.length <= 1) return c.json({ error: 'لا يمكن إزالة آخر أدمن' }, 409);
    }
    await db.update(users).set({
      isAuthor: parsed.data.isAuthor ?? undefined,
      isTranslator: parsed.data.isTranslator ?? undefined,
      role: parsed.data.role ?? undefined,
      updatedAt: new Date(),
    }).where(eq(users.id, id));
    const updated = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return c.json({ success: true, data: publicUser(updated[0]) });
  } catch (err) {
    console.error('[admin] grant failed', err); noteDbFailure();
    return c.json({ error: 'فشل الحفظ' }, 500);
  }
});

// GET /api/v1/admin/requests?status=pending — grant request queue
adminRouter.get('/requests', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const status = c.req.query('status') ?? 'pending';
  try {
    const rows = await db.select({ req: roleRequests, user: users })
      .from(roleRequests)
      .leftJoin(users, eq(roleRequests.userId, users.id))
      .where(eq(roleRequests.status, status))
      .orderBy(desc(roleRequests.createdAt))
      .limit(200);
    return c.json({
      success: true,
      total: rows.length,
      data: rows.map((r) => ({ ...r.req, user: r.user ? publicUser(r.user) : null })),
    });
  } catch (err) {
    console.error('[admin] requests failed', err); noteDbFailure();
    return c.json({ error: 'فشل الجلب' }, 500);
  }
});

const decideSchema = z.object({ decision: z.enum(['approve', 'reject']) });

// PUT /api/v1/admin/requests/:id — approve (sets flag) or reject
adminRouter.put('/requests/:id', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = decideSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'قرار غير صالح', issues: parsed.error.issues }, 400);
  const caller = c.get('caller');
  const rid = Number(c.req.param('id'));
  if (Number.isNaN(rid)) return c.json({ error: 'طلب غير صالح' }, 400);
  try {
    const found = await db.select().from(roleRequests).where(eq(roleRequests.id, rid)).limit(1);
    const req = found[0];
    if (!req) return c.json({ error: 'الطلب غير موجود' }, 404);
    if (req.status !== 'pending') return c.json({ success: true, message: 'تم البت في الطلب مسبقاً', data: req });
    const status = parsed.data.decision === 'approve' ? 'approved' : 'rejected';
    await db.update(roleRequests).set({ status, decidedBy: caller.row!.id, decidedAt: new Date() }).where(eq(roleRequests.id, rid));
    if (status === 'approved') {
      await db.update(users).set(
        req.kind === 'author' ? { isAuthor: true } : { isTranslator: true },
      ).where(eq(users.id, req.userId));
    }
    const updated = await db.select().from(roleRequests).where(eq(roleRequests.id, rid)).limit(1);
    return c.json({ success: true, data: updated[0] });
  } catch (err) {
    console.error('[admin] decide failed', err); noteDbFailure();
    return c.json({ error: 'فشل البت في الطلب' }, 500);
  }
});

// GET /api/v1/admin/novels — all novels with owner emails
adminRouter.get('/novels', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  try {
    const rows = await db.select().from(novels).orderBy(desc(novels.updatedAt)).limit(200);
    return c.json({
      success: true,
      total: rows.length,
      data: rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, status: r.status,
        totalChapters: r.totalChapters ?? 0, authorUserId: r.authorUserId, translatorUserId: r.translatorUserId,
        updatedAt: r.updatedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    console.error('[admin] novels failed', err); noteDbFailure();
    return c.json({ error: 'فشل الجلب' }, 500);
  }
});

