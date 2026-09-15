import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { requestId } from 'hono/request-id';
import { novelsRouter } from './routes/novels.js';
import { chaptersRouter, chaptersTimelineRouter } from './routes/chapters.js';
import { uploadRouter } from './routes/upload.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';
import { authorRouter } from './routes/author.js';
import { adminRouter } from './routes/admin.js';
import { rateLimit } from './middleware/rateLimit.js';
import { checkDb, db, initDb, isDbAvailable, noteDbFailure } from './database/db.js';
import { coverBlobs } from './database/schema.js';
import { eq } from 'drizzle-orm';
import { getEnv, isWorkersRuntime } from './config/env.js';

export function createApp() {
  const env = getEnv();
  const app = new Hono();

  app.use('*', requestId());
  app.use('*', logger());
  app.use('*', cors({
    origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));
  if (!env.isProd) app.use('*', prettyJSON());

  app.use('/api/v1/auth/*', rateLimit(30));
  app.use('/api/v1/upload/*', rateLimit(20));
  app.use('/api/v1/admin/*', rateLimit(60));

  // Ensure DB is initialized (pg Pool on Node, neon-http on Workers) before routes run.
  app.use('*', async (_c, next) => {
    await initDb();
    await next();
  });

  app.onError((err, c) => {
    console.error(`[${c.get('requestId') ?? 'no-id'}]`, err);
    return c.json({ error: 'internal server error', requestId: c.get('requestId') ?? null }, 500);
  });

  // Cover serving: R2 binding → Postgres blob → local disk (Node) → 404.
  // One GET route on both runtimes; falls through with next() on miss.
  app.get('/uploads/covers/:filename', async (c, next) => {
    const name = c.req.param('filename');
    if (!/^[\w.-]+\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return c.json({ error: 'invalid filename' }, 400);
    // 1. R2 binding when present (Workers).
    const bucket = (globalThis as any).__WORKER_BINDINGS__?.COVERS as
      | { get: (k: string) => Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null> }
      | undefined;
    if (bucket) {
      const obj = await bucket.get(`covers/${name}`);
      if (obj) {
        const type = obj.httpMetadata?.contentType ?? 'image/png';
        return new Response(obj.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' } });
      }
    }
    // 2. Postgres blob fallback.
    if (isDbAvailable()) {
      try {
        const rows = await db.select().from(coverBlobs).where(eq(coverBlobs.filename, name)).limit(1);
        if (rows[0]) {
          const bin = Buffer.from(rows[0].dataBase64, 'base64');
          return new Response(bin as unknown as BodyInit, { headers: { 'Content-Type': rows[0].mime, 'Cache-Control': 'public, max-age=86400' } });
        }
      } catch (err) {
        console.error('[covers] db read failed', err); noteDbFailure();
      }
    }
    await next();
  });
  // 3. Local disk (Node only; Workers has no filesystem).
  if (!isWorkersRuntime()) {
    app.use('/uploads/*', serveStatic({ root: './' }));
  }

  app.get('/health', async (c) => {
    const db = isDbAvailable() ? await checkDb() : false;
    return c.json({
      status: 'ok', service: 'Web Novel Hono API', version: '1.0.0',
      timestamp: new Date().toISOString(), db: isDbAvailable() ? (db ? 'up' : 'down') : 'memory',
    });
  });

  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/author', authorRouter);
  app.route('/api/v1/admin', adminRouter);
  app.route('/api/v1/novels', novelsRouter);
  app.route('/api/v1/novels', chaptersRouter);
  app.route('/api/v1/chapters', chaptersTimelineRouter);
  app.route('/api/v1/upload', uploadRouter);

  app.get('/api/v1', (c) => {
    return c.json({
      message: 'مرحباً بك في واجهة برمجة تطبيقات قارئ الروايات (Web Novel API)',
      endpoints: {
        health: '/health',
        novelsList: '/api/v1/novels?page&limit&category&status&q&sortBy',
        novelDetails: '/api/v1/novels/:id',
        createNovel: 'POST /api/v1/novels',
        updateNovel: 'PUT /api/v1/novels/:id',
        deleteNovel: 'DELETE /api/v1/novels/:id',
        chaptersList: '/api/v1/novels/:novelId/chapters?page&limit&order',
        chapterContent: '/api/v1/novels/:novelId/chapters/:chapterNumber',
        chapterTimeline: 'POST /api/v1/chapters/timeline',
        todayChapters: 'GET /api/v1/chapters/today',
        uploadCover: 'POST /api/v1/upload/cover',
      authorMine: 'GET /api/v1/author/mine?kind=author|translator',
      authorRequests: 'POST /api/v1/author/requests',
      myRequests: 'GET /api/v1/author/requests/mine',
      adminUsers: 'GET /api/v1/admin/users',
      adminRequests: 'GET /api/v1/admin/requests?status=pending',
        syncPush: 'POST /api/v1/sync/push',
        syncPull: 'POST /api/v1/sync/pull',
        syncStats: 'POST /api/v1/sync/stats',
      },
    });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
