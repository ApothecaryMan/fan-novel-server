import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnv, setWorkerEnv } from './env.js';
import { productionBindings } from '../test/identityDb.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function source(value: Record<string, unknown>) {
  vi.stubGlobal('__WORKER_ENV__', undefined);
  setWorkerEnv(value);
}
describe('effective environment fails closed', () => {
  it('accepts production and rejects invalid settings without values', () => {
    source(productionBindings);
    expect(getEnv()).toMatchObject({ isProd: true, syncOpen: false });
  });
  it.each([
    ['NODE_ENV', undefined], ['NODE_ENV', ''], ['NODE_ENV', 'staging'],
    ['JWT_SECRET', undefined], ['JWT_SECRET', ''], ['JWT_SECRET', 'short'],
    ['JWT_SECRET', 'web-novel-dev-' + 'x'.repeat(50)], ['JWT_SECRET', 'change-me-in-production'],
    ['JWT_SECRET', ' '.repeat(40)], ['DATABASE_URL', undefined], ['DATABASE_URL', ''],
    ['DATABASE_URL', 'https://example.com/db'], ['DATABASE_URL', 'postgresql://localhost'],
    ['GOOGLE_WEB_CLIENT_ID', ''], ['GOOGLE_WEB_CLIENT_ID', undefined],
    ['SYNC_OPEN', undefined], ['SYNC_OPEN', 'true'], ['SYNC_OPEN', 'False'], ['SYNC_OPEN', 'false '],
    ['PORT', 'private-invalid-number'], ['UPLOAD_MAX_MB', 'private-invalid-number'],
  ])('rejects invalid %s', (field, value) => {
    source({ ...productionBindings, [field as string]: value });
    expect(() => getEnv()).toThrow(String(field));
    try { getEnv(); } catch (error) {
      const message = String(error);
      expect(message).not.toContain(productionBindings.JWT_SECRET);
      expect(message).not.toContain(productionBindings.DATABASE_URL);
      expect(message).not.toContain('private-invalid-number');
    }
  });
  it('measures UTF-8 bytes, not string length', () => {
    source({ ...productionBindings, JWT_SECRET: 'é'.repeat(16) });
    expect(getEnv().isProd).toBe(true);
  });
  it.each(['development', 'test'])('allows defaults only in explicit %s', (NODE_ENV) => {
    source({ NODE_ENV }); expect(getEnv()).toMatchObject({ isProd: false, syncOpen: true });
  });
  it('invalid development input never silently opens sync', () => {
    source({ NODE_ENV: 'development', SYNC_OPEN: 'False' });
    expect(() => getEnv()).toThrow('SYNC_OPEN');
  });
  it('rechecks every field and worker binding without cached development state', () => {
    source({ NODE_ENV: 'test' }); expect(getEnv().syncOpen).toBe(true);
    setWorkerEnv(productionBindings); expect(getEnv().syncOpen).toBe(false);
    globalThis.__WORKER_ENV__!.PORT = 'private-invalid-number';
    expect(() => getEnv()).toThrow('PORT');
    setWorkerEnv({}); expect(() => getEnv()).toThrow('NODE_ENV');
  });
  it('does not inherit Node credentials into missing worker bindings', () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('JWT_SECRET', productionBindings.JWT_SECRET);
    source({}); expect(() => getEnv()).toThrow('NODE_ENV');
  });
  it('revalidates Node source changes', () => {
    vi.stubGlobal('__WORKER_ENV__', undefined);
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('SYNC_OPEN', 'false');
    expect(getEnv().syncOpen).toBe(false);
    vi.stubEnv('UPLOAD_MAX_MB', 'private-invalid-number');
    expect(() => getEnv()).toThrow('UPLOAD_MAX_MB');
  });
  it('fails before createApp returns a permissive app', async () => {
    source({ ...productionBindings, PORT: 'private-invalid-number' });
    const { createApp } = await import('../app.js');
    expect(() => createApp()).toThrow('PORT');
  });
});
