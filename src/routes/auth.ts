import { Hono } from 'hono';
import { z } from 'zod';
import { eq, or } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { users } from '../database/schema.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { adminEmails, getEnv } from '../config/env.js';

export const authRouter = new Hono();

// Fallback when DB is unavailable
const memUsers: any[] = [];

const googleSchema = z.object({
  name: z.string().max(100).optional(),
  username: z.string().max(100).optional(),
  email: z.string().email().max(255),
  avatarUrl: z.string().max(2000).optional(),
  googleId: z.string().max(255).optional(),
  idToken: z.string().optional(),
});

async function verifyGoogleIdToken(idToken?: string): Promise<{ verified: boolean; email?: string; aud?: string }> {
  if (!idToken) return { verified: false };
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return { verified: false };
    const info: any = await res.json();
    return { verified: true, email: info.email, aud: info.aud };
  } catch {
    return { verified: false };
  }
}

function toPublic(u: any) {
  return {
    id: u.externalId ?? u.id, externalId: u.externalId ?? u.id, email: u.email,
    name: u.username ?? u.name, username: u.username ?? u.name, avatarUrl: u.avatarUrl,
    role: u.role ?? 'reader', isAuthor: Boolean(u.isAuthor), isTranslator: Boolean(u.isTranslator),
    provider: 'google',
  };
}

// POST /api/v1/auth/google
authRouter.post('/google', async (c) => {
  const parsed = googleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'البريد الإلكتروني مطلوب لتسجيل الدخول بحساب Google', issues: parsed.error.issues }, 400);
  const { name, username, email, avatarUrl, googleId, idToken } = parsed.data;
  const env = getEnv();

  if (env.isProd && (!env.JWT_SECRET || env.JWT_SECRET.startsWith('web-novel-dev-') || env.JWT_SECRET === 'change-me-in-production')) {
    return c.json({ error: 'تسجيل الدخول غير مهيأ في بيئة الإنتاج: JWT_SECRET غير مضبوط' }, 501);
  }

  const check = await verifyGoogleIdToken(idToken);
  if (!idToken) {
    if (env.isProd) return c.json({ error: 'رمز Google مطلوب لتسجيل الدخول' }, 400);
  } else {
    if (!check.verified) {
      if (env.isProd) return c.json({ error: 'تعذر التحقق من هوية Google' }, 401);
      console.warn(`[dev] idToken verification skipped for ${email}; trusting email only`);
    } else {
      const allowedAud = [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_ANDROID_CLIENT_ID].filter(Boolean) as string[];
      if (allowedAud.length > 0 && check.aud && !allowedAud.includes(check.aud)) {
        return c.json({ error: 'رمز Google صادر لتطبيق آخر' }, 401);
      }
      if (check.email && check.email.toLowerCase() !== email.toLowerCase()) {
        return c.json({ error: 'عدم تطابق البريد الإلكتروني في رمز Google' }, 400);
      }
    }
  }

  const externalId = `google_${googleId || email.toLowerCase()}`;
  const displayName = name || username || email.split('@')[0];

  if (isDbAvailable()) {
    try {
      const found = await db.select().from(users).where(or(eq(users.externalId, externalId), eq(users.email, email.toLowerCase()))).limit(1);
      let row = found[0];
      const bootstrapAdmin = adminEmails().includes(email.toLowerCase());
      if (!row) {
        const inserted = await db.insert(users).values({
          externalId, email: email.toLowerCase(),
          username: (username || displayName).slice(0, 100),
          avatarUrl: avatarUrl ?? null,
          role: bootstrapAdmin ? 'admin' : 'reader',
        }).returning();
        row = inserted[0];
      } else {
        const patch: Partial<typeof row> = { email: email.toLowerCase(), avatarUrl: avatarUrl ?? row.avatarUrl, updatedAt: new Date() };
        if (bootstrapAdmin && row.role !== 'admin') patch.role = 'admin';
        await db.update(users).set(patch).where(eq(users.id, row.id));
        row = { ...row, ...patch };
      }
      const token = await signToken({ id: externalId, email: row.email!, role: row.role ?? 'reader' });
      return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic({ ...row, externalId }), token });
    } catch (err) {
      console.error('[auth] db login failed, memory fallback', err); noteDbFailure();
    }
  }

  let user = memUsers.find((u) => u.email === email || u.externalId === externalId);
  if (!user) {
    user = { id: externalId, externalId, email, name: displayName, username: displayName, avatarUrl, role: 'reader', provider: 'google', createdAt: new Date().toISOString() };
    memUsers.push(user);
  } else {
    if (name) user.name = name;
    if (username) user.username = username;
    if (avatarUrl) user.avatarUrl = avatarUrl;
  }
  const token = await signToken({ id: user.externalId, email: user.email, role: user.role });
  return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user, token });
});

// GET /api/v1/auth/me
authRouter.get('/me', requireAuth, async (c) => {
  const payload = c.get('authUser') as { sub?: string };
  const sub = payload.sub ?? '';
  if (isDbAvailable()) {
    try {
      const found = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
      if (found[0]) return c.json({ user: toPublic(found[0]) });
    } catch (err) {
      console.error('[auth] db me failed', err); noteDbFailure();
    }
  }
  const user = memUsers.find((u) => u.id === sub || u.externalId === sub);
  if (!user) return c.json({ error: 'المستخدم غير موجود' }, 404);
  return c.json({ user });
});
