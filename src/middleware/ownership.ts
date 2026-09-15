import type { Context, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db, isDbAvailable } from '../database/db.js';
import { novels, users } from '../database/schema.js';

export interface Caller {
  row: typeof users.$inferSelect | null;
  isAdmin: boolean;
  canWrite: boolean; // author, translator, or admin
}

/** Resolve the Bearer caller to its DB row. Token sub is the stable externalId. */
export async function getCaller(c: Context): Promise<Caller> {
  const payload = c.get('authUser') as { sub?: string } | undefined;
  const sub = payload?.sub ?? '';
  const empty: Caller = { row: null, isAdmin: false, canWrite: false };
  if (!sub || !isDbAvailable()) return empty;
  try {
    const found = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
    const row = found[0] ?? null;
    if (!row) return empty;
    const isAdmin = row.role === 'admin';
    return { row, isAdmin, canWrite: isAdmin || Boolean(row.isAuthor) || Boolean(row.isTranslator) };
  } catch {
    return empty;
  }
}

/** Require a logged-in user with author/translator/admin grant (any novel). */
export function requireCreator(kind: 'author' | 'translator'): MiddlewareHandler {
  return async (c, next) => {
    const caller = await getCaller(c);
    if (!caller.row) return c.json({ error: 'غير مصرح: مطلوب تسجيل الدخول' }, 401);
    const ok =
      caller.isAdmin || (kind === 'author' ? Boolean(caller.row.isAuthor) : Boolean(caller.row.isTranslator));
    if (!ok) return c.json({ error: 'غير مسموح: تحتاج إذن ' + (kind === 'author' ? 'التأليف' : 'الترجمة') }, 403);
    c.set('caller', caller);
    await next();
  };
}

/**
 * Require ownership of the target novel (`:id` or `:novelId`).
 * Legacy novels with no owner id are admin-only.
 */
export function ensureNovelOwner(): MiddlewareHandler {
  return async (c, next) => {
    const caller = await getCaller(c);
    if (!caller.row) return c.json({ error: 'غير مصرح: مطلوب تسجيل الدخول' }, 401);
    const novelId = c.req.param('id') ?? c.req.param('novelId');
    if (!novelId) return c.json({ error: 'الرواية غير محددة' }, 400);

    if (isDbAvailable()) {
      try {
        const rows = await db.select().from(novels).where(eq(novels.id, novelId)).limit(1);
        const novel = rows[0];
        if (!novel) return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);
        const ownerId = novel.authorUserId ?? novel.translatorUserId ?? null;
        if (caller.isAdmin || (ownerId && ownerId === caller.row.id)) {
          c.set('caller', caller);
          await next();
          return;
        }
        return c.json({ success: false, error: 'غير مسموح: ليست من إبداعاتك' }, 403);
      } catch (err) {
        console.error('[ownership] check failed', err);
      }
    }
    // Memory fallback (no DB): previous open behavior.
    c.set('caller', caller);
    await next();
  };
}

declare module 'hono' {
  interface ContextVariableMap {
    caller: Caller;
  }
}
