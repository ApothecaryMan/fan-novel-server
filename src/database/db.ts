import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;

let pool: pg.Pool | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

if (connectionString) {
  pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', (err) => console.error('[db] pool error', err));
  dbInstance = drizzle(pool, { schema });
} else {
  console.warn('[db] DATABASE_URL not set — running in-memory fallback mode (data lost on restart)');
}

export const db = dbInstance as unknown as ReturnType<typeof drizzle<typeof schema>>;
export type Db = typeof db;

export function isDbAvailable(): boolean {
  if (!dbInstance) return false;
  if (Date.now() < dbDownUntil) return false;
  return true;
}

let dbDownUntil = 0;

export function noteDbFailure(cooldownMs = 30_000): void {
  dbDownUntil = Date.now() + cooldownMs;
}

export async function checkDb(): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
