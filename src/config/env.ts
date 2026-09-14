import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(1).optional(),
  SYNC_OPEN: z.string().default('true'),
  CORS_ORIGIN: z.string().default('*'),
  NODE_ENV: z.string().default('development'),
  REDIS_URL: z.string().optional(),
  UPLOAD_MAX_MB: z.coerce.number().default(2),
  // R2 / S3-compatible object storage (optional; falls back to local disk on Node)
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY: z.string().optional(),
  R2_SECRET_KEY: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema> & {
  isProd: boolean;
  syncOpen: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __WORKER_ENV__: Record<string, string | undefined> | undefined;
}

let cached: Env | null = null;
let cachedKey = '';

function readSource(): Record<string, string | undefined> {
  const w = typeof globalThis !== 'undefined' ? (globalThis as any).__WORKER_ENV__ : undefined;
  const proc = typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {};
  if (w) return { ...proc, ...w };
  return { ...proc };
}

/** Called by the Workers entry on every request (bindings differ per env). */
export function setWorkerEnv(bindings: Record<string, unknown>): void {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(bindings ?? {})) {
    if (typeof v === 'string') flat[k] = v;
  }
  (globalThis as any).__WORKER_ENV__ = flat;
  cached = null;
  cachedKey = '';
}

export function getEnv(): Env {
  const src = readSource();
  const key = `${src.DATABASE_URL ?? ''}|${src.JWT_SECRET ?? ''}|${src.SYNC_OPEN}|${src.CORS_ORIGIN}|${src.NODE_ENV}|${src.R2_BUCKET ?? ''}`;
  if (cached && key === cachedKey) return cached;
  const parsed = envSchema.safeParse(src);
  if (!parsed.success) {
    console.warn('[env] invalid env, using defaults:', parsed.error.issues);
  }
  const e = (parsed.success ? parsed.data : {}) as z.infer<typeof envSchema>;
  const NODE_ENV = e.NODE_ENV ?? 'development';
  cachedKey = key;
  cached = {
    PORT: e.PORT ?? 4000,
    DATABASE_URL: e.DATABASE_URL,
    JWT_SECRET: e.JWT_SECRET,
    SYNC_OPEN: e.SYNC_OPEN ?? 'true',
    CORS_ORIGIN: e.CORS_ORIGIN ?? '*',
    NODE_ENV,
    REDIS_URL: e.REDIS_URL,
    UPLOAD_MAX_MB: e.UPLOAD_MAX_MB ?? 2,
    R2_ENDPOINT: e.R2_ENDPOINT,
    R2_BUCKET: e.R2_BUCKET,
    R2_ACCESS_KEY: e.R2_ACCESS_KEY,
    R2_SECRET_KEY: e.R2_SECRET_KEY,
    R2_PUBLIC_URL: e.R2_PUBLIC_URL,
    isProd: NODE_ENV === 'production',
    syncOpen: (e.SYNC_OPEN ?? 'true') !== 'false',
  };
  return cached;
}

export function isWorkersRuntime(): boolean {
  return typeof (globalThis as any).__WORKER_ENV__ !== 'undefined';
}

export function getWorkerBinding<T = unknown>(name: string): T | null {
  const w = typeof globalThis !== 'undefined' ? (globalThis as any).__WORKER_BINDINGS__ : undefined;
  const v = w?.[name];
  return (v ?? null) as T | null;
}
