// Starting content for a new agency: message templates, the default automations, campaigns and lead sources.
// Used by the demo seed and by bootstrap.ts (first production setup).
import { randomBytes } from 'node:crypto';
import { campaigns, leadSources, templates } from './schema.js';
import { installDefaultAutomations, newLeadCadence, reContactFlow } from '../services/automation.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import { agencies, automations } from './schema.js';
/** Templates used by the new-lead follow-up cadence (client spec). */
export const CADENCE_TEMPLATES = [
    { channel: 'sms', name: 'Follow-up text (1 hour)', body: 'Hi {first}, it’s {agent} with {agency}. I tried to reach you about your {line} quote. When’s a good time for a quick call? Or pick a time here: {booking}' },
    { channel: 'email', name: 'Follow-up email (day 1)', subject: 'Your {line} quote from {agency}', body: 'Hi {first},\n\nThanks for requesting a {line} quote. I tried calling but couldn’t reach you. Reply with a good time to talk, or book a time that suits you here: {booking}\n\n{agent}\n{agency}' },
    { channel: 'sms', name: 'Follow-up text (day 2)', body: 'Hi {first}, {agent} here from {agency}. Still happy to help with your {line} quote. It only takes about 5 minutes. Reply with a good time to call.' },
    { channel: 'email', name: 'Follow-up email (day 2)', subject: 'Quick question about your {line} quote', body: 'Hi {first},\n\nI’d love to get your {line} quote finished. Most people save time and money with a 5-minute call. Book a time here: {booking}\n\n{agent}\n{agency}' },
    { channel: 'sms', name: 'Follow-up text (every few days)', body: 'Hi {first}, it’s {agent} at {agency}. Want me to finish your {line} quote? Reply YES and I’ll call, or pick a time: {booking}' },
    { channel: 'email', name: 'Follow-up email (every few days)', subject: 'Still looking for {line} insurance?', body: 'Hi {first},\n\nJust checking in. If you’re still shopping for {line} insurance, I can compare a few carriers for you. Reply or book a time: {booking}\n\n{agent}\n{agency}' },
    { channel: 'sms', name: 'Monthly check-in text', body: 'Hi {first}, {agent} from {agency} here. Rates change often. Want a fresh {line} quote? {booking}' },
    { channel: 'email', name: 'Monthly check-in email', subject: 'A fresh look at your {line} insurance', body: 'Hi {first},\n\nRates change throughout the year. If you’d like, I can run a fresh {line} quote and see if we can lower what you pay. Book a time here: {booking}\n\n{agent}\n{agency}' },
];
/** [name, isVendor] */
export const DEFAULT_SOURCES = [['Facebook Ads', false], ['Google Ads', false], ['EverQuote', true], ['MediaAlpha', true], ['Website Form', false], ['Referral', false], ['Instagram', false]];
export async function installAgencyDefaults(x, agencyId, sourceCosts = {}) {
    await x.insert(templates).values([
        { agencyId, channel: 'sms', name: 'Welcome', body: 'Hi {first}, thanks for requesting a quote with {agency}! {agent} will call you shortly. Reply STOP to opt out.' },
        { agencyId, channel: 'sms', name: 'Missed you', body: 'Hi {first}, {agent} here from {agency}. Sorry I missed you! When is a good time to talk about your {line} quote?' },
        { agencyId, channel: 'sms', name: 'Booking link', body: 'Hi {first}, pick a time that works for you here: {booking}' },
        { agencyId, channel: 'sms', name: 'Quote ready', body: 'Good news {first}! Your {line} quote is ready. Can I give you a quick call?' },
        { agencyId, channel: 'sms', name: 'Rebook missed appointment', body: 'Hi {first}, we missed you today. Pick a new time that works for you here: {booking}' },
        { agencyId, channel: 'sms', name: 'Review request', body: 'Thanks for choosing {agency}, {first}! Would you leave us a quick review? Google: {google} · Facebook: {facebook} · Yelp: {yelp}' },
        { agencyId, channel: 'email', name: 'Welcome email', subject: 'Welcome to {agency}', body: 'Hi {first},\n\nThanks for reaching out about {line} coverage. {agent} will call you shortly, or you can book a time here: {booking}\n\n{agency}' },
        { agencyId, channel: 'email', name: 'Quote follow-up', subject: 'Your {line} quote', body: 'Hi {first},\n\nFollowing up on the {line} quote I sent. Happy to answer questions or adjust coverage.\n\n{agent}\n{agency}' },
        ...CADENCE_TEMPLATES.map((x) => ({ ...x, agencyId })),
        { agencyId, channel: 'email', name: 'Renewal review', subject: 'Time for your annual policy review', body: 'Hi {first},\n\nYour policy renews soon. Let\'s spend 15 minutes making sure your coverage still fits: {booking}\n\n{agent}' },
    ]);
    await installDefaultAutomations(x, agencyId);
    await x.insert(campaigns).values([
        { agencyId, kind: 'birthday', name: 'Birthday messages', channel: 'sms', body: 'Happy birthday, {first}! Wishing you a great year from all of us at {agency}.' },
        { agencyId, kind: 'holiday', name: 'Thanksgiving', holidayDate: '11-26', body: 'Happy Thanksgiving from all of us at {agency}!' },
        { agencyId, kind: 'holiday', name: 'Christmas', holidayDate: '12-25', body: 'Merry Christmas, {first}! Thank you for trusting {agency}.' },
        { agencyId, kind: 'holiday', name: "New Year's Day", holidayDate: '01-01', body: 'Happy New Year, {first}! Here’s to a safe and healthy year.' },
        { agencyId, kind: 'holiday', name: 'Independence Day', holidayDate: '07-04', active: false, body: 'Happy 4th of July from {agency}!' },
    ]);
    await x.insert(leadSources).values(DEFAULT_SOURCES.map(([name, isVendor]) => ({ agencyId, name, isVendor, costPerLead: sourceCosts[name] ?? 0, webhookKey: randomBytes(16).toString('hex') })));
}
/**
 * One-time upgrade for agencies created before the client feedback: adds the cadence templates, the
 * follow-up cadence and re-contact flows, and switches off the old "New-lead drip". Safe to run on every start.
 */
