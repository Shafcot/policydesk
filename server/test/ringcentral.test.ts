// RingCentral: per-user sign-in, browser phone settings, texting both ways, recordings from the call history.
// A fake RingCentral answers every request, so nothing is ever sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { calls, leads, messages, phoneNumbers, ringcentralConnections, users } from '../src/db/schema.js';
import { accessToken, setRingCentralFetchForTests, syncCallLog, verificationToken } from '../src/integrations/ringcentral.js';
import { attachRecording, deliverQueued } from '../src/integrations/delivery.js';
import { queueMessage } from '../src/services/messaging.js';
import { ADMIN, app, as, freshPhone } from './helpers.js';

type Seen = { url: string; method: string; body: string; auth: string };
const seen: Seen[] = [];
let tokenCount = 0;
const RC_NUMBER = '+15125550111';

function fakeRingCentral(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? init.body : '';
  seen.push({ url, method, body, auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? '') });
  const json = (status: number, j: unknown) => Promise.resolve(new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } }));
  const u = new URL(url);
  if (u.pathname === '/restapi/oauth/token') {
    const p = new URLSearchParams(body);
    if (p.get('code') === 'bliss-erp-key-check') return json(400, { error: 'invalid_grant', error_description: 'Authorization code not found' });
    tokenCount++;
    return json(200, { access_token: `access-${tokenCount}`, refresh_token: `refresh-${tokenCount}`, expires_in: 3600, refresh_token_expires_in: 604800, owner_id: '111' });
  }
  if (u.pathname === '/restapi/oauth/revoke') return json(200, {});
  if (u.pathname === '/restapi/v1.0/account/~/extension/~') return json(200, { id: 111, extensionNumber: '101', account: { id: 999 } });
  if (u.pathname === '/restapi/v1.0/account/~/extension/~/phone-number') return json(200, { records: [{ phoneNumber: RC_NUMBER, features: ['CallerId', 'SmsSender'], usageType: 'DirectNumber' }, { phoneNumber: '+18005550199', features: ['CallerId'], usageType: 'MainCompanyNumber' }] });
  if (u.pathname === '/restapi/v1.0/subscription' && method === 'POST') return json(200, { id: 'sub-1', expirationTime: new Date(Date.now() + 7 * 864e5).toISOString() });
  if (u.pathname.startsWith('/restapi/v1.0/subscription/') && method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
  if (u.pathname === '/restapi/v1.0/client-info/sip-provision') return json(200, { sipInfo: [{ username: '15125550111', password: 'x', authorizationId: '123', domain: 'sip.ringcentral.com', outboundProxy: 'sip10.ringcentral.com:8083', outboundProxyBackup: 'sip20.ringcentral.com:8083', stunServers: [] }] });
  if (u.pathname === '/restapi/v1.0/account/~/extension/~/sms') return json(200, { id: 555, messageStatus: 'Queued' });
  if (u.pathname === '/restapi/v1.0/account/~/extension/~/call-log') return json(200, { records: [{ telephonySessionId: 's-abc123def', duration: 42, recording: { id: 777, contentUri: 'https://media.ringcentral.com/restapi/v1.0/account/999/recording/777/content' } }] });
  if (u.hostname === 'media.ringcentral.com') return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
  return json(404, { message: `Unexpected ${method} ${u.pathname}` });
}

let agentId = '';
let agentToken = '';

beforeAll(async () => {
  process.env.RINGCENTRAL_CLIENT_ID = 'test-rc-client';
  process.env.RINGCENTRAL_CLIENT_SECRET = 'test-rc-secret';
  setRingCentralFetchForTests(fakeRingCentral);
  // A fresh agent with no number yet.
  const a = await as(ADMIN);
  const inv = await a.post('/api/admin/users/invite', { name: 'Rita Central', email: `rita${Date.now()}@example.com`, role: 'agent' });
  agentId = inv.body.user.id;
  const token = new URL(inv.body.inviteLink).searchParams.get('token');
  agentToken = (await request(app).post('/api/auth/accept-invite').send({ token, password: 'RitaPass123' })).body.token;
});
afterAll(() => {
  delete process.env.RINGCENTRAL_CLIENT_ID; delete process.env.RINGCENTRAL_CLIENT_SECRET;
  setRingCentralFetchForTests(null);
});
const agent = () => ({
  get: (p: string) => request(app).get(p).set('authorization', `Bearer ${agentToken}`),
  post: (p: string, b?: object) => request(app).post(p).set('authorization', `Bearer ${agentToken}`).send(b ?? {}),
  del: (p: string) => request(app).delete(p).set('authorization', `Bearer ${agentToken}`),
});

