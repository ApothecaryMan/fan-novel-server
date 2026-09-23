import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { verifyGoogleIdToken } from './googleIdentity.js';
import { cleanBio, cleanMediaUrl, hasAnyAdmin, isUniqueConflict, resolveGoogleAccount } from './googleAccount.js';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { users } from '../database/schema.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { adminEmails, getEnv } from '../config/env.js';

export const authRouter = new Hono();

// Explicit development/test fixtures only. Never consult these in production.
const memUsers: any[] = [];

// Read-only memory-fixture lookup for the public profile route (non-prod, no DB).
// externalId match first (dev fixtures are keyed by externalId, with id === externalId),
// then id match; returns the stored object (do NOT mutate) or null.
export function findMemoryUser(raw: string): any | null {
  return memUsers.find((u) => u.externalId === raw) ?? memUsers.find((u) => u.id === raw) ?? null;
}

const googleSchema = z.object({
  name: z.string().max(100).optional(),
  username: z.string().regex(USERNAME_RE, 'اسم المستخدم: 3-20 حرف (أحرف وأرقام و_)').optional(),
  email: z.string().trim().email().max(255),
  avatarUrl: z.string().max(2000).optional(),
  bannerUrl: z.string().max(2000).optional(),
  googleId: z.string().max(255).optional(),
  idToken: z.string().optional(),
});

// Canonical handle rules live in ./usernames.js (mirrors the mobile app).
import { USERNAME_RE, UsernameTakenError, suggestUsernames } from './usernames.js';

function toPublic(u: any) {
  return {
    id: u.externalId ?? u.id, externalId: u.externalId ?? u.id, email: u.email,
    name: u.displayName ?? null, username: u.username ?? null,
    avatarUrl: u.avatarUrl, bannerUrl: u.bannerUrl ?? null,
    bio: u.bio ?? null, status: u.bio ?? null,
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
    // Seed-only bootstrap: ADMIN_EMAILS promotes only when zero admins exist.
    // After the first admin, all further grants go via DB (/admin UI or CLI).
    const bootstrapMatch = adminEmails().includes(email);
    let bootstrapAdmin = false;
    if (identity && isDbAvailable() && bootstrapMatch) {
      try {
        bootstrapAdmin = !(await hasAnyAdmin(db));
      } catch {
        bootstrapAdmin = false;
      }
    }
    if (identity && isDbAvailable()) {
      const row = await resolveGoogleAccount(db, identity, input, bootstrapAdmin, c.get('requestId') ?? crypto.randomUUID());
      const token = await signToken({ id: row.externalId!, email: row.email!, role: row.role });
      return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic(row), token });
    }
    if (env.isProd) return c.json({ error: 'account storage unavailable' }, 503);
    // Absent-token fixtures cannot read or write persistent accounts even if a DB exists.
    // Same seed-only rule in memory: first admin only, never re-promote.
    const memSeed = bootstrapMatch && !memUsers.some((u) => u.role === 'admin');
    let user = memUsers.find((u) => u.externalId === externalId);
    if (!user) {
      const displayName = (input.name || email.split('@')[0]).slice(0, 100);
      const explicit = typeof input.username === 'string' && USERNAME_RE.test(input.username) ? input.username : null;
      user = { id: externalId, externalId, googleSubject: identity?.sub ?? null, email,
        displayName, username: explicit, bio: null,
        avatarUrl: cleanMediaUrl(input.avatarUrl) ?? null, bannerUrl: cleanMediaUrl(input.bannerUrl) ?? null,
        role: memSeed ? 'admin' : 'reader' };
      memUsers.push(user);
    } else {
      user.email = email;
      if (memSeed) user.role = 'admin';
      if (input.name) user.displayName = input.name;
      if (input.username !== undefined && USERNAME_RE.test(input.username)) user.username = input.username;
      if (!cleanMediaUrl(user.avatarUrl)) user.avatarUrl = cleanMediaUrl(input.avatarUrl) ?? user.avatarUrl;
      if (!cleanMediaUrl(user.bannerUrl)) user.bannerUrl = cleanMediaUrl(input.bannerUrl) ?? user.bannerUrl;
    }
    const token = await signToken({ id: user.externalId, email: user.email, role: user.role });
    return c.json({ success: true, message: 'تم تسجيل الدخول بحساب Google بنجاح', user: toPublic(user), token });
  } catch (error) {
    if (error instanceof UsernameTakenError) {
      return c.json({ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions: error.suggestions }, 409);
    }
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

// GET /api/v1/auth/username/availability?username=<candidate>
// Authenticated single-candidate live check. 200 for both free and taken
// (taken is an expected answer, not an error); 400 for malformed input
// with no suggestions; 401 via requireAuth; 503 on storage failure.
authRouter.get('/username/availability', requireAuth, async (c) => {
  const sub = String(c.get('authUser')?.sub ?? '');
  const candidate = (c.req.query('username') ?? '').trim();
  if (!USERNAME_RE.test(candidate)) {
    return c.json({ error: 'اسم المستخدم: 3-20 حرف (أحرف وأرقام و_)' }, 400);
  }
  const memFallback = !isDbAvailable() || (!getEnv().isProd && sub.startsWith('dev_'));
  try {
    if (memFallback) {
      if (!isDbAvailable() && getEnv().isProd) return c.json({ error: 'account storage unavailable' }, 503);
      const taken = memUsers.some((u) => u.username === candidate);
      if (!taken) return c.json({ available: true, suggestions: [] });
      const suggestions = await suggestUsernames(candidate, async (name) => memUsers.some((u) => u.username === name));
      return c.json({ available: false, suggestions });
    }
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1);
    if (rows.length === 0) return c.json({ available: true, suggestions: [] });
    const suggestions = await suggestUsernames(candidate, async (name) =>
      (await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1)).length > 0);
    return c.json({ available: false, suggestions });
  } catch (error) {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    noteDbFailure();
    return c.json({ error: 'account storage unavailable' }, 503);
  }
});
// PATCH /api/v1/auth/me — explicit profile edit (display name, handle,
// bio/status, avatar, banner). Unlike POST /google (fill-or-heal), this overwrites:
// media URLs must be remote http(s) or server /uploads/covers/* — device file URIs are rejected.
const profilePatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  username: z.string().regex(USERNAME_RE, 'اسم المستخدم: 3-20 حرف (أحرف وأرقام و_)').optional(),
  bio: z.string().max(500).nullable().optional(),
  status: z.string().max(500).nullable().optional(),
  avatarUrl: z.string().max(2000).nullable().optional(),
  bannerUrl: z.string().max(2000).nullable().optional(),
});

