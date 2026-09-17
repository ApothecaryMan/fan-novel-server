import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { getEnv } from '../config/env.js';

export type VerifiedGoogleIdentity = { sub: string; email: string };
const claims = z.object({
  sub: z.string().min(1).max(248).refine((v) => v.trim() === v && v.trim().length > 0),
  email: z.string().trim().toLowerCase().email().max(255),
  aud: z.string().min(1),
  iss: z.enum(['accounts.google.com', 'https://accounts.google.com']),
  email_verified: z.union([z.literal(true), z.literal('true')]),
  exp: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .refine((v) => Number.isSafeInteger(v) && v > Date.now() / 1000),
});

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleIdentity> {
  if (!idToken.trim()) throw new HTTPException(401, { message: 'invalid Google credentials' });
  const env = getEnv();
  const audiences = [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_ANDROID_CLIENT_ID]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  let response: Response;
  try {
    response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HTTPException(503, { message: 'identity service unavailable' });
  }
  if (response.status >= 500 || response.status === 429) {
    throw new HTTPException(503, { message: 'identity service unavailable' });
  }
  if (!response.ok) throw new HTTPException(401, { message: 'invalid Google credentials' });
  const parsed = claims.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !audiences.includes(parsed.data.aud)) {
    throw new HTTPException(401, { message: 'invalid Google credentials' });
  }
  return { sub: parsed.data.sub, email: parsed.data.email };
}
