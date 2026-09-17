import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { verifyGoogleIdToken } from './googleIdentity.js';
import { cleanMediaUrl, isUniqueConflict, resolveGoogleAccount } from './googleAccount.js';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { users } from '../database/schema.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { adminEmails, getEnv } from '../config/env.js';

export const authRouter = new Hono();

// Explicit development/test fixtures only. Never consult these in production.
const memUsers: any[] = [];

const googleSchema = z.object({
  name: z.string().max(100).optional(),
  username: z.string().max(100).optional(),
  email: z.string().trim().email().max(255),
  avatarUrl: z.string().max(2000).optional(),
  bannerUrl: z.string().max(2000).optional(),
  googleId: z.string().max(255).optional(),
  idToken: z.string().optional(),
});

// Client display name / handle rules (mirrors the mobile app).
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function toPublic(u: any) {
  return {
    id: u.externalId ?? u.id, externalId: u.externalId ?? u.id, email: u.email,
    name: u.displayName ?? u.username ?? u.name, username: u.username ?? u.name,
    avatarUrl: u.avatarUrl, bannerUrl: u.bannerUrl ?? null,
    role: u.role ?? 'reader', isAuthor: Boolean(u.isAuthor), isTranslator: Boolean(u.isTranslator),
    provider: 'google',
  };
}

function accountError(c: import('hono').Context, error: unknown) {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (isUniqueConflict(error)) return c.json({ error: 'account identity conflict' }, 409);
  noteDbFailure();
  console.warn(JSON.stringify({ event: 'account.storage', requestId: c.get('requestId') ?? 'no-id', outcome: 'unavailable' }));
  return c.json({ error: 'account storage unavailable' }, 503);
}

// POST /api/v1/auth/google: client googleId never determines identity.
authRouter.post('/google', async (c) => {
  const parsed = googleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid Google login payload' }, 400);
  const input = parsed.data;
  const env = getEnv();
  const requestEmail = input.email.toLowerCase();
  try {
    const identity = input.idToken !== undefined ? await verifyGoogleIdToken(input.idToken) : null;
    if (!identity && env.isProd) return c.json({ error: 'Google token required' }, 401);
    if (identity && identity.email !== requestEmail) return c.json({ error: 'Google email mismatch' }, 400);
    const email = identity?.email ?? requestEmail;
    const externalId = identity ? `google_${identity.sub}` : `dev_${email}`;
    const bootstrapAdmin = adminEmails().includes(email);
    if (identity && isDbAvailable()) {
      const row = await resolveGoogleAccount(db, identity, input, bootstrapAdmin, c.get('requestId') ?? crypto.randomUUID());
      const token = await signToken({ id: row.externalId!, email: row.email!, role: row.role });
      return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic(row), token });
    }
    if (env.isProd) return c.json({ error: 'account storage unavailable' }, 503);
    // Absent-token fixtures cannot read or write persistent accounts even if a DB exists.
    let user = memUsers.find((u) => u.externalId === externalId);
    if (!user) {
      const displayName = input.name || input.username || email.split('@')[0];
      user = { id: externalId, externalId, googleSubject: identity?.sub ?? null, email,
        displayName, username: input.username || displayName,
        avatarUrl: cleanMediaUrl(input.avatarUrl) ?? null, bannerUrl: cleanMediaUrl(input.bannerUrl) ?? null,
        role: bootstrapAdmin ? 'admin' : 'reader' };
      memUsers.push(user);
    } else {
      user.email = email;
      if (bootstrapAdmin) user.role = 'admin';
      if (input.name) user.displayName = input.name;
      if (input.username) user.username = input.username;
      if (!cleanMediaUrl(user.avatarUrl)) user.avatarUrl = cleanMediaUrl(input.avatarUrl) ?? user.avatarUrl;
      if (!cleanMediaUrl(user.bannerUrl)) user.bannerUrl = cleanMediaUrl(input.bannerUrl) ?? user.bannerUrl;
    }
    const token = await signToken({ id: user.externalId, email: user.email, role: user.role });
    return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic(user), token });
  } catch (error) {
    return accountError(c, error);
  }
});

// GET /api/v1/auth/me: authoritative role and refreshed session.
authRouter.get('/me', requireAuth, async (c) => {
  const sub = String(c.get('authUser').sub ?? '');
  const env = getEnv();
  // A dev_ fixture is never resolved through persistent storage.
  if (isDbAvailable() && (env.isProd || !sub.startsWith('dev_'))) {
    try {
      const [row] = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
      if (!row) return c.json({ error: 'account not found' }, 401);
      const token = await signToken({ id: row.externalId!, email: row.email ?? '', role: row.role });
      return c.json({ user: toPublic(row), token });
    } catch (error) { return accountError(c, error); }
  }
  if (env.isProd) return c.json({ error: 'account storage unavailable' }, 503);
  const user = memUsers.find((u) => u.externalId === sub);
  if (!user) return c.json({ error: 'account not found' }, 401);
  const token = await signToken({ id: user.externalId, email: user.email, role: user.role });
  return c.json({ user: toPublic(user), token });
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

  if (isDbAvailable() && (getEnv().isProd || !sub.startsWith('dev_'))) {
    try {
      const found = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
      const row = found[0];
      if (!row) return c.json({ error: 'account not found' }, 401);
      if (username !== undefined && username !== row.username) {
        const clash = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (clash[0]) return c.json({ error: 'اسم المستخدم محجوز بالفعل' }, 409);
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (username !== undefined) patch.username = username;
      if (name !== undefined) patch.displayName = name;
      if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl === null ? null : cleanMediaUrl(avatarUrl);
      if (bannerUrl !== undefined) patch.bannerUrl = bannerUrl === null ? null : cleanMediaUrl(bannerUrl);
      const [updated] = await db.update(users).set(patch).where(eq(users.id, row.id)).returning();
      if (!updated) return c.json({ error: 'account not found' }, 401);
      return c.json({ success: true, user: toPublic({ ...updated, externalId: row.externalId }) });
    } catch (error) {
      return accountError(c, error);
    }
  }

  if (getEnv().isProd) return c.json({ error: 'account storage unavailable' }, 503);
  const user = memUsers.find((u) => u.externalId === sub);
  if (!user) return c.json({ error: 'account not found' }, 401);
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
