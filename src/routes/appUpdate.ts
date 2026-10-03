import { Hono } from 'hono';
import { getEnv, getWorkerBinding } from '../config/env.js';

export const appUpdateRouter = new Hono();

const RELEASE_KEY = 'releases/latest.apk';
const APK_MIME = 'application/vnd.android.package-archive';

interface R2ObjectBodyLike {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
}

interface R2BucketLike {
  get: (key: string) => Promise<R2ObjectBodyLike | null>;
}

function releasesBucket(): R2BucketLike | null {
  return getWorkerBinding<R2BucketLike>('RELEASES');
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
 */
appUpdateRouter.get('/download', async (c) => {
  const bucket = releasesBucket();
  const object = bucket ? await bucket.get(RELEASE_KEY) : null;
  if (!object) return c.json({ success: false, error: 'not found' }, 404);

  c.header('Content-Type', object.httpMetadata?.contentType || APK_MIME);
  c.header('Content-Disposition', 'attachment; filename="fan-novel.apk"');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(object.body);
});
