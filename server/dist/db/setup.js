// Creates the agency and its owner (Super Admin) in an empty database, with the default templates,
// automations (the SOW flows) and lead sources. No leads, customers or other sample records.
import { randomBytes } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../domain.js';
import { hashPassword } from '../lib/auth.js';
import { makeSlug } from '../lib/slug.js';
import { db } from './client.js';
import { installAgencyDefaults } from './defaults.js';
import { agencies, users } from './schema.js';
export async function createAgency(o) {
    if (await db.query.agencies.findFirst())
        throw new Error('This database already has an agency. Invite more users from the app (Users → Invite).');
    const inviteToken = o.password ? null : randomBytes(24).toString('hex');
    const passwordHash = o.password ? await hashPassword(o.password) : null;
    await db.transaction(async (tx) => {
        const [agency] = await tx.insert(agencies).values({ name: o.agencyName, brandName: 'Policy-desk CRM', settings: DEFAULT_SETTINGS }).returning();
        await tx.insert(users).values({ agencyId: agency.id, name: o.ownerName, email: o.email.toLowerCase().trim(), role: 'admin', status: 'offline', passwordHash, inviteToken, bookingSlug: makeSlug(o.ownerName) });
        await installAgencyDefaults(tx, agency.id);
    });
    return { inviteToken };
}
//# sourceMappingURL=setup.js.map