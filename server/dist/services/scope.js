import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads } from '../db/schema.js';
import { forbidden, notFound } from '../lib/http.js';
/** Row filter for leads the user may see: admins see the whole agency, agents only their own. */
export function leadScope(u) {
    const agency = eq(leads.agencyId, u.agencyId);
    return u.role === 'admin' ? agency : and(agency, eq(leads.agentId, u.id));
}
/** Loads a lead the user may see, or throws 404 (agents never learn other agents' leads exist). */
export async function getVisibleLead(u, id) {
    const lead = await db.query.leads.findFirst({ where: and(eq(leads.id, id), leadScope(u)) });
    if (!lead)
        throw notFound('Lead not found');
    return lead;
}
/** SOW 6: other agents cannot call a lead someone else owns; nobody can call a lead locked by a live call. */
export function assertCanCall(u, lead) {
    if (u.role !== 'admin' && lead.agentId !== u.id)
        throw forbidden('Only the lead owner can call this lead');
    if (lead.lockedById && lead.lockedById !== u.id)
        throw forbidden('Another user is on a call with this lead');
}
//# sourceMappingURL=scope.js.map