import { Hono } from 'hono';
import { getEnv } from '../config/env.js';

export const appConfigRouter = new Hono();

const DEFAULT_EXTENSIONS_REPO_URL =
  'https://raw.githubusercontent.com/ApothecaryMan/fan-novel-extensions/main/docs';

/**
 * Public app configuration consumed by GET /api/v1/app/config on the client.
 *
 * The extension repository URL and the Browse tab flag live in Worker vars so
 * they can change without an app release. The signing key is deliberately not
 * served here: the app keeps it bundled, so a different repo URL still has to
 * serve an index signed by the same key.
 */
appConfigRouter.get('/config', (c) => {
  const env = getEnv();
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    success: true,
    data: {
      extensions: {
        repoUrl: env.EXTENSIONS_REPO_URL || DEFAULT_EXTENSIONS_REPO_URL,
        catalogEnabled: env.EXTENSIONS_CATALOG_ENABLED !== 'false',
      },
    },
  });
});
