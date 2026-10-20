import { eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { leads, messages } from '../src/db/schema.js';
import { unsubToken } from '../src/integrations/signed.js';
import { ADMIN, app, as, freshPhone } from './helpers.js';

/** Posts a form to a Twilio webhook, signed the way Twilio signs it. */
function twilioPost(path: string, params: Record<string, string>, sign = true) {
  const url = `${process.env.PUBLIC_API_URL}${path}`;
  const sig = sign ? twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, url, params) : 'bogus';
  return request(app).post(path).set('x-twilio-signature', sig).type('form').send(params);
}

async function newLead(phone = freshPhone()) {
  const r = await (await as(ADMIN)).post('/api/leads', { firstName: 'Reply', lastName: 'Tester', phone, email: 'reply@example.com', line: 'Auto', source: 'Referral' });
  return r.body as { id: string; phone: string };
}

describe('messaging and automations', () => {
  it('queues outgoing messages until a provider is connected', async () => {
    const lead = await newLead();
    const r = await (await as(ADMIN)).post(`/api/leads/${lead.id}/messages`, { channel: 'sms', body: 'Hi there' });
    expect(r.status).toBe(201);
    const [m] = await db.select().from(messages).where(eq(messages.id, r.body.id));
    expect(m.status).toBe('queued');
  });

  it('rejects Twilio webhooks without a valid signature', async () => {
    const r = await twilioPost('/webhooks/twilio/sms', { From: '+14155550000', Body: 'hi' }, false);
    expect(r.status).toBe(403);
  });

  it('threads an inbound SMS reply and stops the drip', async () => {
    const lead = await newLead();
    const r = await twilioPost('/webhooks/twilio/sms', { From: `+1${lead.phone.replace(/\D/g, '')}`, Body: 'Yes please call me' });
    expect(r.status).toBe(200);
    const inbound = await db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(inbound.some((m) => m.direction === 'in' && m.body === 'Yes please call me')).toBe(true);
    const runs = await (await as(ADMIN)).get(`/api/leads/${lead.id}/runs`);
    expect(runs.body.length).toBeGreaterThan(0);
    expect(runs.body.every((x: { status: string; stopReason: string | null }) => x.status !== 'active' && x.status !== 'waiting')).toBe(true);
    expect(runs.body.some((x: { stopReason: string | null }) => x.stopReason === 'reply')).toBe(true);
  });

  it('opts a lead out when they text STOP and blocks further messages', async () => {
    const lead = await newLead();
    await twilioPost('/webhooks/twilio/sms', { From: `+1${lead.phone.replace(/\D/g, '')}`, Body: 'STOP' });
    const saved = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(saved!.optOut).toBe(true);
    const r = await (await as(ADMIN)).post(`/api/leads/${lead.id}/messages`, { channel: 'sms', body: 'Still there?' });
    expect(r.status).toBe(400);
  });

  it('threads an email reply from SendGrid Inbound Parse without the quoted text', async () => {
    const lead = await newLead();
    const r = await request(app).post(`/webhooks/sendgrid/inbound?key=${process.env.SENDGRID_INBOUND_KEY}`)
      .field('to', `reply+l.${lead.id}@reply.crm.test`).field('subject', 'Re: your quote')
      .field('text', 'Sounds good, Tuesday works.\n\nOn Mon, Oct 19, 2026 at 9:00 AM Agent wrote:\n> old text');
    expect(r.status).toBeLessThan(300);
    const rows = await db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(rows.find((m) => m.direction === 'in')?.body).toBe('Sounds good, Tuesday works.');
  });

  it('unsubscribes through the signed email link and rejects tampered links', async () => {
    const lead = await newLead();
    const ok = await request(app).get(`/api/public/unsubscribe/${unsubToken('lead', lead.id)}`);
    expect(ok.status).toBe(200);
    expect((await db.query.leads.findFirst({ where: eq(leads.id, lead.id) }))!.optOut).toBe(true);

    const other = await newLead();
    const bad = await request(app).get(`/api/public/unsubscribe/l.${other.id}.AAAAAAAAAAAAAAAAAAAAAA`);
    expect(bad.text).toContain('not valid');
    expect((await db.query.leads.findFirst({ where: eq(leads.id, other.id) }))!.optOut).toBe(false);
  });
});
