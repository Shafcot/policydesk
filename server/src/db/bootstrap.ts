/**
 * First production setup: creates the agency and its owner (Super Admin) with the default templates, automations and lead sources.
 *   node dist/db/bootstrap.js "Agency Name" "Owner Name" owner@agency.com
 * Prints a one-time link where the owner sets their password. Refuses to run if any agency exists.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../config.js';
import { DEFAULT_SETTINGS } from '../domain.js';
import { makeSlug } from '../lib/slug.js';
import { db, pool } from './client.js';
import { installAgencyDefaults } from './defaults.js';
import { agencies, users } from './schema.js';

const [agencyName, ownerName, emailArg] = process.argv.slice(2);
if (!agencyName || !ownerName || !emailArg || !/^\S+@\S+\.\S+$/.test(emailArg)) {
  console.error('Usage: node dist/db/bootstrap.js "Agency Name" "Owner Name" owner@agency.com');
  process.exit(1);
}
try {
  if (await db.query.agencies.findFirst()) throw new Error('This database already has an agency. Invite more users from the app (Users → Invite).');
  const token = randomBytes(24).toString('hex');
  await db.transaction(async (tx) => {
    const [agency] = await tx.insert(agencies).values({ name: agencyName, brandName: 'Policy-desk CRM', settings: DEFAULT_SETTINGS }).returning();
    await tx.insert(users).values({ agencyId: agency.id, name: ownerName, email: emailArg.toLowerCase().trim(), role: 'admin', status: 'offline', inviteToken: token, bookingSlug: makeSlug(ownerName) });
    await installAgencyDefaults(tx, agency.id);
  });
  console.log(`Created ${agencyName}. ${ownerName} sets a password here (one-time link):\n${env.CLIENT_ORIGIN}/accept-invite?token=${token}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
