import type { MiddlewareHandler } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { db, isDbAvailable } from '../database/db.js';
import { authorApiKeys, users } from '../database/schema.js';
import { requireAuth } from './auth.js';

// ==========================================
// Author API tokens (PATs) for agent/MCP publishing.
// `fn_pat_<32B base64url>`; only sha256 hashes stored.
// Accepted ONLY on authoring routes; the owner's grant flags
// (isAuthor/isTranslator/admin) are still enforced downstream
// via getCaller/requireCreator/ensureNovelOwner.
// Key management (authorKeys route) requires a session JWT —
// a PAT can never mint another PAT.
// ==========================================

export const PAT_PREFIX = 'fn_pat_';
export const PAT_SCOPE_WRITE = 'novels:write';
export const MAX_ACTIVE_KEYS = 5;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a new plaintext PAT (returned once, never stored). */
export function generatePat(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return PAT_PREFIX + b64url(bytes);
}

/** sha256 hex of a PAT (what is stored/compared). */
export async function hashPat(pat: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pat));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function isPatFormat(token: string): boolean {
  return token.startsWith(PAT_PREFIX) && token.length > PAT_PREFIX.length + 20;
}

export interface PatResolution {
  ok: boolean;
  userExternalId?: string;
  keyId?: string;
  status?: number;
  error?: string;
}

/** Resolve a PAT to its owner's externalId. Fail-closed on any DB issue. */
export async function resolvePat(pat: string): Promise<PatResolution> {
  if (!isDbAvailable()) return { ok: false, status: 503, error: 'قاعدة البيانات غير متاحة' };
  try {
    const hash = await hashPat(pat);
    const rows = await db
      .select({ key: authorApiKeys, user: users })
      .from(authorApiKeys)
      .innerJoin(users, eq(authorApiKeys.userId, users.id))
      .where(and(eq(authorApiKeys.keyHash, hash), isNull(authorApiKeys.revokedAt)))
      .limit(1);
    const hit = rows[0];
    if (!hit || !hit.user.externalId) return { ok: false, status: 401, error: 'رمز النشر غير صالح' };
    const scopes = (hit.key.scopes ?? []) as string[];
    if (!scopes.includes(PAT_SCOPE_WRITE)) return { ok: false, status: 403, error: 'نطاق الرمز لا يسمح بالنشر' };
    // Touch last-used fire-and-forget (never blocks the request).
    // Wrapped in Promise.resolve: drizzle builders are thenables without a
    // guaranteed .catch at runtime.
    void Promise.resolve(
      db.update(authorApiKeys).set({ lastUsedAt: new Date() }).where(eq(authorApiKeys.id, hit.key.id))
    ).catch(() => {});
    return { ok: true, userExternalId: hit.user.externalId, keyId: hit.key.id };
  } catch (err) {
    console.error('[pat] resolve failed', err);
    return { ok: false, status: 503, error: 'تعذر التحقق من رمز النشر' };
  }
}

/**
 * Drop-in replacement for requireAuth on authoring routes:
 * PAT Bearer → resolve to owner sub; anything else → session JWT path.
 */
export const requireAuthOrPat: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (token && isPatFormat(token)) {
    const r = await resolvePat(token);
    if (!r.ok) return c.json({ error: r.error ?? 'رمز النشر غير صالح' }, (r.status ?? 401) as any);
    c.set('authUser', { sub: r.userExternalId, patKeyId: r.keyId });
    await next();
    return;
  }
  return requireAuth(c, next);
};
