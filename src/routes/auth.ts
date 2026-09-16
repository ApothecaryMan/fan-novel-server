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
  bannerUrl: z.string().max(2000).optional(),
  googleId: z.string().max(255).optional(),
  idToken: z.string().optional(),
});

// Client display name / handle rules (mirrors the mobile app).
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// Only remote URLs are ever persisted. Mobile clients historically sent
// device file URIs (file://, content://) that die with the device —
// storing them poisons the cross-install restore path, so they are
// dropped (never 400: old clients still send them).
function cleanMediaUrl(url?: string | null): string | undefined {
  if (typeof url !== 'string') return undefined;
  const v = url.trim();
  return /^https?:\/\//i.test(v) ? v.slice(0, 2000) : undefined;
}

/** Keep a stored remote URL; adopt an incoming remote URL when the stored
 *  one is missing or a dead device URI; never write device URIs. */
function keepRemoteOrHeal(stored?: string | null, incoming?: string | null): string | null | undefined {
  if (cleanMediaUrl(stored)) return undefined; // keep stored (no write)
  const fresh = cleanMediaUrl(incoming);
  return fresh ?? undefined; // adopt remote, or leave untouched
}

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
    name: u.displayName ?? u.username ?? u.name, username: u.username ?? u.name,
    avatarUrl: u.avatarUrl, bannerUrl: u.bannerUrl ?? null,
    role: u.role ?? 'reader', isAuthor: Boolean(u.isAuthor), isTranslator: Boolean(u.isTranslator),
    provider: 'google',
  };
}

// POST /api/v1/auth/google
authRouter.post('/google', async (c) => {
  const parsed = googleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'البريد الإلكتروني مطلوب لتسجيل الدخول بحساب Google', issues: parsed.error.issues }, 400);
  const { name, username, email, avatarUrl, bannerUrl, googleId, idToken } = parsed.data;
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
          displayName: (name || displayName).slice(0, 100),
          avatarUrl: cleanMediaUrl(avatarUrl) ?? null,
          bannerUrl: cleanMediaUrl(bannerUrl) ?? null,
          role: bootstrapAdmin ? 'admin' : 'reader',
        }).returning();
        row = inserted[0];
      } else {
        // Fill-or-heal only: a stored remote URL (e.g. a custom R2 avatar)
        // is never overwritten by the fresh Google photo. Device URIs are
        // never written.
        const patch: Partial<typeof row> = { email: email.toLowerCase(), updatedAt: new Date() };
        const healedAvatar = keepRemoteOrHeal(row.avatarUrl, avatarUrl);
        if (healedAvatar !== undefined) patch.avatarUrl = healedAvatar;
        const healedBanner = keepRemoteOrHeal(row.bannerUrl, bannerUrl);
        if (healedBanner !== undefined) patch.bannerUrl = healedBanner;
        if (bootstrapAdmin && row.role !== 'admin') patch.role = 'admin';
        await db.update(users).set(patch).where(eq(users.id, row.id));
        row = { ...row, ...patch };
      }
      // Stable identity: the token sub must be the stored externalId, not the
      // freshly computed one. Finding by email with a different googleId
      // (email-only first login, changed Google ID) otherwise mints a token
      // that getCaller can never resolve -> 401 'غير مصرح' on every
      // authenticated call (/me, /author/requests, /admin/*).
      const stableExternalId = row.externalId ?? externalId;
      const token = await signToken({ id: stableExternalId, email: row.email!, role: row.role ?? 'reader' });
      return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic({ ...row, externalId: stableExternalId }), token });
    } catch (err) {
      console.error('[auth] db login failed, memory fallback', err); noteDbFailure();
    }
  }

  let user = memUsers.find((u) => u.email === email || u.externalId === externalId);
  // Memory fallback must honor the same admin bootstrap as the DB path,
  // otherwise an admin email always logs in as reader when DATABASE_URL
  // is unset/down, and any in-memory promotion is lost on re-login.
  const memBootstrapAdmin = adminEmails().includes(email.toLowerCase());
  if (!user) {
    user = { id: externalId, externalId, email, name: displayName, displayName, username: username || displayName, avatarUrl: cleanMediaUrl(avatarUrl) ?? null, bannerUrl: cleanMediaUrl(bannerUrl) ?? null, role: memBootstrapAdmin ? 'admin' : 'reader', provider: 'google', createdAt: new Date().toISOString() };
    memUsers.push(user);
  } else {
    if (name) user.name = name;
    if (username) user.username = username;
    if (memBootstrapAdmin && user.role !== 'admin') user.role = 'admin';
    const healedAvatar = keepRemoteOrHeal(user.avatarUrl, avatarUrl);
    if (healedAvatar !== undefined) user.avatarUrl = healedAvatar;
    const healedBanner = keepRemoteOrHeal(user.bannerUrl, bannerUrl);
    if (healedBanner !== undefined) user.bannerUrl = healedBanner;
  }
  const token = await signToken({ id: user.externalId, email: user.email, role: user.role });
  return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user, token });
});

