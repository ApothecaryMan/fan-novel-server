import { Hono } from 'hono';
import { getEnv } from '../config/env.js';

export const appUpdateRouter = new Hono();

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
