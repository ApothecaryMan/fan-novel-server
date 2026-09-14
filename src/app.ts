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
import { rateLimit } from './middleware/rateLimit.js';
import { checkDb, initDb, isDbAvailable } from './database/db.js';
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

  // Ensure DB is initialized (pg Pool on Node, neon-http on Workers) before routes run.
  app.use('*', async (_c, next) => {
    await initDb();
    await next();
  });

  app.onError((err, c) => {
    console.error(`[${c.get('requestId') ?? 'no-id'}]`, err);
    return c.json({ error: 'internal server error', requestId: c.get('requestId') ?? null }, 500);
  });

  // Local static uploads only exist on Node. On Workers covers come from the COVERS R2 binding.
  if (!isWorkersRuntime()) {
    app.use('/uploads/*', serveStatic({ root: './' }));
  } else {
    app.get('/uploads/covers/:filename', async (c) => {
      const name = c.req.param('filename');
      if (!/^[\w.-]+\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return c.json({ error: 'invalid filename' }, 400);
      const bucket = (globalThis as any).__WORKER_BINDINGS__?.COVERS as
        | { get: (k: string) => Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null> }
        | undefined;
      if (!bucket) return c.json({ error: 'cover storage not configured' }, 501);
      const obj = await bucket.get(`covers/${name}`);
      if (!obj) return c.json({ error: 'not found' }, 404);
      const type = obj.httpMetadata?.contentType ?? 'image/png';
      return new Response(obj.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' } });
    });
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
        syncPush: 'POST /api/v1/sync/push',
        syncPull: 'POST /api/v1/sync/pull',
        syncStats: 'POST /api/v1/sync/stats',
      },
    });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
