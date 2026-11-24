// npm run db:seed — wipes the database and loads demo data. Never in production.
import { pool } from './client.js';
import { seedDemo } from './demo.js';
if (process.env.NODE_ENV === 'production')
    throw new Error('Refusing to seed a production database');
await seedDemo();
await pool.end();
//# sourceMappingURL=seed.js.map