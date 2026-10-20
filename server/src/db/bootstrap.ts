/**
 * First production setup from the command line: creates the agency and its owner (Super Admin).
 *   node dist/db/bootstrap.js "Agency Name" "Owner Name" owner@agency.com
 * Prints a one-time link where the owner sets their password. Refuses to run if any agency exists.
 * (Alternatively set SETUP_ADMIN_EMAIL / SETUP_ADMIN_PASSWORD and the app does this on its first start.)
 */
import { env } from '../config.js';
import { pool } from './client.js';
import { createAgency } from './setup.js';

const [agencyName, ownerName, email] = process.argv.slice(2);
if (!agencyName || !ownerName || !email || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Usage: node dist/db/bootstrap.js "Agency Name" "Owner Name" owner@agency.com');
  process.exit(1);
}
try {
  const { inviteToken } = await createAgency({ agencyName, ownerName, email });
  console.log(`Created ${agencyName}. ${ownerName} sets a password here (one-time link):\n${env.CLIENT_ORIGIN}/accept-invite?token=${inviteToken}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
