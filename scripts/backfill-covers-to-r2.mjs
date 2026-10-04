#!/usr/bin/env node
// Backfill cover/avatar/banner files from Postgres cover_blobs + local disk to R2.
// Reads prefer R2 already (src/app.ts GET /uploads), so every key moved here
// removes one Neon blob read per image view. Safe to re-run: skips keys
// already present in the bucket. Never deletes DB rows; they stay as fallback.
// Usage:
//   R2_ENDPOINT=... R2_BUCKET=... R2_ACCESS_KEY=... R2_SECRET_KEY=... node scripts/backfill-covers-to-r2.mjs [--dry-run]
//   DATABASE_URL=... (optional; skips DB blobs when unset)
import 'dotenv/config';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import pg from 'pg';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const dryRun = process.argv.includes('--dry-run');
const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY, R2_SECRET_KEY } = process.env;
if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY || !R2_SECRET_KEY) {
  console.error('Missing R2 env (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY, R2_SECRET_KEY). See .env.example.');
  process.exit(2);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

let uploaded = 0, skipped = 0, failed = 0;

async function putIfMissing(key, bytes, mime) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    skipped += 1;
    return;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode !== 404 && err?.name !== 'NotFound' && err?.name !== 'NoSuchKey') throw err;
  }
  if (dryRun) {
    uploaded += 1;
    console.log(`[dry-run] would upload ${key}`);
    return;
  }
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: bytes, ContentType: mime }));
  uploaded += 1;
}

const folders = ['covers', 'avatars', 'banners'];
const mimeByExt = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

for (const folder of folders) {
  const dir = path.resolve(process.cwd(), 'uploads', folder);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    continue;
  }
  for (const name of names) {
    if (!/^[\w.-]+\.(png|jpg|jpeg|webp|gif)$/i.test(name)) continue;
    try {
      const buf = await fs.readFile(path.join(dir, name));
      await putIfMissing(`${folder}/${name}`, buf, mimeByExt[path.extname(name).toLowerCase()] ?? 'image/png');
    } catch (err) {
      failed += 1;
      console.error(`disk ${folder}/${name} failed:`, err.message ?? err);
    }
  }
}

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query('SELECT filename, mime, data_base64 FROM cover_blobs');
    for (const r of rows) {
      const folder = r.filename.includes('/') ? r.filename.split('/')[0] : 'covers';
      const key = r.filename.includes('/') ? r.filename : `${folder}/${r.filename}`;
      if (!/^[\w.-]+\.(png|jpg|jpeg|webp|gif)$/i.test(key.split('/').pop() ?? '')) continue;
      try {
        await putIfMissing(key, Buffer.from(r.data_base64, 'base64'), r.mime);
      } catch (err) {
        failed += 1;
        console.error(`db ${key} failed:`, err.message ?? err);
      }
    }
    console.log(`db blobs scanned: ${rows.length}`);
  } finally {
    await pool.end().catch(() => {});
  }
} else {
  console.log('DATABASE_URL unset — db blobs skipped');
}

console.log(JSON.stringify({ uploaded, skipped, failed, dryRun }, null, 2));
process.exit(failed ? 1 : 0);