describe('RingCentral', () => {
  it('checks the app keys from Settings → Integrations', async () => {
    const r = await (await as(ADMIN)).post('/api/admin/integrations/test/ringcentral');
    expect(r.body.ok).toBe(true);
    expect(r.body.message).toContain('https://crm.test/api/ringcentral/callback');
  });

  it('connects an agent’s RingCentral line and gives them their RingCentral number', async () => {
    expect((await agent().get('/api/ringcentral/status')).body).toMatchObject({ enabled: true, connected: false, useRingCentral: false });
    const { url } = (await agent().post('/api/ringcentral/connect')).body;
    const auth = new URL(url);
    expect(auth.origin).toBe('https://platform.ringcentral.com');
    expect(auth.searchParams.get('redirect_uri')).toBe('https://crm.test/api/ringcentral/callback');

    // A forged or missing state is refused.
    expect((await request(app).get('/api/ringcentral/callback?code=abc&state=bogus')).text).toContain('wasn’t connected');

    const cb = await request(app).get(`/api/ringcentral/callback?code=abc&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
    expect(cb.status).toBe(200);
    expect(cb.text).toContain('RingCentral connected');
    expect(cb.headers['content-security-policy']).toMatch(/script-src 'nonce-/);

    const c = await db.query.ringcentralConnections.findFirst({ where: eq(ringcentralConnections.userId, agentId) });
    expect(c).toMatchObject({ extensionId: '111', extensionNumber: '101', accountId: '999', subscriptionId: 'sub-1' });
    expect(c!.accessToken).not.toContain('access-'); // stored encrypted

    const n = await db.query.phoneNumbers.findFirst({ where: eq(phoneNumbers.number, RC_NUMBER) });
    expect(n).toMatchObject({ provider: 'ringcentral', userId: agentId, rcExtensionId: '111' });
    expect(await db.query.phoneNumbers.findFirst({ where: eq(phoneNumbers.number, '+18005550199') })).toBeUndefined(); // company number, not theirs
    expect((await db.query.users.findFirst({ where: eq(users.id, agentId) }))!.twilioNumber).toBe(RC_NUMBER);

    const st = (await agent().get('/api/ringcentral/status')).body;
    expect(st).toMatchObject({ connected: true, extensionNumber: '101', useRingCentral: true, line: { number: RC_NUMBER, provider: 'ringcentral' } });
    const sub = seen.find((s) => s.url.endsWith('/restapi/v1.0/subscription'))!;
    expect(JSON.parse(sub.body).deliveryMode).toMatchObject({ transportType: 'WebHook', address: `https://crm.test/webhooks/ringcentral?u=${agentId}`, verificationToken: verificationToken(agentId) });
  });

  it('gives the browser phone its SIP settings', async () => {
    const r = await agent().post('/api/ringcentral/sip');
    expect(r.status).toBe(200);
    expect(r.body.sipInfo).toMatchObject({ username: '15125550111', domain: 'sip.ringcentral.com' });
  });

  it('texts a lead from the agent’s RingCentral number', async () => {
    const admin = await db.query.users.findFirst({ where: eq(users.email, ADMIN) });
    const phone = freshPhone();
    const [lead] = await db.insert(leads).values({ agencyId: admin!.agencyId, firstName: 'Text', lastName: 'Me', phone, line: 'Auto', type: 'personal', source: 'Referral', agentId }).$returningId();
    await queueMessage(db, { kind: 'lead', id: lead.id }, { channel: 'sms', body: 'Hi from RingCentral' });
    await deliverQueued();
    const m = await db.query.messages.findFirst({ where: eq(messages.leadId, lead.id) });
    expect(m).toMatchObject({ status: 'sent', providerId: 'rc:555' });
    const sent = JSON.parse(seen.filter((s) => s.url.endsWith('/extension/~/sms')).at(-1)!.body);
    expect(sent.from.phoneNumber).toBe(RC_NUMBER);
    expect(sent.to[0].phoneNumber.replace(/\D/g, '').slice(-10)).toBe(phone.replace(/\D/g, ''));
    expect(sent.text).toBe('Hi from RingCentral');

    // Replies come back through the webhook: handshake, then only events with this user's token are accepted.
    const hs = await request(app).post(`/webhooks/ringcentral?u=${agentId}`).set('Validation-Token', 'abc-123').send({});
    expect(hs.status).toBe(200);
    expect(hs.headers['validation-token']).toBe('abc-123');
    const event = { body: { id: 9001, type: 'SMS', direction: 'Inbound', from: { phoneNumber: phone }, subject: 'Yes please call me' } };
    expect((await request(app).post(`/webhooks/ringcentral?u=${agentId}`).set('Verification-Token', 'wrong-token-xxxxxxxxxxxxxxxxxxxx').send(event)).status).toBe(403);
    expect((await request(app).post(`/webhooks/ringcentral?u=${agentId}`).set('Verification-Token', verificationToken(agentId)).send(event)).status).toBe(200);
    await request(app).post(`/webhooks/ringcentral?u=${agentId}`).set('Verification-Token', verificationToken(agentId)).send(event); // duplicate delivery
    await new Promise((r) => setTimeout(r, 300));
    const inbound = (await db.select().from(messages).where(eq(messages.leadId, lead.id))).filter((x) => x.direction === 'in');
    expect(inbound).toHaveLength(1);
    expect(inbound[0].body).toBe('Yes please call me');
  });

  it('files the RingCentral recording under the logged call', async () => {
    const admin = await db.query.users.findFirst({ where: eq(users.email, ADMIN) });
    const [lead] = await db.insert(leads).values({ agencyId: admin!.agencyId, firstName: 'Rec', lastName: 'Orded', phone: freshPhone(), line: 'Auto', type: 'personal', source: 'Referral', agentId }).$returningId();
    const logged = await agent().post(`/api/leads/${lead.id}/calls`, { result: 'call_back', durationSec: 40, rcSessionId: 's-abc123def' });
    expect(logged.status).toBe(201);
    const call = await db.query.calls.findFirst({ where: eq(calls.leadId, lead.id) });
    expect(call!.twilioSid).toBe('rc:s-abc123def');

    expect(await syncCallLog(agentId, attachRecording)).toBe(1);
    const withRec = await db.query.calls.findFirst({ where: eq(calls.id, call!.id) });
    expect(withRec!.recordingUrl).toBe(`rc:${agentId}|https://media.ringcentral.com/restapi/v1.0/account/999/recording/777/content`);

    // The signed audio link streams it with the agent's RingCentral sign-in.
    const link = (await agent().get(`/api/calls/${call!.id}/recording-url`)).body.url;
    const audio = await request(app).get(link);
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    expect(seen.filter((s) => s.url.includes('media.ringcentral.com')).at(-1)!.auth).toMatch(/^Bearer access-/);
  });

  it('refreshes an expired sign-in, and disconnects cleanly', async () => {
    await db.update(ringcentralConnections).set({ accessExpiresAt: new Date(Date.now() - 1000) }).where(eq(ringcentralConnections.userId, agentId));
    const before = tokenCount;
    const t = await accessToken(agentId);
    expect(tokenCount).toBe(before + 1);
    expect(t).toBe(`access-${tokenCount}`);
    expect(new URLSearchParams(seen.filter((s) => s.url.endsWith('/oauth/token')).at(-1)!.body).get('grant_type')).toBe('refresh_token');

    expect((await agent().del('/api/ringcentral/connection')).status).toBe(200);
    expect(await db.query.ringcentralConnections.findFirst({ where: eq(ringcentralConnections.userId, agentId) })).toBeUndefined();
    expect(seen.some((s) => s.url.endsWith('/oauth/revoke'))).toBe(true);
    expect((await agent().get('/api/ringcentral/status')).body).toMatchObject({ connected: false, useRingCentral: false });
  });

  it('keeps RingCentral routes away from other users’ lines', async () => {
    // Admin import needs at least one connection; with none it explains what to do.
    const r = await (await as(ADMIN)).post('/api/admin/numbers/sync-ringcentral');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/connect/i);
    expect((await agent().post('/api/admin/numbers/sync-ringcentral')).status).toBe(403);
  });
});
