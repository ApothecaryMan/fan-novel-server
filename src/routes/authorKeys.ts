import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { authorApiKeys } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import {
  generatePat,
  hashPat,
  MAX_ACTIVE_KEYS,
  PAT_PREFIX,
  PAT_SCOPE_WRITE,
} from '../middleware/authorToken.js';
import { getCaller } from '../middleware/ownership.js';

export const authorKeysRouter = new Hono();

// All key management requires a session JWT — a PAT can never mint/revoke keys.
authorKeysRouter.use('*', requireAuth);
authorKeysRouter.use('*', async (c, next) => {
  const auth = c.get('authUser') as { patKeyId?: string } | undefined;
  if (auth?.patKeyId) return c.json({ error: 'إدارة الرموز تتطلب تسجيل الدخول' }, 403);
  await next();
});

function toPublic(k: typeof authorApiKeys.$inferSelect) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.keyPrefix,
    scopes: k.scopes,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
  };
}

// POST /api/v1/author/keys — mint a key (plaintext returned once).
authorKeysRouter.post('/', async (c) => {
  const parsed = z.object({ name: z.string().min(1).max(100) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'اسم الرمز مطلوب' }, 400);
  if (!isDbAvailable()) return c.json({ error: 'قاعدة البيانات غير متاحة' }, 503);
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'غير مصرح: مطلوب تسجيل الدخول' }, 401);
  if (!caller.canWrite) return c.json({ error: 'غير مسموح: تحتاج إذن التأليف أو الترجمة' }, 403);
  try {
    const active = await db
      .select({ id: authorApiKeys.id })
      .from(authorApiKeys)
      .where(and(eq(authorApiKeys.userId, caller.row.id), isNull(authorApiKeys.revokedAt)));
    if (active.length >= MAX_ACTIVE_KEYS) {
      return c.json({ error: `الحد الأقصى ${MAX_ACTIVE_KEYS} رموز نشطة` }, 400);
    }
    const pat = generatePat();
    const inserted = await db
      .insert(authorApiKeys)
      .values({
        userId: caller.row.id,
        name: parsed.data.name,
        keyPrefix: pat.slice(0, PAT_PREFIX.length + 8),
        keyHash: await hashPat(pat),
        scopes: [PAT_SCOPE_WRITE],
      })
      .returning();
    return c.json({ success: true, key: toPublic(inserted[0]), token: pat }, 201);
  } catch (err) {
    console.error('[authorKeys] mint failed', err);
    noteDbFailure();
    return c.json({ error: 'تعذر إنشاء الرمز' }, 500);
  }
});

// GET /api/v1/author/keys — list (no hashes, no plaintext).
authorKeysRouter.get('/', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'قاعدة البيانات غير متاحة' }, 503);
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'غير مصرح: مطلوب تسجيل الدخول' }, 401);
  try {
    const rows = await db
      .select()
      .from(authorApiKeys)
      .where(and(eq(authorApiKeys.userId, caller.row.id), isNull(authorApiKeys.revokedAt)))
      .orderBy(desc(authorApiKeys.createdAt));
    return c.json({ success: true, data: rows.map(toPublic) });
  } catch (err) {
    console.error('[authorKeys] list failed', err);
    noteDbFailure();
    return c.json({ error: 'تعذر جلب الرموز' }, 500);
  }
});

// DELETE /api/v1/author/keys/:id — revoke immediately.
authorKeysRouter.delete('/:id', async (c) => {
  if (!isDbAvailable()) return c.json({ error: 'قاعدة البيانات غير متاحة' }, 503);
  const caller = await getCaller(c);
  if (!caller.row) return c.json({ error: 'غير مصرح: مطلوب تسجيل الدخول' }, 401);
  try {
    const found = await db.select().from(authorApiKeys).where(eq(authorApiKeys.id, c.req.param('id'))).limit(1);
    const row = found[0];
    if (!row || row.userId !== caller.row.id) return c.json({ error: 'الرمز غير موجود' }, 404);
    await db.update(authorApiKeys).set({ revokedAt: new Date() }).where(eq(authorApiKeys.id, row.id));
    return c.json({ success: true });
  } catch (err) {
    console.error('[authorKeys] revoke failed', err);
    noteDbFailure();
    return c.json({ error: 'تعذر إلغاء الرمز' }, 500);
  }
});
