import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { novelsRouter } from './routes/novels.js';
import { chaptersRouter, chaptersTimelineRouter } from './routes/chapters.js';
import { uploadRouter } from './routes/upload.js';
import { authRouter } from './routes/auth.js';
import path from 'path';

const app = new Hono();

// Middlewares
app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization']
}));

// Serve Static Uploads
app.use('/uploads/*', serveStatic({
  root: './'
}));

// Health Check Endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'Web Novel Hono API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Mount Routes
app.route('/api/v1/auth', authRouter);
app.route('/api/v1/novels', novelsRouter);
app.route('/api/v1/novels', chaptersRouter);
app.route('/api/v1/chapters', chaptersTimelineRouter);
app.route('/api/v1/upload', uploadRouter);

// API v1 Documentation Summary
app.get('/api/v1', (c) => {
  return c.json({
    message: 'مرحباً بك في واجهة برمجة تطبيقات قارئ الروايات (Web Novel API)',
    endpoints: {
      health: '/health',
      novelsList: '/api/v1/novels',
      novelDetails: '/api/v1/novels/:id',
      createNovel: 'POST /api/v1/novels',
      updateNovel: 'PUT /api/v1/novels/:id',
      deleteNovel: 'DELETE /api/v1/novels/:id',
      chaptersList: '/api/v1/novels/:novelId/chapters',
      chapterContent: '/api/v1/novels/:novelId/chapters/:chapterNumber',
      chapterTimeline: 'POST /api/v1/chapters/timeline',
      todayChapters: 'GET /api/v1/chapters/today',
      uploadCover: 'POST /api/v1/upload/cover'
    }
  });
});

const PORT = Number(process.env.PORT) || 4000;

console.log(`🚀 Web Novel Hono Server running on port ${PORT}`);

serve({
  fetch: app.fetch,
  port: PORT,
  hostname: '0.0.0.0'
});
