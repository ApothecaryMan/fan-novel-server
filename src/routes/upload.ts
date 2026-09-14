import { Hono } from 'hono';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';

export const uploadRouter = new Hono();

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads', 'covers');
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(console.error);

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

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
  if (!getEnv().syncOpen) return requireAuth(c, next);
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

    let ext = '.png';
    if (file.type === 'image/jpeg') ext = '.jpg';
    else if (file.type === 'image/webp') ext = '.webp';
    else if (file.type === 'image/gif') ext = '.gif';
    const filename = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;

    const remote = await uploadToR2(buffer, filename, file.type);
    if (remote) return c.json({ success: true, message: 'تم رفع صورة الغلاف بنجاح', url: remote, filename });

    await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
    return c.json({ success: true, message: 'تم رفع صورة الغلاف بنجاح', url: `/uploads/covers/${filename}`, filename });
  } catch (error: any) {
    console.error('Upload Error:', error);
    return c.json({ success: false, error: error.message || 'فشل في رفع الصورة' }, 500);
  }
});
