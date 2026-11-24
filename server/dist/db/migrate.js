import { pool } from './client.js';
import { runMigrations } from './migrations.js';
await runMigrations();
console.log('Migrations applied');
await pool.end();
//# sourceMappingURL=migrate.js.map