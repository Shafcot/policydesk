// Production start used by single-process hosts (Hostinger Node.js apps, Render, …):
// applies migrations, sets up the agency + Super Admin on an empty database (from SETUP_* variables), then starts the API + worker.
import { db } from './db/client.js';
import { runMigrations } from './db/migrations.js';
import { createAgency } from './db/setup.js';
await runMigrations();
console.log('Migrations applied');
const email = process.env.SETUP_ADMIN_EMAIL?.trim();
const password = process.env.SETUP_ADMIN_PASSWORD ?? '';
if (email && !(await db.query.agencies.findFirst())) {
    if (password.length < 8)
        throw new Error('SETUP_ADMIN_PASSWORD must be at least 8 characters');
    await createAgency({ agencyName: process.env.SETUP_AGENCY_NAME?.trim() || 'My Agency', ownerName: process.env.SETUP_ADMIN_NAME?.trim() || 'Admin', email, password });
    console.log(`Created the agency and Super Admin ${email}. Remove SETUP_ADMIN_PASSWORD from the environment now.`);
}
await import('./index.js');
//# sourceMappingURL=start.js.map