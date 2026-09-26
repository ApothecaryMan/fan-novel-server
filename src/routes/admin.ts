import { Hono } from 'hono';
import { z } from 'zod';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { novels, roleRequests, subscriptionEvents, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getCaller } from '../middleware/ownership.js';
import { effectiveReadingPlan } from '../features/readingSync/freeStore.js';
import { parseAdminUserRoles } from './adminUserFilters.js';
import { escapeLikePattern } from './adminUserSearch.js';

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

/**
 * `count(*) over()` returns int8, which node-postgres parses as a STRING when
 * the pool has no custom type parsers (see db.ts: a bare `new pg.Pool(...)`),
 * while neon-http returns int8 as a JSON number. Without `.mapWith(Number)`
 * the same endpoint would answer `total` as a string on Node and a number on
 * Workers. Drizzle's `count()` maps to Number for us; a raw window count does
 * not, so we map it explicitly.
 */
const totalOver = sql<number>`count(*) over()`.mapWith(Number);

/**
 * Explicit projection for admin user reads. A bare `select()` hydrates
 * `passwordHash` and 14 `readingStats*` billing columns per row that
 * `publicUser` immediately discards. Keep this list and `publicUser` in sync:
 * `publicUser` is the response contract, this is the read path.
 */
const adminUserColumns = {
  id: users.id,
  externalId: users.externalId,
  email: users.email,
  username: users.username,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  bannerUrl: users.bannerUrl,
  bio: users.bio,
  role: users.role,
  isAuthor: users.isAuthor,
  isTranslator: users.isTranslator,
  createdAt: users.createdAt,
} as const;

/** Exactly the columns `adminUserColumns` projects, with their real types. */
type AdminUserRow = { [K in keyof typeof adminUserColumns]: typeof users.$inferSelect[K] };

/** Accepts the narrow projection or a full row, so both read paths share it. */
function publicUser(u: AdminUserRow) {
  return {
    id: u.id, externalId: u.externalId, email: u.email, username: u.username,
    displayName: u.displayName, avatarUrl: u.avatarUrl, bannerUrl: u.bannerUrl,
    bio: u.bio ?? null,
    role: u.role, isAuthor: u.isAuthor, isTranslator: u.isTranslator,
    createdAt: u.createdAt?.toISOString() ?? null,
  };
}

