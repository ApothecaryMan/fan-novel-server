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
    expect(body.data.grouped).toEqual({
      additions: { ar: [], en: [] },
      fixes: { ar: [], en: [] },
      changes: { ar: [], en: [] },
    });
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
      grouped: {
        additions: { ar: ['ميزة جديدة', 'إصلاح خطأ'], en: [] },
        fixes: { ar: [], en: [] },
        changes: { ar: [], en: [] },
      },
      apkSha256: 'abc123',
    });
  });

  it('keeps notes grouped per category while the flat list stays the Arabic union', async () => {
    const res = await app({
      APP_LATEST_VERSION: '0.4.3',
      APP_UPDATE_NOTES: 'إضافة|إضافة ثانية',
      APP_UPDATE_NOTES_EN: 'An addition',
      APP_UPDATE_FIXES: 'إصلاح',
      APP_UPDATE_FIXES_EN: 'A fix',
      APP_UPDATE_CHANGES: 'تغيير',
      APP_UPDATE_CHANGES_EN: 'A change',
    }).request('/api/v1/app/version');

    const body = await res.json();
    expect(body.data.notes).toEqual(['إضافة', 'إضافة ثانية', 'إصلاح', 'تغيير']);
    expect(body.data.grouped).toEqual({
      additions: { ar: ['إضافة', 'إضافة ثانية'], en: ['An addition'] },
      fixes: { ar: ['إصلاح'], en: ['A fix'] },
      changes: { ar: ['تغيير'], en: ['A change'] },
    });
  });

  it('answers 404 for the download route when no release is stored', async () => {
    const res = await app().request('/api/v1/app/download');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'not found' });
  });
});

describe('GET /api/v1/app/download with a stored release', () => {
  const BYTES = new TextEncoder().encode('0123456789');

  function fakeBucket() {
    return {
      head: async (key: string) =>
        key === 'releases/latest.apk'
          ? {
              size: BYTES.length,
              etag: '"abc"',
              httpMetadata: { contentType: 'application/vnd.android.package-archive' },
            }
          : null,
      get: async (key: string, options?: { range?: { offset?: number; length?: number } }) => {
        if (key !== 'releases/latest.apk') return null;
        const start = options?.range?.offset ?? 0;
        const end =
          options?.range?.length !== undefined
            ? start + options.range.length
            : BYTES.length;
        const slice = BYTES.slice(start, Math.min(end, BYTES.length));
        return {
          body: new Response(slice).body,
          size: BYTES.length,
          etag: '"abc"',
          httpMetadata: { contentType: 'application/vnd.android.package-archive' },
        };
      },
    };
  }

  function appWithRelease(overrides: Record<string, string> = {}) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setWorkerEnv({
      ...productionBindings,
      NODE_ENV: 'development',
      SYNC_OPEN: 'true',
      DATABASE_URL: undefined,
      ...overrides,
    });
    (globalThis as any).__WORKER_BINDINGS__ = { RELEASES: fakeBucket() };
    return createApp();
  }

  afterEach(() => {
    delete (globalThis as any).__WORKER_BINDINGS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serves the full object with length, ranges, and etag headers', async () => {
    const res = await appWithRelease().request('/api/v1/app/download');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(await res.text()).toBe('0123456789');
  });

  it('serves a byte range with 206 and content-range', async () => {
    const res = await appWithRelease().request('/api/v1/app/download', {
      headers: { Range: 'bytes=2-5' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('serves an open-ended range to the end of the object', async () => {
    const res = await appWithRelease().request('/api/v1/app/download', {
      headers: { Range: 'bytes=7-' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(await res.text()).toBe('789');
  });

  it('rejects an unsatisfiable range with 416', async () => {
    const res = await appWithRelease().request('/api/v1/app/download', {
      headers: { Range: 'bytes=99-' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('answers HEAD with headers and no body', async () => {
    const res = await appWithRelease().request('/api/v1/app/download', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('');
  });
});
