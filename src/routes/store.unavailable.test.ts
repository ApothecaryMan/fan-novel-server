import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { productionBindings } from '../test/identityDb.js';
import { setWorkerEnv } from '../config/env.js';

// Store 503s must carry the same retryable contract as the leaderboard 503s,
// so a client can tell "try again" apart from "broken". Technique mirrors
// app.rateLimit.test.ts: no DATABASE_URL means no DB, so routes answer 503.
describe('store 503 contract', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function app() {
    setWorkerEnv({ ...productionBindings, NODE_ENV: 'development', SYNC_OPEN: 'true', DATABASE_URL: undefined });
    return createApp();
  }

  it('marks the public catalog outage as retryable', async () => {
    const res = await app().request('/api/v1/store/catalog');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'store unavailable', retryable: true });
  });
});
