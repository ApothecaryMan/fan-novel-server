import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(1).optional(),
  SYNC_OPEN: z.string().default('true'),
  CORS_ORIGIN: z.string().default('*'),
  NODE_ENV: z.string().default('development'),
  REDIS_URL: z.string().optional(),
  UPLOAD_MAX_MB: z.coerce.number().default(5),
  // R2 / S3-compatible object storage (optional; falls back to local disk)
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

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.warn('[env] invalid env, using defaults:', parsed.error.issues);
  }
  const e = (parsed.success ? parsed.data : {}) as z.infer<typeof envSchema>;
  const NODE_ENV = e.NODE_ENV ?? 'development';
  cached = {
    PORT: e.PORT ?? 4000,
    DATABASE_URL: e.DATABASE_URL,
    JWT_SECRET: e.JWT_SECRET,
    SYNC_OPEN: e.SYNC_OPEN ?? 'true',
    CORS_ORIGIN: e.CORS_ORIGIN ?? '*',
    NODE_ENV,
    REDIS_URL: e.REDIS_URL,
    UPLOAD_MAX_MB: e.UPLOAD_MAX_MB ?? 5,
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
