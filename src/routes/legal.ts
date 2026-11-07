import { Hono } from 'hono';
import { accountDeletionPage } from '../legal/accountDeletion.js';
import { privacyPage } from '../legal/privacyPolicy.js';
import { termsPage } from '../legal/terms.js';

function serve(html: string) {
  return (c: import('hono').Context) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(html);
  };
}

export const legalRouter = new Hono();

legalRouter.get('/privacy', serve(privacyPage()));
legalRouter.get('/terms', serve(termsPage()));
legalRouter.get('/account-deletion', serve(accountDeletionPage()));
