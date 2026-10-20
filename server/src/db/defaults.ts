// Starting content for a new agency: message templates, the default automations, campaigns and lead sources.
// Used by the demo seed and by bootstrap.ts (first production setup).
import { randomBytes } from 'node:crypto';
import type { DB } from './client.js';
import { campaigns, leadSources, templates } from './schema.js';
import { installDefaultAutomations } from '../services/automation.js';

/** [name, isVendor] */
export const DEFAULT_SOURCES = [['Facebook Ads', false], ['Google Ads', false], ['EverQuote', true], ['MediaAlpha', true], ['Website Form', false], ['Referral', false], ['Instagram', false]] as const;

type Exec = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function installAgencyDefaults(x: Exec, agencyId: string, sourceCosts: Record<string, number> = {}) {
  await x.insert(templates).values([
    { agencyId, channel: 'sms', name: 'Welcome', body: 'Hi {first}, thanks for requesting a quote with {agency}! {agent} will call you shortly. Reply STOP to opt out.' },
    { agencyId, channel: 'sms', name: 'Missed you', body: 'Hi {first}, {agent} here from {agency}. Sorry I missed you! When is a good time to talk about your {line} quote?' },
    { agencyId, channel: 'sms', name: 'Booking link', body: 'Hi {first}, pick a time that works for you here: {booking}' },
    { agencyId, channel: 'sms', name: 'Quote ready', body: 'Good news {first}! Your {line} quote is ready. Can I give you a quick call?' },
    { agencyId, channel: 'sms', name: 'Rebook missed appointment', body: 'Hi {first}, we missed you today. Pick a new time that works for you here: {booking}' },
    { agencyId, channel: 'sms', name: 'Review request', body: 'Thanks for choosing {agency}, {first}! Would you leave us a quick review? Google: {google} · Facebook: {facebook} · Yelp: {yelp}' },
    { agencyId, channel: 'email', name: 'Welcome email', subject: 'Welcome to {agency}', body: 'Hi {first},\n\nThanks for reaching out about {line} coverage. {agent} will call you shortly, or you can book a time here: {booking}\n\n{agency}' },
    { agencyId, channel: 'email', name: 'Quote follow-up', subject: 'Your {line} quote', body: 'Hi {first},\n\nFollowing up on the {line} quote I sent. Happy to answer questions or adjust coverage.\n\n{agent}\n{agency}' },
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
