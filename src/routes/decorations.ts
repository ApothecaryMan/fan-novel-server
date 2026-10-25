import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { getEnv, getWorkerBinding } from '../config/env.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const SIGN_TTL_SECONDS = 300;

const AVATAR_RE = /^fan_avatar\/[^/]{1,100}\.png$/i;
const FRAME_RE = /^profile_frames\/[^/]{1,100}\.png$/i;
const EFFECT_RE = /^profile_effects\/[^/]{1,100}\/[^/]{1,100}\.(png|webp|gif)$/i;
const MANIFEST_RE = /^(fan_avatar|profile_frames|profile_effects)\/manifest\.json$/i;

export function isDecorationKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (key.length < 1 || key.length > 200) return false;
  if (key.includes('..')) return false;
  return AVATAR_RE.test(key) || FRAME_RE.test(key) || EFFECT_RE.test(key) || MANIFEST_RE.test(key);
}

function getSecret(): string | null {
  const s = getEnv().JWT_SECRET;
  if (!s || !s.trim()) return null;
  return s;
}

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

interface BucketLike {
  get: (key: string) => Promise<{ body: ReadableStream | null; httpMetadata?: { contentType?: string } } | null>;
}

export const decorationsRouter = new Hono();

decorationsRouter.get('/sign', requireAuth, rateLimit(30), async (c) => {
  const secret = getSecret();
  if (!secret) return c.json({ error: 'signer unavailable' }, 503);
  const key = (c.req.query('key') ?? '').trim();
  if (!isDecorationKey(key)) return c.json({ error: 'invalid key' }, 400);
  const exp = Math.floor(Date.now() / 1000) + SIGN_TTL_SECONDS;
  const sig = hmacHex(secret, `${key}|${exp}`);
  const url = `/api/v1/decorations/file?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
  return c.json({ success: true, url, expiresIn: SIGN_TTL_SECONDS, exp });
});

decorationsRouter.get('/thumb', rateLimit(120), async (c) => {
  const key = (c.req.query('key') ?? '').trim();
  if (!isDecorationKey(key)) return c.json({ error: 'invalid key' }, 400);
  const bucket = getWorkerBinding<BucketLike>('DECORATIONS');
  if (!bucket) return c.json({ error: 'storage unavailable' }, 503);
  const obj = await bucket.get(key).catch(() => null);
  if (!obj || !obj.body) return c.json({ error: 'not found' }, 404);
  const type = obj.httpMetadata?.contentType ?? 'image/png';
  return new Response(obj.body as ReadableStream, {
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' },
  });
});

decorationsRouter.get('/file', rateLimit(120), async (c) => {
  const secret = getSecret();
  if (!secret) return c.json({ error: 'signer unavailable' }, 503);
  const key = (c.req.query('key') ?? '').trim();
  const expRaw = (c.req.query('exp') ?? '').trim();
  const sig = (c.req.query('sig') ?? '').trim();
  if (!isDecorationKey(key)) return c.json({ error: 'invalid key' }, 400);
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp <= 0) return c.json({ error: 'invalid exp' }, 401);
  if (exp * 1000 <= Date.now()) return c.json({ error: 'expired' }, 401);
  if (!/^[0-9a-f]{64}$/i.test(sig)) return c.json({ error: 'invalid sig' }, 401);
  const expected = hmacHex(secret, `${key}|${exp}`);
  if (!safeEqualHex(expected.toLowerCase(), sig.toLowerCase())) return c.json({ error: 'invalid sig' }, 401);
  const bucket = getWorkerBinding<BucketLike>('DECORATIONS');
  if (!bucket) return c.json({ error: 'storage unavailable' }, 503);
  const obj = await bucket.get(key).catch(() => null);
  if (!obj || !obj.body) return c.json({ error: 'not found' }, 404);
  const type = obj.httpMetadata?.contentType ?? 'image/png';
  return new Response(obj.body as ReadableStream, {
    headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=300' },
  });
});