// GET /api/v1/admin/users?page&limit&q&roles (q searches email/username/displayName; roles is a CSV of admin, author, translator, reader)
adminRouter.get('/users', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const roleFilter = parseAdminUserRoles(c.req.query('roles'));
  if (roleFilter.invalid !== null) return c.json({ error: 'invalid role filter' }, 400);
  const roleClauses = roleFilter.roles.map((role) => {
    switch (role) {
      case 'admin': return eq(users.role, 'admin');
      case 'author': return eq(users.isAuthor, true);
      case 'translator': return eq(users.isTranslator, true);
      case 'reader': return and(eq(users.role, 'reader'), eq(users.isAuthor, false), eq(users.isTranslator, false));
    }
  });
  const roleWhere = roleClauses.length > 0 ? or(...roleClauses) : undefined;
  const searchWhere = q
    ? or(
        ilike(users.email, `%${escapeLikePattern(q)}%`),
        ilike(users.username, `%${escapeLikePattern(q)}%`),
        ilike(users.displayName, `%${escapeLikePattern(q)}%`),
      )
    : undefined;
  const where = roleWhere && searchWhere ? and(roleWhere, searchWhere) : roleWhere ?? searchWhere;
  try {
    // One round trip: the window count rides along with the page instead of
    // costing a second sequential query. `.where(undefined)` is valid here.
    const rows = await db
      .select({ ...adminUserColumns, total: totalOver })
      .from(users)
      .where(where)
      // desc(users.id) is a tie-break so ORDER BY is total: without it, rows
      // sharing a created_at can be skipped or duplicated across OFFSET pages.
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit)
      .offset((page - 1) * limit);
    // A window function is not evaluated when OFFSET runs past the end, so an
    // out-of-range page returns no rows and therefore no total. Contract: an
    // empty page reports total 0, and the client treats that as end-of-list.
    const total = rows[0]?.total ?? 0;
    return c.json({ success: true, total, data: rows.map(({ total: _total, ...row }) => publicUser(row)) });
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

const readingPlanGrantSchema = z.object({
  plan: z.enum(['pro', 'free']),
  durationDays: z.number().int().positive().max(365).optional().default(30),
  reason: z.string().trim().min(1).max(500),
});

// POST /api/v1/admin/users/:id/reading-plan — manual grant/revoke (no billing).
// Row-locked: SELECT FOR UPDATE inside the tx serializes concurrent grants so
// the second reads the first grant's expiry as its base (max(now, expiry)).
// Retries are additive by contract in v1: each grant intent extends again.
adminRouter.post('/users/:id/reading-plan', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  const parsed = readingPlanGrantSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid reading plan grant', issues: parsed.error.issues }, 400);
  const id = c.req.param('id');
  const caller = c.get('caller') as { row?: { id?: string } | null } | undefined;
  const actorId: string | null = caller?.row?.id ?? null;
  const now = Date.now();
  const durationDays = parsed.data.durationDays ?? 30;
  const durationMs = durationDays * 86_400_000;
  const reason = parsed.data.reason;
  try {
    const result = await db.transaction(async (tx) => {
      const locked = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1);
      const target = locked[0] as typeof users.$inferSelect | undefined;
      if (!target) return null;
      if (parsed.data.plan === 'free') {
        const [updated] = await tx.update(users).set({
          readingStatsPlan: 'free',
          readingStatsPlanExpiresAt: null,
          readingStatsGraceUntil: null,
          readingStatsPlanStatus: 'cancelled',
          updatedAt: new Date(),
        }).where(eq(users.id, id)).returning();
        await tx.insert(subscriptionEvents).values({
          userId: id,
          type: 'revoke',
          actorId,
          previousExpiresAt: target.readingStatsPlanExpiresAt ?? null,
          newExpiresAt: null,
          durationDays: null,
          reason,
          occurredAt: now,
        });
        return { updated, eventType: 'revoke' as const, expiresAt: null as number | null };
      }
      // Coerce corrupt expiry fail-closed: only a safe integer in the future
      // counts as a live window; anything else renews from now.
      const prev = target.readingStatsPlanExpiresAt;
      const livePrev = typeof prev === 'number' && Number.isSafeInteger(prev) && prev > now ? prev : null;
      const base = livePrev ?? now;
      const startedAt = livePrev !== null && typeof target.readingStatsPlanStartedAt === 'number'
        && Number.isSafeInteger(target.readingStatsPlanStartedAt)
        ? target.readingStatsPlanStartedAt
        : now;
      const expiresAt = base + durationMs;
      const hasHistory = (target.readingStatsRenewalCount ?? 0) > 0
        || (await tx.select({ id: subscriptionEvents.id }).from(subscriptionEvents)
          .where(and(eq(subscriptionEvents.userId, id), inArray(subscriptionEvents.type, ['grant', 'renew']))).limit(1)).length > 0;
      const eventType = hasHistory ? 'renew' : 'grant';
      const [updated] = await tx.update(users).set({
        readingStatsPlan: 'pro',
        readingStatsPlanStartedAt: startedAt,
        readingStatsPlanExpiresAt: expiresAt,
        readingStatsLastRenewedAt: now,
        readingStatsPlanDurationDays: durationDays,
        readingStatsPlanStatus: 'active',
        readingStatsRenewalCount: (target.readingStatsRenewalCount ?? 0) + 1,
        readingStatsTotalSubscribedMs: Number(target.readingStatsTotalSubscribedMs ?? 0) + durationMs,
        updatedAt: new Date(),
      }).where(eq(users.id, id)).returning();
      await tx.insert(subscriptionEvents).values({
        userId: id,
        type: eventType,
        actorId,
        previousExpiresAt: target.readingStatsPlanExpiresAt ?? null,
        newExpiresAt: expiresAt,
        durationDays,
        reason,
        occurredAt: now,
      });
      return { updated, eventType, expiresAt };
    });
    if (!result) return c.json({ error: 'المستخدم غير موجود' }, 404);
    const effectivePlan = effectiveReadingPlan(result.updated, Date.now());
    console.log(JSON.stringify({
      event: result.eventType === 'revoke' ? 'reading_plan.revoke' : 'reading_plan.grant',
      userId: id,
      plan: parsed.data.plan,
      durationDays: parsed.data.plan === 'pro' ? durationDays : undefined,
      expiresAt: result.expiresAt,
      actor: actorId,
    }));
    return c.json({
      success: true,
      effectivePlan,
      planExpiresAt: result.expiresAt,
      planStatus: (result.updated as typeof users.$inferSelect).readingStatsPlanStatus,
    });
  } catch (err) {
    console.error('[admin] reading-plan failed', err); noteDbFailure();
    return c.json({ error: 'فشل الحفظ' }, 500);
  }
});

// GET /api/v1/admin/novels — all novels with owner emails
adminRouter.get('/novels', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'database not configured' }, 503);
  try {
    const rows = await db.select().from(novels).orderBy(desc(novels.updatedAt)).limit(200);
    const ownerIds = [...new Set(rows.flatMap((r) => [r.authorUserId, r.translatorUserId]).filter(Boolean))] as string[];
    const emailById = new Map<string, string | null>();
    for (let i = 0; i < ownerIds.length; i += 100) {
      const chunk = ownerIds.slice(i, i + 100);
      const owners = await db.select({ id: users.id, email: users.email }).from(users).where(or(...chunk.map((id) => eq(users.id, id))));
      for (const o of owners) emailById.set(o.id, o.email ?? null);
    }
    return c.json({
      success: true,
      total: rows.length,
      data: rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, status: r.status,
        totalChapters: r.totalChapters ?? 0, authorUserId: r.authorUserId, translatorUserId: r.translatorUserId,
        authorEmail: r.authorUserId ? (emailById.get(r.authorUserId) ?? null) : null,
        translatorEmail: r.translatorUserId ? (emailById.get(r.translatorUserId) ?? null) : null,
        updatedAt: r.updatedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    console.error('[admin] novels failed', err); noteDbFailure();
    return c.json({ error: 'فشل الجلب' }, 500);
  }
});

