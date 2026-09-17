import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyGoogleIdToken } from './googleIdentity.js';

const good = () => ({ sub: 'subject-1', email: 'Reader@Test.com', aud: 'web-client',
  iss: 'https://accounts.google.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 600) });
beforeEach(() => {
  vi.stubGlobal('__WORKER_ENV__', undefined);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('GOOGLE_WEB_CLIENT_ID', 'web-client');
  vi.stubEnv('GOOGLE_ANDROID_CLIENT_ID', '');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(good())));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('verified tokeninfo boundary', () => {
  it.each([true, 'true'])('accepts only normalized true: %s', async (value) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...good(), email_verified: value }));
    await expect(verifyGoogleIdToken('fixture-token')).resolves.toEqual({ sub: 'subject-1', email: 'reader@test.com' });
  });
  it('accepts the other documented issuer', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...good(), iss: 'accounts.google.com' }));
    await expect(verifyGoogleIdToken('fixture-token')).resolves.toHaveProperty('sub', 'subject-1');
  });
  it.each(['sub', 'email', 'aud', 'iss', 'exp', 'email_verified'])('rejects missing %s', async (field) => {
    const value: Record<string, unknown> = good(); delete value[field];
    vi.mocked(fetch).mockResolvedValue(Response.json(value));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    ['sub', ''], ['sub', ' '], ['email', 'invalid'], ['aud', 'wrong'], ['iss', 'wrong'],
    ['email_verified', false], ['email_verified', 'false'], ['email_verified', 'TRUE'],
    ['email_verified', 1], ['exp', '0'], ['exp', 'bad'], ['exp', -1], ['exp', null],
  ])('rejects malformed %s=%s', async (field, value) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...good(), [field as string]: value }));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 401 });
  });
  it('rejects an empty audience allowlist', async () => {
    vi.stubEnv('GOOGLE_WEB_CLIENT_ID', '');
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 401 });
  });
  it('rejects malformed JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{'));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 401 });
  });
  it.each([400, 401, 500, 503, 429])('fails closed on upstream %s', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status }));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: status >= 500 || status === 429 ? 503 : 401 });
  });
  it('fails closed on network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('private upstream diagnostics'));
    await expect(verifyGoogleIdToken('fixture-token')).rejects.toMatchObject({ status: 503 });
  });
});
