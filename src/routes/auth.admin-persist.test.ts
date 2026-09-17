import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../app.js';

beforeEach(() => {
  vi.stubGlobal('__WORKER_ENV__', undefined);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SYNC_OPEN', 'false');
  vi.stubEnv('JWT_SECRET', 'development-fixture-signing-key');
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubEnv('ADMIN_EMAILS', 'admin@test.com');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('admin role survives app restart (re-login + /me refresh)', () => {
  it('memory fallback promotes ADMIN_EMAILS on first and repeat logins', async () => {
    const app = createApp();

    const login = await app.request('/api/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.com', name: 'Admin' }),
    });
    expect(login.status).toBe(200);
    const lbody: any = await login.json();
    expect(lbody.user.role).toBe('admin');

    // Simulate app close/reopen: login again with same email
    const relogin = await app.request('/api/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.com', name: 'Admin' }),
    });
    const rbody: any = await relogin.json();
    expect(rbody.user.role).toBe('admin');

    // /me returns fresh token carrying the admin role
    const me = await app.request('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${rbody.token}` },
    });
    expect(me.status).toBe(200);
    const mbody: any = await me.json();
    expect(mbody.user.role).toBe('admin');
    expect(typeof mbody.token).toBe('string');
  });

  it('non-admin stays reader', async () => {
    const app = createApp();
    const res = await app.request('/api/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@test.com', name: 'User' }),
    });
    const body: any = await res.json();
    expect(body.user.role).toBe('reader');
  });
});
