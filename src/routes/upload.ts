import { Hono } from 'hono';
import path from 'path';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { coverBlobs } from '../database/schema.js';
import { requireAuthOrPat } from '../middleware/authorToken.js';
import { getEnv, getWorkerBinding, isWorkersRuntime } from '../config/env.js';

export const uploadRouter = new Hono();

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
};

interface R2BucketLike {
  put: (key: string, body: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
  get: (key: string) => Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
}

function coversBucket(): R2BucketLike | null {
  return getWorkerBinding<R2BucketLike>('COVERS');
}

async function uploadToBinding(buffer: Buffer, filename: string, mime: string): Promise<string | null> {
  const bucket = coversBucket();
  if (!bucket) return null;
  await bucket.put(`covers/${filename}`, buffer, { httpMetadata: { contentType: mime } });
  // Served back through this same Worker (no public bucket needed).
  return `/uploads/covers/${filename}`;
}

async function uploadToR2(buffer: Buffer, filename: string, mime: string): Promise<string | null> {
  const env = getEnv();
  if (!env.R2_ENDPOINT || !env.R2_BUCKET || !env.R2_ACCESS_KEY || !env.R2_SECRET_KEY) return null;
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT,
      credentials: { accessKeyId: env.R2_ACCESS_KEY, secretAccessKey: env.R2_SECRET_KEY },
    });
    await client.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: `covers/${filename}`, Body: buffer, ContentType: mime }));
    const base = (env.R2_PUBLIC_URL ?? env.R2_ENDPOINT).replace(/\/$/, '');
    return `${base}/covers/${filename}`;
  } catch (err) {
    console.error('[upload] R2 failed, local fallback', err);
    return null;
  }
}

// POST /api/v1/upload/cover (auth required when SYNC_OPEN=false, open LAN otherwise)
uploadRouter.post('/cover', async (c, next) => {
  if (!getEnv().syncOpen) return requireAuthOrPat(c, next);
  await next();
}, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!file || !(file instanceof File)) return c.json({ success: false, error: 'لم يتم إرسال ملف صورة صالح' }, 400);
    if (!ALLOWED.has(file.type)) return c.json({ success: false, error: 'نوع الصورة غير مدعوم (jpeg/png/webp/gif فقط)' }, 400);

    const maxBytes = getEnv().UPLOAD_MAX_MB * 1024 * 1024;
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > maxBytes) return c.json({ success: false, error: `حجم الصورة يتجاوز ${getEnv().UPLOAD_MAX_MB}MB` }, 413);

    const filename = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ALLOWED_EXT[file.type] ?? '.png'}`;

    // 1. Workers R2 binding (private bucket, served via GET below).
    const bound = await uploadToBinding(buffer, filename, file.type).catch((err) => {
      console.error('[upload] binding failed', err);
      return null;
    });
    if (bound) return c.json({ success: true, message: 'تم رفع صورة الغلاف بنجاح', url: bound, filename });

    // 2. S3-compatible endpoint (R2 API token / any S3).
    const remote = await uploadToR2(buffer, filename, file.type);
    if (remote) return c.json({ success: true, message: 'تم رفع صورة الغلاف بنجاح', url: remote, filename });

    // 3. Postgres blob (works everywhere including Workers; ~2500 covers per 0.5GB).
    if (isDbAvailable()) {
      try {
        await db.insert(coverBlobs).values({ filename, mime: file.type, dataBase64: buffer.toString('base64') });
        return c.json({ success: true, message: 'تم رفع صورة الغلاف بنجاح', url: `/uploads/covers/${filename}`, filename });
      } catch (err) {
        console.error('[upload] db blob failed', err); noteDbFailure();
      }
    }

    // 4. Local disk (Node only).
    if (isWorkersRuntime()) {
      return c.json({ success: false, error: 'cover storage unavailable (database unreachable)' }, 503);
    }
    const { promises: fs } = await import('node:fs');
    const dir = path.resolve(process.cwd(), 'uploads', 'covers');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buffer);
    return c.json({ success: true, message: 'تم رفع صورة الغلاف بنجاح', url: `/uploads/covers/${filename}`, filename });
  } catch (error: any) {
    console.error('Upload Error:', error);
    return c.json({ success: false, error: error.message || 'فشل في رفع الصورة' }, 500);
  }
});