authRouter.patch('/me', requireAuth, async (c) => {
  const payload = c.get('authUser') as { sub?: string };
  const sub = payload.sub ?? '';
  const parsed = profilePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'بيانات الملف الشخصي غير صالحة', issues: parsed.error.issues }, 400);
  const { name, username, bio, status, avatarUrl, bannerUrl } = parsed.data;
  const bioInput = bio !== undefined ? bio : status;
  if (name === undefined && username === undefined && bioInput === undefined && avatarUrl === undefined && bannerUrl === undefined) {
    return c.json({ error: 'لا يوجد ما يتم تحديثه' }, 400);
  }
  for (const [label, url] of [['avatarUrl', avatarUrl], ['bannerUrl', bannerUrl]] as const) {
    if (url !== undefined && url !== null && !cleanMediaUrl(url)) {
      return c.json({ error: `${label} يجب أن يكون رابط صورة http(s) أو /uploads/covers/` }, 400);
    }
  }
  if (bioInput !== undefined && bioInput !== null && cleanBio(bioInput) === undefined) {
    return c.json({ error: 'bio غير صالح' }, 400);
  }

  if (isDbAvailable() && (getEnv().isProd || !sub.startsWith('dev_'))) {
    try {
      const found = await db.select().from(users).where(eq(users.externalId, sub)).limit(1);
      const row = found[0];
      if (!row) return c.json({ error: 'account not found' }, 401);
      if (username !== undefined && username !== row.username) {
        const clash = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (clash[0]) {
          const suggestions = await suggestUsernames(username, async (name) =>
            (await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1)).length > 0);
          return c.json({ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions }, 409);
        }
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (username !== undefined) patch.username = username;
      if (name !== undefined) patch.displayName = name;
      if (bioInput !== undefined) patch.bio = cleanBio(bioInput);
      if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl === null ? null : cleanMediaUrl(avatarUrl);
      if (bannerUrl !== undefined) patch.bannerUrl = bannerUrl === null ? null : cleanMediaUrl(bannerUrl);
      const [updated] = await db.update(users).set(patch).where(eq(users.id, row.id)).returning();
      if (!updated) return c.json({ error: 'account not found' }, 401);
      return c.json({ success: true, user: toPublic({ ...updated, externalId: row.externalId }) });
    } catch (error) {
      if (isUniqueConflict(error) && username !== undefined) {
        try {
          const holder = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
          if (holder[0]) {
            const suggestions = await suggestUsernames(username, async (name) =>
              (await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1)).length > 0);
            return c.json({ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions }, 409);
          }
        } catch {
          noteDbFailure();
          return c.json({ error: 'account storage unavailable' }, 503);
        }
      }
      return accountError(c, error);
    }
  }

  if (getEnv().isProd) return c.json({ error: 'account storage unavailable' }, 503);
  const user = memUsers.find((u) => u.externalId === sub);
  if (!user) return c.json({ error: 'account not found' }, 401);
  if (username !== undefined) {
    if (memUsers.some((u) => u !== user && u.username === username)) {
      const suggestions = await suggestUsernames(username, async (name) => memUsers.some((u) => u.username === name));
      return c.json({ error: 'اسم المستخدم محجوز بالفعل', code: 'username_taken', suggestions }, 409);
    }
    user.username = username;
  }
  if (name !== undefined) user.displayName = name;
  if (bioInput !== undefined) user.bio = cleanBio(bioInput);
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl === null ? null : cleanMediaUrl(avatarUrl);
  if (bannerUrl !== undefined) user.bannerUrl = bannerUrl === null ? null : cleanMediaUrl(bannerUrl);
  return c.json({ success: true, user: toPublic(user) });
});
