import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';

describe('GET /api/v1/app/version', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  it('reports no update when unconfigured, so the app stays silent', async () => {
    const res = await app().request('/api/v1/app/version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.latestVersion).toBe('');
    expect(body.data.downloadUrl).toBeNull();
    expect(body.data.force).toBe(false);
    expect(body.data.notes).toEqual([]);
  });

  it('reports the configured release and parses the note list', async () => {
    const res = await app({
      APP_LATEST_VERSION: '0.0.3',
      APP_MIN_VERSION: '0.0.2',
      APP_UPDATE_URL: 'https://example.com/app.apk',
      APP_UPDATE_NOTES: 'ميزة جديدة|إصلاح خطأ',
      APP_UPDATE_FORCE: 'true',
      APP_APK_SHA256: 'abc123',
    }).request('/api/v1/app/version');

    const body = await res.json();
    expect(body.data).toEqual({
      latestVersion: '0.0.3',
      minVersion: '0.0.2',
      downloadUrl: 'https://example.com/app.apk',
      force: true,
      notes: ['ميزة جديدة', 'إصلاح خطأ'],
      apkSha256: 'abc123',
    });
  });

  it('answers 404 for the download route when no release is stored', async () => {
    const res = await app().request('/api/v1/app/download');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'not found' });
  });
});
