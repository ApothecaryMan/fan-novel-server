import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set (see .env.example)');
}

const pool = new pg.Pool({ connectionString, max: 10 });
export const db = drizzle(pool, { schema });
export type Db = typeof db;
