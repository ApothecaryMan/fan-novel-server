import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { productionBindings } from './test/identityDb.js';
import { setWorkerEnv } from './config/env.js';

function prodApp(corsOrigin: string) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setWorkerEnv({ ...productionBindings, NODE_ENV: 'production', CORS_ORIGIN: corsOrigin });
  return createApp();
}

describe('cors allowlist', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not echo wildcard in production', async () => {
    const res = await prodApp('*').request('/api/v1/store/catalog', {
      headers: { Origin: 'https://evil.test' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
  });

  it('does not echo unknown origins', async () => {
    const res = await prodApp('https://app.fan-novel.com').request('/api/v1/store/catalog', {
      headers: { Origin: 'https://evil.test' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.test');
  });
});
