// Outgoing SMS / email. Every message is stored first; a provider adapter delivers it.
// Until Twilio / SendGrid are connected (Milestone 3) messages stay "queued".
import { eq } from 'drizzle-orm';
import { env } from '../config.js';
import { agencies, customers, leads, messages, users } from '../db/schema.js';
import { DEFAULT_SETTINGS } from '../domain.js';
export const bookingUrl = (slug) => (slug ? `${env.CLIENT_ORIGIN}/book/${slug}` : env.CLIENT_ORIGIN);
export function fill(text, v) {
    return text
        .replace(/\{first\}/g, v.first).replace(/\{agent\}/g, v.agent).replace(/\{agency\}/g, v.agency)
        .replace(/\{line\}/g, v.line.toLowerCase()).replace(/\{booking\}/g, v.booking)
        .replace(/\{google\}/g, v.google).replace(/\{facebook\}/g, v.facebook).replace(/\{yelp\}/g, v.yelp);
}
/** Everything needed to fill a template for a lead or customer. Returns null when the contact is gone. */
export async function contactFor(x, r) {
    if (r.kind === 'lead') {
        const l = await x.query.leads.findFirst({ where: eq(leads.id, r.id) });
        if (!l)
            return null;
        return { agencyId: l.agencyId, agentId: l.agentId, first: l.firstName, name: `${l.firstName} ${l.lastName}`, line: l.line, phone: l.phone, email: l.email, optOut: l.optOut };
    }
    const c = await x.query.customers.findFirst({ where: eq(customers.id, r.id) });
    if (!c)
        return null;
    // A customer who came from a lead shares that lead's opt-out.
    const lead = c.leadId ? await x.query.leads.findFirst({ where: eq(leads.id, c.leadId) }) : null;
    return { agencyId: c.agencyId, agentId: c.agentId, first: c.name.split(' ')[0], name: c.name, line: 'insurance', phone: c.phone, email: c.email, optOut: lead?.optOut ?? false };
}
export async function varsFor(x, contact) {
    const [agency, agent] = await Promise.all([
        x.query.agencies.findFirst({ where: eq(agencies.id, contact.agencyId) }),
        contact.agentId ? x.query.users.findFirst({ where: eq(users.id, contact.agentId) }) : null,
    ]);
    const st = { ...DEFAULT_SETTINGS, ...(agency?.settings ?? {}) };
    return {
        first: contact.first, agent: agent?.name ?? agency?.name ?? '', agency: agency?.name ?? '', line: contact.line,
        booking: bookingUrl(agent?.bookingSlug), google: st.reviewLinks.google, facebook: st.reviewLinks.facebook, yelp: st.reviewLinks.yelp,
    };
}
/**
 * Queues a message. Returns null (and sends nothing) when the contact opted out or has no address for the channel.
 * Opt-out is checked here so no code path can message someone who replied STOP.
 */
export async function queueMessage(x, r, msg) {
    const c = await contactFor(x, r);
    if (!c || c.optOut)
        return null;
    if (msg.channel === 'sms' && !c.phone)
        return null;
    if (msg.channel === 'email' && !c.email)
        return null;
    const [m] = await x.insert(messages).values({
        leadId: r.kind === 'lead' ? r.id : null, customerId: r.kind === 'customer' ? r.id : null, userId: msg.userId ?? null,
        channel: msg.channel, direction: 'out', subject: msg.channel === 'email' ? msg.subject || 'A message from your agent' : null,
        body: msg.body, automated: msg.automated ?? false, status: 'queued',
    }).returning();
    await deliver(m.id);
    return m;
}
/** Provider hook. Milestone 3 replaces this with Twilio (SMS) and SendGrid (email) and updates status to sent/failed. */
export async function deliver(_messageId) {
    /* no provider connected yet: message stays queued */
}
//# sourceMappingURL=messaging.js.map