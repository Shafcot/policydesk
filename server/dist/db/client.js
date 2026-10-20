import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config.js';
import * as schema from './schema.js';
// DATABASE_SSL=no-verify for hosted databases whose certificate isn't publicly trusted (e.g. Supabase pooler).
// Otherwise SSL follows the connection string (?sslmode=require for Neon and most managed Postgres).
const ssl = process.env.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_MAX ?? 10), ...(ssl ? { ssl } : {}) });
export const db = drizzle(pool, { schema });
//# sourceMappingURL=client.js.map