// GET /api/v1/auth/me — returns the authoritative DB role plus a freshly
// signed token, so a client holding a stale pre-grant token self-heals
// (role upgrades included) by refetching /me on app startup.
authRouter.get('/me', requireAuth, async (c) => {
  const payload = c.get('authUser') as { sub?: string };
  const sub = payload.sub ?? '';
  if (isDbAvailable()) {
    try {
      const found = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
      if (found[0]) {
        const row = found[0];
        const fresh = await signToken({ id: row.externalId ?? sub, email: row.email!, role: row.role ?? 'reader' });
        return c.json({ user: toPublic(row), token: fresh });
      }
    } catch (err) {
      console.error('[auth] db me failed', err); noteDbFailure();
    }
  }
  const user = memUsers.find((u) => u.id === sub || u.externalId === sub);
  if (!user) return c.json({ error: 'المستخدم غير موجود' }, 404);
  const fresh = await signToken({ id: user.externalId, email: user.email, role: user.role ?? 'reader' });
  return c.json({ user, token: fresh });
});

// PATCH /api/v1/auth/me — explicit profile edit (display name, handle,
// avatar, banner). Unlike POST /google (fill-or-heal), this overwrites:
// media URLs must be remote http(s) — device file URIs are rejected.
const profilePatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  username: z.string().regex(USERNAME_RE, 'اسم المستخدم: 3-20 حرف (أحرف وأرقام و_)').optional(),
  avatarUrl: z.string().max(2000).nullable().optional(),
  bannerUrl: z.string().max(2000).nullable().optional(),
});

authRouter.patch('/me', requireAuth, async (c) => {
  const payload = c.get('authUser') as { sub?: string };
  const sub = payload.sub ?? '';
  const parsed = profilePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'بيانات الملف الشخصي غير صالحة', issues: parsed.error.issues }, 400);
  const { name, username, avatarUrl, bannerUrl } = parsed.data;
  if (name === undefined && username === undefined && avatarUrl === undefined && bannerUrl === undefined) {
    return c.json({ error: 'لا يوجد ما يتم تحديثه' }, 400);
  }
  for (const [label, url] of [['avatarUrl', avatarUrl], ['bannerUrl', bannerUrl]] as const) {
    if (url !== undefined && url !== null && !cleanMediaUrl(url)) {
      return c.json({ error: `${label} يجب أن يكون رابط صورة http(s)` }, 400);
    }
  }

  if (isDbAvailable()) {
    try {
      const found = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
      const row = found[0];
      if (!row) return c.json({ error: 'المستخدم غير موجود' }, 404);
      if (username !== undefined && username !== row.username) {
        const clash = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (clash[0]) return c.json({ error: 'اسم المستخدم محجوز بالفعل' }, 409);
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (username !== undefined) patch.username = username;
      if (name !== undefined) patch.displayName = name;
      if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl === null ? null : cleanMediaUrl(avatarUrl);
      if (bannerUrl !== undefined) patch.bannerUrl = bannerUrl === null ? null : cleanMediaUrl(bannerUrl);
      await db.update(users).set(patch).where(eq(users.id, row.id));
      const updated = { ...row, ...patch };
      return c.json({ success: true, user: toPublic({ ...updated, externalId: row.externalId }) });
    } catch (err) {
      console.error('[auth] db profile patch failed', err); noteDbFailure();
      return c.json({ error: 'تعذر تحديث الملف الشخصي' }, 500);
    }
  }

  const user = memUsers.find((u) => u.id === sub || u.externalId === sub);
  if (!user) return c.json({ error: 'المستخدم غير موجود' }, 404);
  if (username !== undefined) {
    if (memUsers.some((u) => u !== user && u.username === username)) {
      return c.json({ error: 'اسم المستخدم محجوز بالفعل' }, 409);
    }
    user.username = username;
  }
  if (name !== undefined) user.displayName = name;
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl === null ? null : cleanMediaUrl(avatarUrl);
  if (bannerUrl !== undefined) user.bannerUrl = bannerUrl === null ? null : cleanMediaUrl(bannerUrl);
  return c.json({ success: true, user: toPublic(user) });
});
