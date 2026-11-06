import { createApp } from './app.js';
import { setWorkerEnv } from './config/env.js';

export interface WorkerBindings {
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  SYNC_OPEN?: string;
  CORS_ORIGIN?: string;
  NODE_ENV?: string;
  R2_BUCKET?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY?: string;
  R2_SECRET_KEY?: string;
  R2_PUBLIC_URL?: string;
  COVERS?: unknown;
  RELEASES?: unknown;
  DECORATIONS?: unknown;
  RATE_LIMITER?: unknown;
  IMAGES?: unknown;
}

let app: ReturnType<typeof createApp> | null = null;

export default {
  async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
    setWorkerEnv(bindings as unknown as Record<string, unknown>);
    (globalThis as any).__WORKER_BINDINGS__ = bindings;
    if (!app) app = createApp();
    return app.fetch(request, bindings);
  },
};
