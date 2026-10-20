// Broadcast / holiday campaigns (SOW 4). Opted-out contacts are never messaged.
import { and, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { campaigns, customers, leads } from '../db/schema.js';
import { STAGES, type Stage } from '../domain.js';
import { contactFor, fill, queueMessage, varsFor, type Recipient } from './messaging.js';

export type Audience = { stage?: string; line?: string; type?: string; includeCustomers?: boolean };

export async function audienceFor(agencyId: string, a: Audience) {
  const where: SQL[] = [eq(leads.agencyId, agencyId)];
  if (a.stage && (STAGES as readonly string[]).includes(a.stage)) where.push(eq(leads.stage, a.stage as Stage));
  if (a.line) where.push(eq(leads.line, a.line));
  if (a.type === 'personal' || a.type === 'commercial') where.push(eq(leads.type, a.type));
  const ls = await db.select({ id: leads.id, optOut: leads.optOut }).from(leads).where(and(...where));
  // Customers who came from a lead are reached through that lead. Customers with no lead (e.g. imported)
  // are added when "include customers" is on and no lead-only filter (stage) is set.
  const cs = a.includeCustomers && !a.stage
    ? await db.select({ id: customers.id }).from(customers).where(and(eq(customers.agencyId, agencyId), isNull(customers.leadId), isNotNull(customers.phone),
      ...(a.type === 'personal' || a.type === 'commercial' ? [eq(customers.type, a.type)] : [])))
    : [];
  const recipients: Recipient[] = [...ls.filter((l) => !l.optOut).map((l) => ({ kind: 'lead' as const, id: l.id })), ...cs.map((c) => ({ kind: 'customer' as const, id: c.id }))];
  return { recipients, excluded: ls.filter((l) => l.optOut).length };
}

export async function sendBroadcast(campaignId: string, override?: Audience) {
  const c = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!c) return null;
  const { recipients, excluded } = await audienceFor(c.agencyId, override ?? c.audience ?? {});
  let sent = 0;
  for (const r of recipients) {
    const contact = await contactFor(db, r); if (!contact) continue;
    const m = await queueMessage(db, r, { channel: c.channel, body: fill(c.body, await varsFor(db, contact)), subject: c.subject, automated: true });
    if (m) sent++;
  }
  if (c.kind === 'broadcast') await db.update(campaigns).set({ sentAt: new Date(), recipients: sent, excluded }).where(eq(campaigns.id, c.id));
  else await db.update(campaigns).set({ sentAt: new Date(), recipients: c.recipients + sent }).where(eq(campaigns.id, c.id));
  return { sent, excluded };
}
