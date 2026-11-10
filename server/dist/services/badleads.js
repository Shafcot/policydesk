// Bad leads (client request): bad number, unreachable, Do Not Solicit, Do Not Call.
// Marking one stops its automations and keeps it out of the dialer queue; DNS/DNC also opt it out and block calls.
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, notes } from '../db/schema.js';
import { BAD_REASON_LABELS, BLOCKING_BAD } from '../domain.js';
import { stopRuns } from './automation.js';
/** Sets or clears a lead's bad reason. `by` is null when the system flags it. Returns false if nothing changed. */
export async function markBad(x, lead, reason, by) {
    if ((lead.badReason ?? null) === reason)
        return false;
    const now = new Date();
    await x.update(leads).set({
        badReason: reason, badAt: reason ? now : null, badById: reason ? by?.id ?? null : null, updatedAt: now,
        ...(reason && BLOCKING_BAD.includes(reason) ? { optOut: true } : {}),
    }).where(eq(leads.id, lead.id));
    const who = by?.name ?? 'System';
    const text = reason
        ? `${who} marked this lead as ${BAD_REASON_LABELS[reason]}.${BLOCKING_BAD.includes(reason) ? ' Calls, texts and emails are blocked.' : ''}`
        : `${who} cleared the bad-lead flag (${BAD_REASON_LABELS[lead.badReason] ?? lead.badReason}).${lead.optOut || (lead.badReason && BLOCKING_BAD.includes(lead.badReason)) ? ' The lead stays opted out of texts and emails.' : ''}`;
    await x.insert(notes).values({ leadId: lead.id, userId: by?.id ?? null, body: text });
    if (reason)
        await stopRuns(x, lead.id, 'bad_lead');
    return true;
}
/** Twilio says the number itself is invalid / not in service (not just busy or unanswered). */
export function isDeadNumber(body) {
    const sip = String(body.SipResponseCode ?? ''), code = String(body.ErrorCode ?? '');
    return ['404', '410', '484', '604'].includes(sip) || ['13223', '13224', '21211', '21217', '21614'].includes(code);
}
export async function flagDeadNumber(leadId) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    if (lead && !lead.badReason)
        await markBad(db, lead, 'bad_number', null);
}
//# sourceMappingURL=badleads.js.map