export async function upgradeAgencyDefaults() {
    for (const a of await db.select({ id: agencies.id }).from(agencies)) {
        const have = await db.query.automations.findFirst({ where: and(eq(automations.agencyId, a.id), eq(automations.name, 'New-lead follow-up cadence')) });
        if (have) {
            // An earlier upgrade added these switched off and never touched since: switch them on.
            if (!have.active && have.updatedAt.getTime() - have.createdAt.getTime() < 1000) {
                await db.update(automations).set({ active: true, updatedAt: new Date() })
                    .where(and(eq(automations.agencyId, a.id), inArray(automations.name, ['New-lead follow-up cadence', 'Re-contact quiet leads']), eq(automations.active, false), sql `${automations.updatedAt} - ${automations.createdAt} < interval '1 second'`));
            }
            continue;
        }
        await db.transaction(async (tx) => {
            const existing = new Set((await tx.query.templates.findMany({ where: eq(templates.agencyId, a.id) })).map((x) => x.name));
            const missing = CADENCE_TEMPLATES.filter((x) => !existing.has(x.name));
            if (missing.length)
                await tx.insert(templates).values(missing.map((x) => ({ ...x, agencyId: a.id })));
            const tpl = await tx.query.templates.findMany({ where: eq(templates.agencyId, a.id) });
            const t = (name) => tpl.find((x) => x.name === name)?.id ?? null;
            await tx.update(automations).set({ active: false }).where(and(eq(automations.agencyId, a.id), inArray(automations.name, ['New-lead drip'])));
            await tx.insert(automations).values([{ ...newLeadCadence(t), agencyId: a.id, active: true }, { ...reContactFlow(t), agencyId: a.id, active: true }]);
        });
        console.log(`Added the follow-up cadence to agency ${a.id}`);
    }
}
//# sourceMappingURL=defaults.js.map