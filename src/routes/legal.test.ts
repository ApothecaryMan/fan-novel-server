import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const routes = ['/privacy', '/terms', '/account-deletion'];

describe('public legal pages', () => {
  for (const path of routes) {
    it(`${path} returns 200 HTML with contact and effective date`, async () => {
      const app = createApp();
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('Content-Type')).toContain('charset=utf-8');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
      const html = await res.text();
      expect(html).toContain('<html lang="ar" dir="rtl">');
      expect(html).toContain('<section lang="en" dir="ltr">');
      expect(html).toContain('mohamed1232003@gmail.com');
      expect(html).toContain('7 November 2026');
    });
  }
});
