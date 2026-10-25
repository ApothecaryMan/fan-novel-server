import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';

function app(overrides: Record<string, string> = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', DATABASE_URL: undefined, ...overrides });
  return createApp();
}

describe('upload auth gate', () => {
  it('401s anonymous upload when SYNC_OPEN=false', async () => {
    const form = new FormData();
    form.append('kind', 'cover');
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }));
    const res = await app({ SYNC_OPEN: 'false' }).request('/api/v1/upload/image', { method: 'POST', body: form });
    expect(res.status).toBe(401);
  });
});
