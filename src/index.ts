import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { isDbAvailable } from './database/db.js';
import { getEnv } from './config/env.js';

const env = getEnv();
const app = createApp();

const PORT = env.PORT;
console.log(`🚀 Web Novel Hono Server on :${PORT} (db=${isDbAvailable() ? 'postgres' : 'memory'}, syncOpen=${env.syncOpen})`);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });
