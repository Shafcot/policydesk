import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './client.js';

/** Applies pending SQL migrations from server/drizzle (works from src/ and dist/). */
export async function runMigrations() {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
}
