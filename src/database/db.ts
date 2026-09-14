import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleNeon, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema.js';
import { getEnv, isWorkersRuntime } from '../config/env.js';

type AnyDb = NodePgDatabase<typeof schema> | NeonHttpDatabase<typeof schema>;

let nodePool: any = null;
let cached: { url: string; driver: 'pg' | 'neon-http'; db: AnyDb } | null = null;
let dbDownUntil = 0;

async function createNodeDb(url: string): Promise<AnyDb> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', (err) => console.error('[db] pool error', err));
  nodePool = pool;
  return drizzleNode(pool, { schema });
}

async function createNeonHttpDb(url: string): Promise<AnyDb> {
  const { neon } = await import('@neondatabase/serverless');
  const client = neon(url);
  return drizzleNeon(client, { schema });
}

function resolveSync(): AnyDb {
  const env = getEnv();
  const url = env.DATABASE_URL ?? '';
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  if (cached && cached.url === url) return cached.db;
  throw new Error('DB not initialized yet (await initDb())');
}

export async function initDb(): Promise<AnyDb | null> {
  const env = getEnv();
  const url = env.DATABASE_URL ?? '';
  if (!url) {
    console.warn('[db] DATABASE_URL not set — running in-memory fallback mode (data lost on restart)');
    return null;
  }
  if (cached && cached.url === url) return cached.db;
  try {
    if (isWorkersRuntime()) {
      const db = await createNeonHttpDb(url);
      cached = { url, driver: 'neon-http', db };
    } else {
      const db = await createNodeDb(url);
      cached = { url, driver: 'pg', db };
    }
    return cached.db;
  } catch (err) {
    console.error('[db] init failed, memory fallback', err);
    return null;
  }
}

// Lazy proxy so existing `db.select()` call sites keep working on both runtimes.
export const db = new Proxy({} as AnyDb, {
  get(_t, prop) {
    const target = resolveSync();
    const v = (target as any)[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});
export type Db = AnyDb;

export function isDbAvailable(): boolean {
  const env = getEnv();
  if (!env.DATABASE_URL) return false;
  if (Date.now() < dbDownUntil) return false;
  if (cached && cached.url === env.DATABASE_URL) return true;
  // Not connected yet: report available so routes attempt init, then fall back.
  return true;
}

export function noteDbFailure(cooldownMs = 30_000): void {
  dbDownUntil = Date.now() + cooldownMs;
}

export async function checkDb(): Promise<boolean> {
  const d = await initDb();
  if (!d) return false;
  try {
    await (d as any).execute('select 1');
    return true;
  } catch {
    return false;
  }
}
