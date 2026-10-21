import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';

function app(overrides: Record<string, string> = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setWorkerEnv({
    ...productionBindings,
    NODE_ENV: 'development',
    SYNC_OPEN: 'true',
    DATABASE_URL: undefined,
    ...overrides,
  });
  return createApp();
}

describe('GET /api/v1/app/config', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serves the default catalogue enabled', async () => {
    const res = await app().request('/api/v1/app/config');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.extensions.catalogEnabled).toBe(true);
    expect(body.data.extensions.repoUrl).toContain('fan-novel-extensions');
  });

  it('hides the catalogue when disabled', async () => {
    const res = await app({ EXTENSIONS_CATALOG_ENABLED: 'false' }).request(
      '/api/v1/app/config'
    );
    const body = await res.json();
    expect(body.data.extensions.catalogEnabled).toBe(false);
  });

  it('serves a custom repository url', async () => {
    const res = await app({
      EXTENSIONS_REPO_URL: 'https://cdn.example/extensions',
    }).request('/api/v1/app/config');
    const body = await res.json();
    expect(body.data.extensions.repoUrl).toBe('https://cdn.example/extensions');
  });
});
