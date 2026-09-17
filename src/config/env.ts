import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(1).optional(),
  SYNC_OPEN: z.enum(['true', 'false']).optional(),
  CORS_ORIGIN: z.string().default('*'),
  NODE_ENV: z.enum(['production', 'development', 'test']),
  REDIS_URL: z.string().optional(),
  UPLOAD_MAX_MB: z.coerce.number().default(2),
  // R2 / S3-compatible object storage (optional; falls back to local disk on Node)
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY: z.string().optional(),
  R2_SECRET_KEY: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),
  ADMIN_EMAILS: z.string().default(''),
  GOOGLE_WEB_CLIENT_ID: z.string().optional(),
  GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') return;
  const invalid = (field: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'invalid configuration' });
  try {
    const url = new URL(value.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) invalid('DATABASE_URL');
  } catch { invalid('DATABASE_URL'); }
  if (value.SYNC_OPEN !== 'false') invalid('SYNC_OPEN');
  if (![value.GOOGLE_WEB_CLIENT_ID, value.GOOGLE_ANDROID_CLIENT_ID].some((v) => v && v.trim().length > 0)) invalid('GOOGLE_WEB_CLIENT_ID');
  const secret = value.JWT_SECRET ?? '';
  if (new TextEncoder().encode(secret).length < 32 || !secret.trim() ||
      secret.trim().startsWith('web-novel-dev-') || secret.trim() === 'change-me-in-production') invalid('JWT_SECRET');
});

export type Env = z.infer<typeof envSchema> & {
  isProd: boolean;
  syncOpen: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __WORKER_ENV__: Record<string, string | undefined> | undefined;
}

function readSource(): Record<string, string | undefined> {
  // Do not inherit process defaults into a Worker with missing bindings.
  if (globalThis.__WORKER_ENV__ !== undefined) return { ...globalThis.__WORKER_ENV__ };
  return typeof process === 'undefined' ? {} : { ...process.env };
}

/** Called by the Workers entry on every request (bindings differ per env). */
export function setWorkerEnv(bindings: Record<string, unknown>): void {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(bindings ?? {})) {
    if (typeof v === 'string') flat[k] = v;
  }
  globalThis.__WORKER_ENV__ = flat;
}

export function getEnv(): Env {
  const parsed = envSchema.safeParse(readSource());
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'environment')))];
    throw new Error(`Invalid environment fields: ${fields.join(', ')}`);
  }
  const value = parsed.data;
  return { ...value, isProd: value.NODE_ENV === 'production', syncOpen: (value.SYNC_OPEN ?? 'true') === 'true' };
}

export function adminEmails(): string[] {
  return getEnv().ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isWorkersRuntime(): boolean {
  return typeof (globalThis as any).__WORKER_ENV__ !== 'undefined';
}

export function getWorkerBinding<T = unknown>(name: string): T | null {
  const w = typeof globalThis !== 'undefined' ? (globalThis as any).__WORKER_BINDINGS__ : undefined;
  const v = w?.[name];
  return (v ?? null) as T | null;
}
