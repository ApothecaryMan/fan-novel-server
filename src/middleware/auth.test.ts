import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { requireAuth, signToken, verifySubject } from './auth.js';
import { setWorkerEnv } from '../config/env.js';
import { productionBindings } from '../test/identityDb.js';

beforeEach(() => { vi.stubGlobal('__WORKER_ENV__', undefined); setWorkerEnv(productionBindings); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const user = { id: 'google_subject-1', email: 'reader@test.com', role: 'reader' };
function app() { return new Hono().get('/', requireAuth, (c) => c.json(c.get('authUser'))); }
describe('shared JWT policy', () => {
  it('signs usable production sessions', async () => {
    const token = await signToken(user);
    expect(await verifySubject(`Bearer ${token}`)).toBe(user.id);
    expect((await app().request('/', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });
  it('rejects the dev secret as production configuration for both APIs', async () => {
    setWorkerEnv({ ...productionBindings, JWT_SECRET: 'web-novel-dev-secret-change-me' });
    await expect(signToken(user)).rejects.toThrow('JWT_SECRET');
    await expect(verifySubject('Bearer invalid')).rejects.toThrow('JWT_SECRET');
  });
  it('rejects a dev-signed token under valid production configuration', async () => {
    setWorkerEnv({ NODE_ENV: 'test' });
    const token = await signToken(user);
    setWorkerEnv(productionBindings);
    expect(await verifySubject(`Bearer ${token}`)).toBeNull();
    expect((await app().request('/', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
  it.each([
    ['wrong', 'web-novel-app', '1h'], ['web-novel', 'wrong', '1h'], ['web-novel', 'web-novel-app', '-1h'],
  ])('retains issuer/audience/expiration checks: %s %s %s', async (issuer, audience, expiration) => {
    const token = await new SignJWT({ sub: user.id }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer).setAudience(audience).setExpirationTime(expiration)
      .sign(new TextEncoder().encode(productionBindings.JWT_SECRET));
    expect(await verifySubject(`Bearer ${token}`)).toBeNull();
    expect((await app().request('/', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
  it('does not fall back to a raw process secret for worker verification', async () => {
    vi.stubEnv('JWT_SECRET', productionBindings.JWT_SECRET);
    setWorkerEnv({ ...productionBindings, JWT_SECRET: undefined });
    await expect(signToken(user)).rejects.toThrow('JWT_SECRET');
  });
  it('returns 401 without a token', async () => { expect((await app().request('/')).status).toBe(401); });
});
