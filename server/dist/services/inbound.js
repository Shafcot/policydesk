// Incoming SMS/email replies. Milestone 3 webhooks (Twilio, SendGrid inbound parse) call receiveReply().
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, messages } from '../db/schema.js';
import { stopRuns } from './automation.js';
import { emitLead } from './realtime.js';
import { getSettings, notify } from './rules.js';
export async function receiveReply(leadId, channel, body, subject) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    if (!lead)
        return null;
    const st = await getSettings(lead.agencyId);
    const name = `${lead.firstName} ${lead.lastName}`;
    const isStop = st.optOutKeywords.includes(body.trim().toUpperCase());
    await db.transaction(async (tx) => {
        await tx.insert(messages).values({ leadId, channel, direction: 'in', body, subject: subject ?? null, status: 'received' });
        if (isStop) {
            // SOW 6 opt-out: removed from all messages, every running automation stops.
            await tx.update(leads).set({ optOut: true, updatedAt: new Date() }).where(eq(leads.id, leadId));
            await stopRuns(tx, leadId, 'opt_out');
            await notify(tx, { agencyId: lead.agencyId, userId: lead.agentId, kind: 'warn', text: `${name} replied ${body.trim().toUpperCase()} and was removed from all messages`, leadId });
        }
        else {
            await stopRuns(tx, leadId, 'reply');
            await notify(tx, { agencyId: lead.agencyId, userId: lead.agentId, kind: 'reply', text: `${name} replied by ${channel === 'sms' ? 'SMS' : 'email'}`, leadId });
            if (!lead.agentId)
                await notify(tx, { agencyId: lead.agencyId, userId: null, kind: 'reply', text: `${name} replied by ${channel === 'sms' ? 'SMS' : 'email'}`, leadId });
        }
    });
    emitLead(lead.agencyId, lead.agentId, 'message:new', { leadId });
    return { optedOut: isStop };
}
//# sourceMappingURL=inbound.js.map