import type { MiddlewareHandler } from 'hono';
import { jwtVerify, SignJWT } from 'jose';

const DEV_SECRET = 'web-novel-dev-secret-change-me';

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET || DEV_SECRET);
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
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  if (!token) {
    return c.json({ error: 'غير مصرح: مطلوب رمز وصول' }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      issuer: 'web-novel',
      audience: 'web-novel-app'
    });
    c.set('authUser', payload);
    await next();
  } catch {
    return c.json({ error: 'رمز الوصول غير صالح أو منتهي الصلاحية' }, 401);
  }
};

declare module 'hono' {
  interface ContextVariableMap {
    authUser: Record<string, unknown>;
  }
}

/** Verify a Bearer token when present. Returns the subject or null
 *  (null = anonymous; callers decide whether that is allowed). */
export async function verifySubject(header: string | undefined): Promise<string | null> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      issuer: 'web-novel',
      audience: 'web-novel-app'
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}