import crypto from 'crypto';
import path from 'path';
import { getEnv, getWorkerBinding } from '../config/env.js';

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const KEY_RE = /^(covers|avatars|banners)\/[\w.\-]+\.(png|jpg|jpeg|webp|gif)$/i;
const REL_URL_RE = /^\/uploads\/(covers|avatars|banners)\/([\w.\-]+\.(png|jpg|jpeg|webp|gif))$/i;

export function buildUploadFilename(folder: string, mime: string): string {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error('unsupported mime');
  return `${folder}/${crypto.randomUUID()}${ext}`;
}

export function parseUploadKey(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!value) return null;
  const rel = REL_URL_RE.exec(value);
  if (rel) return `${rel[1]}/${rel[2]}`;
  try {
    const env = getEnv();
    for (const base of [env.R2_PUBLIC_URL, env.R2_ENDPOINT]) {
      if (!base) continue;
      const prefix = base.replace(/\/$/, '') + '/';
      if (value.startsWith(prefix)) {
        const rest = value.slice(prefix.length);
        if (KEY_RE.test(rest)) return rest;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function deleteUploadKey(key: string): Promise<void> {
  if (!KEY_RE.test(key)) return;
  try {
    const bucket = getWorkerBinding<{ delete: (k: string) => Promise<unknown> }>('COVERS');
    if (bucket) await bucket.delete(key).catch((err) => console.error('[upload] binding delete failed', err));
  } catch (err) {
    console.error('[upload] binding delete failed', err);
  }
  try {
    const env = getEnv();
    if (env.R2_ENDPOINT && env.R2_BUCKET && env.R2_ACCESS_KEY && env.R2_SECRET_KEY) {
      try {
        const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        const client = new S3Client({ region: 'auto', endpoint: env.R2_ENDPOINT,
          credentials: { accessKeyId: env.R2_ACCESS_KEY, secretAccessKey: env.R2_SECRET_KEY } });
        await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
      } catch (err) {
        console.error('[upload] R2 delete failed', err);
      }
    }
  } catch {
    return;
  }
  try {
    if (typeof process !== 'undefined' && process.cwd) {
      const { promises: fs } = await import('node:fs');
      await fs.unlink(path.resolve(process.cwd(), 'uploads', key)).catch(() => undefined);
    }
  } catch (err) {
    console.error('[upload] local delete failed', err);
  }
}
