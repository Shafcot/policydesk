// Production start used by single-process hosts (Hostinger Node.js apps, Render, …):
// applies migrations, optionally loads demo data into an empty database, then starts the API + worker.
import { db } from './db/client.js';
import { runMigrations } from './db/migrations.js';

await runMigrations();
console.log('Migrations applied');
if (process.env.DEMO_DATA === 'true' && !(await db.query.agencies.findFirst())) {
  const { seedDemo } = await import('./db/demo.js');
  await seedDemo();
}
await import('./index.js');
