import type { MiddlewareHandler } from 'hono';
import { jwtVerify, SignJWT } from 'jose';
import { getEnv } from '../config/env.js';

const DEV_SECRET = 'web-novel-dev-secret-change-me';

function getSecretKey(): Uint8Array {
  const env = getEnv();
  const s = env.JWT_SECRET ?? (env.isProd ? '' : DEV_SECRET);
  return new TextEncoder().encode(s);
}

export async function signToken(user: {
  id: string;
  email: string;
  role: string;
}): Promise<string> {
  return new SignJWT({ sub: user.id, email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('web-novel')
    .setAudience('web-novel-app')
    .setExpirationTime('7d')
    .sign(getSecretKey());
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const key = getSecretKey();
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  if (!token) {
    return c.json({ error: 'غير مصرح: مطلوب رمز وصول' }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: 'web-novel',
      audience: 'web-novel-app'
    });
    c.set('authUser', payload);
  } catch {
    return c.json({ error: 'رمز الوصول غير صالح أو منتهي الصلاحية' }, 401);
  }
  await next();
};

declare module 'hono' {
  interface ContextVariableMap {
    authUser: Record<string, unknown>;
  }
}

/** Verify a Bearer token when present. Returns the subject or null
 *  (null = anonymous; callers decide whether that is allowed). */
export async function verifySubject(header: string | undefined): Promise<string | null> {
  const key = getSecretKey();
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: 'web-novel',
      audience: 'web-novel-app'
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}