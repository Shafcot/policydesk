import { eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { integrationSettings, leads, phoneNumbers, users } from '../src/db/schema.js';
import { ADMIN, DANIEL, MAYA, app, as } from './helpers.js';

const user = async (email: string) => (await db.query.users.findFirst({ where: eq(users.email, email) }))!;

describe('integration keys in the app', () => {
  it('saves keys encrypted, never returns secrets, and validates formats', async () => {
    const a = await as(ADMIN);
    const bad = await a.put('/api/admin/integrations/keys', { values: { TWILIO_ACCOUNT_SID: 'nope' } });
    expect(bad.status).toBe(400);
    const r = await a.put('/api/admin/integrations/keys', { values: { OPENAI_API_KEY: 'sk-test-secret-value-1234', OPENAI_CHAT_MODEL: 'gpt-4o-mini' } });
    expect(r.status).toBe(200);
    const stored = await db.query.integrationSettings.findFirst({ where: eq(integrationSettings.key, 'OPENAI_API_KEY') });
    expect(stored!.value).not.toContain('sk-test');
    const keys = await a.get('/api/admin/integrations/keys');
    expect(JSON.stringify(keys.body)).not.toContain('sk-test-secret');
    const f = keys.body.groups.find((g: { id: string }) => g.id === 'openai').fields.find((x: { key: string }) => x.key === 'OPENAI_API_KEY');
    expect(f).toMatchObject({ source: 'app', preview: '••••1234', value: null });
    // clearing falls back to the environment (unset in tests)
    await a.put('/api/admin/integrations/keys', { values: { OPENAI_API_KEY: null } });
    const after = (await a.get('/api/admin/integrations/keys')).body.groups.find((g: { id: string }) => g.id === 'openai').fields[0];
    expect(after.source).toBeNull();
  });

  it('keeps keys away from agents', async () => {
    const m = await as(MAYA);
    expect((await m.get('/api/admin/integrations/keys')).status).toBe(403);
    expect((await m.put('/api/admin/integrations/keys', { values: { OPENAI_API_KEY: 'x' } })).status).toBe(403);
  });
});

describe('phone numbers', () => {
  it('adds numbers, assigns one per user, and moves numbers between users', async () => {
    const a = await as(ADMIN);
    const maya = await user(MAYA), daniel = await user(DANIEL);
    const n1 = await a.post('/api/admin/numbers', { number: '(512) 555-0181', label: 'Main line', userId: maya.id });
    expect(n1.status).toBe(201);
    expect((await user(MAYA)).twilioNumber).toBe('+15125550181');
    expect((await a.post('/api/admin/numbers', { number: '+15125550181' })).status).toBe(400); // duplicate
    const n2 = await a.post('/api/admin/numbers', { number: '+15125550182' });
    // giving Maya a second number returns the first to the pool
    await a.patch(`/api/admin/numbers/${n2.body.id}`, { userId: maya.id });
    expect((await user(MAYA)).twilioNumber).toBe('+15125550182');
    expect((await db.query.phoneNumbers.findFirst({ where: eq(phoneNumbers.id, n1.body.id) }))!.userId).toBeNull();
    // moving Maya's number to Daniel clears Maya
    await a.patch(`/api/admin/numbers/${n2.body.id}`, { userId: daniel.id });
    expect((await user(MAYA)).twilioNumber).toBeNull();
    expect((await user(DANIEL)).twilioNumber).toBe('+15125550182');
    const list = await a.get('/api/admin/numbers');
    expect(list.body.numbers.find((n: { id: string }) => n.id === n2.body.id).userName).toBe(daniel.name);
    // removing it clears Daniel
    expect((await a.delete(`/api/admin/numbers/${n2.body.id}`)).status).toBe(200);
    expect((await user(DANIEL)).twilioNumber).toBeNull();
    await a.delete(`/api/admin/numbers/${n1.body.id}`);
  });

  it('explains that buying needs Twilio', async () => {
    const r = await (await as(ADMIN)).get('/api/admin/numbers/available?areaCode=512');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Twilio/);
  });

  it('is admin only', async () => {
    expect((await (await as(MAYA)).get('/api/admin/numbers')).status).toBe(403);
  });
});

describe('dial pad', () => {
  function voice(params: Record<string, string>) {
    const url = `${process.env.PUBLIC_API_URL}/webhooks/twilio/voice`;
    return request(app).post('/webhooks/twilio/voice').set('x-twilio-signature', twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, url, params)).type('form').send(params);
  }

  it('looks up typed numbers: own lead, another agent’s lead, or new', async () => {
    const maya = await user(MAYA);
    const own = await db.query.leads.findFirst({ where: eq(leads.agentId, maya.id) });
    const other = (await db.select().from(leads)).find((l) => l.agentId && l.agentId !== maya.id)!;
    const m = await as(MAYA);
    expect((await m.get(`/api/dialpad/lookup?phone=${encodeURIComponent(own!.phone)}`)).body.lead.id).toBe(own!.id);
    expect((await m.get(`/api/dialpad/lookup?phone=${encodeURIComponent(other.phone)}`)).body.blocked).toMatch(/another agent/);
    const fresh = (await m.get('/api/dialpad/lookup?phone=4155550199')).body;
    expect(fresh).toMatchObject({ valid: true, number: '+14155550199', lead: null });
    expect((await m.get('/api/dialpad/lookup?phone=12')).status).toBe(400);
  });

  it('dials typed numbers, but refuses another agent’s lead', async () => {
    const maya = await user(MAYA);
    const ok = await voice({ From: `client:${maya.id}`, to: '+14155550199' });
    expect(ok.text).toContain('<Number');
    expect(ok.text).toContain('+14155550199');
    const other = (await db.select().from(leads)).find((l) => l.agentId && l.agentId !== maya.id && !l.lockedById)!;
    const no = await voice({ From: `client:${maya.id}`, to: other.phone });
    expect(no.text).toContain('another agent');
    expect(no.text).not.toContain('<Number');
  });

  it('can give a lead created from the dial pad to the caller', async () => {
    const r = await (await as(MAYA)).post('/api/leads', { firstName: 'Dial', lastName: 'Pad', phone: '4155550177', line: 'Auto', source: 'Referral', assignToMe: true });
    expect(r.status).toBe(201);
    expect(r.body.agentId).toBe((await user(MAYA)).id);
  });
});
