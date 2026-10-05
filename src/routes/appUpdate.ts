import { Hono } from 'hono';
import { getEnv, getWorkerBinding } from '../config/env.js';

export const appUpdateRouter = new Hono();

const RELEASE_KEY = 'releases/latest.apk';
const APK_MIME = 'application/vnd.android.package-archive';

interface R2ObjectBodyLike {
  body: ReadableStream;
  size: number;
  etag?: string;
  httpMetadata?: { contentType?: string };
}

interface R2HeadLike {
  size: number;
  etag?: string;
  httpMetadata?: { contentType?: string };
}

interface R2BucketLike {
  get: (
    key: string,
    options?: { range?: { offset?: number; length?: number } },
  ) => Promise<R2ObjectBodyLike | null>;
  head: (key: string) => Promise<R2HeadLike | null>;
}

function releasesBucket(): R2BucketLike | null {
  return getWorkerBinding<R2BucketLike>('RELEASES');
}

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;
  let start: number;
  let end: number;
  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    end = Math.min(end, size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Public app-release metadata. The mobile app polls this on launch and shows an
 * update dialog when `latestVersion` is newer than the installed version.
 *
 * Values come from Worker vars (wrangler.toml [vars]) so announcing a release
 * needs no code change: set APP_LATEST_VERSION / APP_UPDATE_URL, then deploy.
 * An empty APP_LATEST_VERSION means "no update" and the app stays silent.
 *
 * `minVersion` (optional) forces the update: anything below it cannot dismiss
 * the dialog. `notes` is a `|`-separated list of short lines.
 */
appUpdateRouter.get('/version', (c) => {
  const env = getEnv();
  const notes = env.APP_UPDATE_NOTES
    ? env.APP_UPDATE_NOTES.split('|').map((line) => line.trim()).filter(Boolean)
    : [];

  return c.json({
    success: true,
    data: {
      latestVersion: env.APP_LATEST_VERSION,
      minVersion: env.APP_MIN_VERSION || null,
      downloadUrl: env.APP_UPDATE_URL || null,
      force: env.APP_UPDATE_FORCE === 'true',
      notes,
      apkSha256: env.APP_APK_SHA256 || null,
    },
  });
});

/**
 * Streams the latest release APK from the private R2 bucket. APP_UPDATE_URL
 * points here, so the URL is stable across releases: overwrite the
 * `releases/latest.apk` object and bump APP_LATEST_VERSION, then deploy.
 *
 * Always sends Content-Length (the mobile progress bar needs it) and supports
 * single byte ranges (206) so interrupted downloads can resume.
 */
appUpdateRouter.on(['GET', 'HEAD'], '/download', async (c) => {
  const bucket = releasesBucket();

  if (c.req.method === 'HEAD') {
    const meta = bucket ? await bucket.head(RELEASE_KEY) : null;
    if (!meta) return c.json({ success: false, error: 'not found' }, 404);
    c.header('Content-Type', meta.httpMetadata?.contentType || APK_MIME);
    c.header('Content-Length', String(meta.size));
    c.header('Accept-Ranges', 'bytes');
    if (meta.etag) c.header('ETag', meta.etag);
    c.header('Cache-Control', 'no-store');
    return c.body(null);
  }

  const rangeHeader = c.req.header('Range');
  if (!rangeHeader) {
    const object = bucket ? await bucket.get(RELEASE_KEY) : null;
    if (!object) return c.json({ success: false, error: 'not found' }, 404);
    c.header('Content-Type', object.httpMetadata?.contentType || APK_MIME);
    c.header('Content-Disposition', 'attachment; filename="fan-novel.apk"');
    c.header('Content-Length', String(object.size));
    c.header('Accept-Ranges', 'bytes');
    if (object.etag) c.header('ETag', object.etag);
    c.header('Cache-Control', 'no-store');
    return c.body(object.body);
  }

  const probe = bucket ? await bucket.head(RELEASE_KEY) : null;
  if (!probe) return c.json({ success: false, error: 'not found' }, 404);
  const parsed = parseRange(rangeHeader, probe.size);
  if (parsed === 'unsatisfiable') {
    c.header('Content-Range', `bytes */${probe.size}`);
    return c.body(null, 416);
  }
  if (!parsed) {
    const object = bucket ? await bucket.get(RELEASE_KEY) : null;
    if (!object) return c.json({ success: false, error: 'not found' }, 404);
    c.header('Content-Type', object.httpMetadata?.contentType || APK_MIME);
    c.header('Content-Disposition', 'attachment; filename="fan-novel.apk"');
    c.header('Content-Length', String(object.size));
    c.header('Accept-Ranges', 'bytes');
    if (object.etag) c.header('ETag', object.etag);
    c.header('Cache-Control', 'no-store');
    return c.body(object.body);
  }

  const object = bucket
    ? await bucket.get(RELEASE_KEY, {
        range: { offset: parsed.start, length: parsed.end - parsed.start + 1 },
      })
    : null;
  if (!object) return c.json({ success: false, error: 'not found' }, 404);
  c.header('Content-Type', object.httpMetadata?.contentType || APK_MIME);
  c.header('Content-Disposition', 'attachment; filename="fan-novel.apk"');
  c.header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${probe.size}`);
  c.header('Content-Length', String(parsed.end - parsed.start + 1));
  c.header('Accept-Ranges', 'bytes');
  if (object.etag) c.header('ETag', object.etag);
  c.header('Cache-Control', 'no-store');
  return c.body(object.body, 206);
});
