import { Hono } from 'hono';
import path from 'path';
import { requireAuthOrPat } from '../middleware/authorToken.js';
import { getEnv, getWorkerBinding, isWorkersRuntime } from '../config/env.js';
import { buildUploadFilename } from '../storage/objectStore.js';

export const uploadRouter = new Hono();

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
};
const KIND_FOLDER: Record<string, string> = { cover: 'covers', avatar: 'avatars', banner: 'banners' };

interface BucketLike {
  put: (key: string, body: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
}

async function putBinding(buffer: Buffer, key: string, mime: string): Promise<string | null> {
  const bucket = getWorkerBinding<BucketLike>('COVERS');
  if (!bucket) return null;
  await bucket.put(key, buffer, { httpMetadata: { contentType: mime } });
  return `/uploads/${key}`;
}

async function putR2(buffer: Buffer, key: string, mime: string): Promise<string | null> {
  const env = getEnv();
  if (!env.R2_ENDPOINT || !env.R2_BUCKET || !env.R2_ACCESS_KEY || !env.R2_SECRET_KEY) return null;
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: 'auto', endpoint: env.R2_ENDPOINT,
      credentials: { accessKeyId: env.R2_ACCESS_KEY, secretAccessKey: env.R2_SECRET_KEY } });
    await client.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: buffer, ContentType: mime }));
    return `${(env.R2_PUBLIC_URL ?? env.R2_ENDPOINT).replace(/\/$/, '')}/${key}`;
  } catch (err) {
    console.error('[upload] R2 failed, local fallback', err);
    return null;
  }
}

uploadRouter.post('/image', async (c, next) => {
  if (!getEnv().syncOpen) return requireAuthOrPat(c, next);
  await next();
}, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!file || !(file instanceof File)) return c.json({ success: false, error: 'لم يتم إرسال ملف صورة صالح' }, 400);
    if (!MIME_EXT[file.type]) return c.json({ success: false, error: 'نوع الصورة غير مدعوم (jpeg/png/webp/gif فقط)' }, 400);
    const folder = KIND_FOLDER[typeof body['kind'] === 'string' ? body['kind'] : 'cover'] ?? 'covers';
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > getEnv().UPLOAD_MAX_MB * 1024 * 1024) {
      return c.json({ success: false, error: `حجم الصورة يتجاوز ${getEnv().UPLOAD_MAX_MB}MB` }, 413);
    }
    const key = buildUploadFilename(folder, file.type);
    const filename = key.split('/').pop() ?? key;
    const bound = await putBinding(buffer, key, file.type).catch((err) => {
      console.error('[upload] binding failed', err);
      return null;
    });
    if (bound) return c.json({ success: true, message: 'تم رفع الصورة بنجاح', url: bound, filename });
    const remote = await putR2(buffer, key, file.type);
    if (remote) return c.json({ success: true, message: 'تم رفع الصورة بنجاح', url: remote, filename });
    if (isWorkersRuntime()) {
      return c.json({ success: false, error: 'image storage unavailable (database unreachable)' }, 503);
    }
    const { promises: fs } = await import('node:fs');
    const dir = path.resolve(process.cwd(), 'uploads', folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buffer);
    return c.json({ success: true, message: 'تم رفع الصورة بنجاح', url: `/uploads/${key}`, filename });
  } catch (error: any) {
    console.error('Upload Error:', error);
    return c.json({ success: false, error: error.message || 'فشل في رفع الصورة' }, 500);
  }
});
