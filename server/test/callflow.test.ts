// Call engine: outbound, listen-in/whisper, transfers, phone menu, missed calls and voicemail — against a fake Twilio REST client.
import { and, eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { agencies, callRecordings, calls, leads, liveCalls, messages, users, voicemails } from '../src/db/schema.js';
import { DEFAULT_SETTINGS } from '../src/domain.js';
import { setTwilioClientForTests } from '../src/integrations/twilio.js';
import { ADMIN, DANIEL, MAYA, app, as } from './helpers.js';

type Op = [string, string | null, Record<string, unknown>];
let log: Op[] = [];
let n = 0;
const sid = () => `CA${String(++n).padStart(32, '0')}`;
const calls$ = Object.assign((s: string) => ({ update: async (v: Record<string, unknown>) => { log.push(['call.update', s, v]); return {}; } }), {
  create: async (v: Record<string, unknown>) => { const s = sid(); log.push(['call.create', s, v]); return { sid: s }; },
});
const conferences$ = (s: string) => ({ update: async (v: Record<string, unknown>) => { log.push(['conf.update', s, v]); return {}; } });

function hook(path: string, params: Record<string, string>) {
  const url = `${process.env.PUBLIC_API_URL}/webhooks/twilio/${path}`;
  return request(app).post(`/webhooks/twilio/${path}`).set('x-twilio-signature', twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, url, params)).type('form').send(params);
}
const user = async (email: string) => (await db.query.users.findFirst({ where: eq(users.email, email) }))!;
const lc = async (id: string) => (await db.query.liveCalls.findFirst({ where: eq(liveCalls.id, id) }))!;
const latestLive = async () => (await db.select().from(liveCalls).orderBy(liveCalls.createdAt)).at(-1)!;
const roomId = (twiml: string) => twiml.match(/pd-([0-9a-f-]{36})/)![1];

async function setSettings(patch: Record<string, unknown>) {
  const a = (await db.select().from(agencies))[0];
  await db.update(agencies).set({ settings: { ...DEFAULT_SETTINGS, ...a.settings, ...patch } as never }).where(eq(agencies.id, a.id));
}
const open24 = { businessDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], businessOpen: '00:00', businessClose: '23:59' };

beforeAll(async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC' + '1'.repeat(32);
  setTwilioClientForTests({ calls: calls$, conferences: conferences$ });
  await db.update(users).set({ status: 'available' });
});
afterAll(() => { setTwilioClientForTests(null); delete process.env.TWILIO_ACCOUNT_SID; });
beforeEach(() => { log = []; });

/** Maya calls one of her leads; returns the live call once the customer has answered. */
async function outbound() {
  const maya = await user(MAYA);
  const lead = (await db.select().from(leads).where(and(eq(leads.agentId, maya.id), isNull(leads.lockedById))))[0];
  const agentSid = sid();
  const r = await hook('voice', { From: `client:${maya.id}`, CallSid: agentSid, leadId: lead.id });
  expect(r.text).toContain('<Conference');
  const id = roomId(r.text);
  await hook(`conf-events?id=${id}`, { StatusCallbackEvent: 'participant-join', CallSid: agentSid, ConferenceSid: 'CF' + '9'.repeat(32) });
  const dialed = log.find((o) => o[0] === 'call.create')!;
  await hook(`customer-status?id=${id}`, { CallStatus: 'in-progress', CallSid: dialed[1]! });
  return { id, maya, lead, agentSid, customerSid: dialed[1]!, dialed };
}

describe('outbound calls', () => {
  it('puts the agent in a room, dials the customer into it, tracks on-call status, and ends cleanly', async () => {
    const { id, maya, lead, dialed, customerSid } = await outbound();
    expect(String(dialed[2].to)).toMatch(/^\+1\d{10}$/);
    expect(String(dialed[2].url)).toContain(`customer-join?id=${id}`);
    expect((await lc(id)).status).toBe('active');
    expect((await user(MAYA)).status).toBe('oncall');
    await hook(`customer-status?id=${id}`, { CallStatus: 'completed', CallSid: customerSid });
    const ended = await lc(id);
    expect(ended.status).toBe('ended');
    expect(log.some((o) => o[0] === 'conf.update' && o[2].status === 'completed')).toBe(true);
    expect((await user(MAYA)).status).toBe('available');
    await db.update(leads).set({ lockedById: null }).where(eq(leads.id, ended.leadId!));
    void maya;
  });

  it('ends the call when the customer doesn’t answer', async () => {
    const maya = await user(MAYA);
    const lead = (await db.select().from(leads).where(and(eq(leads.agentId, maya.id), isNull(leads.lockedById))))[0];
    const a = sid();
    const r = await hook('voice', { From: `client:${maya.id}`, CallSid: a, leadId: lead.id });
    const id = roomId(r.text);
    await hook(`conf-events?id=${id}`, { StatusCallbackEvent: 'participant-join', CallSid: a });
    const cust = log.find((o) => o[0] === 'call.create')![1]!;
    await hook(`customer-status?id=${id}`, { CallStatus: 'no-answer', CallSid: cust });
    expect(await lc(id)).toMatchObject({ status: 'ended', endReason: 'no-answer' });
    await db.update(leads).set({ lockedById: null }).where(eq(leads.id, lead.id));
  });
});

describe('listen in and whisper', () => {
  it('lets the Super Admin join muted or coaching the agent, and nobody else', async () => {
    const { id, agentSid, customerSid, lead } = await outbound();
    const admin = await user(ADMIN), daniel = await user(DANIEL);
    const listen = await hook('voice', { From: `client:${admin.id}`, CallSid: sid(), monitor: id, mode: 'listen' });
    expect(listen.text).toMatch(/muted="true"/);
    expect(listen.text).toContain(`pd-${id}`);
    const whisper = await hook('voice', { From: `client:${admin.id}`, CallSid: sid(), monitor: id, mode: 'whisper' });
    expect(whisper.text).toContain(`coach="${agentSid}"`);
    const agent = await hook('voice', { From: `client:${daniel.id}`, CallSid: sid(), monitor: id, mode: 'listen' });
    expect(agent.text).not.toContain('<Conference');
    // the admin leaving doesn't end the call
    await hook(`conf-events?id=${id}`, { StatusCallbackEvent: 'participant-leave', CallSid: 'CA' + '7'.repeat(32) });
    expect((await lc(id)).status).toBe('active');
    const live = await (await as(ADMIN)).get('/api/calls/live');
    expect(live.body.calls.some((c: { id: string }) => c.id === id)).toBe(true);
    await hook(`customer-status?id=${id}`, { CallStatus: 'completed', CallSid: customerSid });
    await db.update(leads).set({ lockedById: null }).where(eq(leads.id, lead.id));
  });
});

describe('transfers', () => {
  it('warm: rings the other agent, 3-way, then hands the call and the lead over', async () => {
    const { id, agentSid, lead, customerSid } = await outbound();
    const daniel = await user(DANIEL);
    const r = await (await as(MAYA)).post(`/api/calls/live/${id}/transfer`, { mode: 'warm', userId: daniel.id });
    expect(r.status).toBe(200);
    const leg = log.find((o) => o[0] === 'call.create' && o[2].to === `client:${daniel.id}`)!;
    expect(leg).toBeTruthy();
    expect(log.some((o) => o[0] === 'call.update' && o[1] === agentSid)).toBe(false); // warm: Maya stays on
    await hook(`transfer-status?id=${id}`, { CallStatus: 'in-progress', CallSid: leg[1]! });
    expect((await lc(id)).transfer?.state).toBe('joined');
    expect((await (await as(MAYA)).post(`/api/calls/live/${id}/transfer/complete`)).status).toBe(200);
    expect(log.some((o) => o[0] === 'call.update' && o[1] === agentSid && o[2].status === 'completed')).toBe(true);
    // Maya's leg leaving must not end the call
    await hook(`conf-events?id=${id}`, { StatusCallbackEvent: 'participant-leave', CallSid: agentSid });
    const after = await lc(id);
    expect(after.status).toBe('active');
    expect(after.agentId).toBe(daniel.id);
    expect((await db.query.leads.findFirst({ where: eq(leads.id, lead.id) }))!.agentId).toBe(daniel.id);
    await hook(`customer-status?id=${id}`, { CallStatus: 'completed', CallSid: customerSid });
    expect((await lc(id)).status).toBe('ended');
    await db.update(leads).set({ lockedById: null, agentId: (await user(MAYA)).id }).where(eq(leads.id, lead.id));
  });

  it('blind: the agent drops off at once; an outside number takes the call', async () => {
    const { id, agentSid, customerSid, lead } = await outbound();
    const r = await (await as(MAYA)).post(`/api/calls/live/${id}/transfer`, { mode: 'blind', number: '(800) 555-0123' });
    expect(r.status).toBe(200);
    expect(log.some((o) => o[0] === 'call.update' && o[1] === agentSid && o[2].status === 'completed')).toBe(true);
    await hook(`conf-events?id=${id}`, { StatusCallbackEvent: 'participant-leave', CallSid: agentSid });
    expect((await lc(id)).status).toBe('active');
    const leg = log.find((o) => o[0] === 'call.create' && o[2].to === '+18005550123')!;
    await hook(`transfer-status?id=${id}`, { CallStatus: 'in-progress', CallSid: leg[1]! });
    const after = await lc(id);
    expect(after.agentCallSid).toBe(leg[1]);
    expect(after.transfer).toBeNull();
    await hook(`customer-status?id=${id}`, { CallStatus: 'completed', CallSid: customerSid });
    await db.update(leads).set({ lockedById: null }).where(eq(leads.id, lead.id));
  });

  it('only the call’s agent (or the admin) can transfer it', async () => {
    const { id, customerSid, lead } = await outbound();
    const r = await (await as(DANIEL)).post(`/api/calls/live/${id}/transfer`, { mode: 'blind', number: '8005550123' });
    expect(r.status).toBe(403);
    await hook(`customer-status?id=${id}`, { CallStatus: 'completed', CallSid: customerSid });
    await db.update(leads).set({ lockedById: null }).where(eq(leads.id, lead.id));
  });
});

describe('main number phone menu', () => {
  const MAIN = '+15125550100';
  it('plays the menu, rings the chosen agent, and takes a voicemail + texts the booking link when they don’t answer', async () => {
    const maya = await user(MAYA);
    await setSettings({ ...open24, phoneMenu: { ...DEFAULT_SETTINGS.phoneMenu, enabled: true, mainNumber: MAIN, options: [{ digit: '1', label: 'auto and home', userIds: [maya.id] }] }, missedCallTextOn: true });
    const caller = '+14155550161', callerSid = sid();
    const menu = await hook('inbound', { From: caller, To: MAIN, CallSid: callerSid });
    expect(menu.text).toContain('<Gather');
    expect(menu.text).toContain('For auto and home, press 1.');
    const routed = await hook('menu?agency=' + maya.agencyId, { Digits: '1', From: caller, CallSid: callerSid });
    expect(routed.text).toMatch(/startConferenceOnEnter="false"/);
    const ring = log.find((o) => o[0] === 'call.create')!;
    expect(ring[2].to).toBe(`client:${maya.id}`);
    const live = await latestLive();
    expect(live).toMatchObject({ direction: 'in', agentId: maya.id, customerCallSid: callerSid });
    await hook(`agent-status?id=${live.id}`, { CallStatus: 'no-answer', CallSid: ring[1]! });
    expect(log.some((o) => o[0] === 'call.update' && o[1] === callerSid && String(o[2].url).includes(`/vm?id=${live.id}`))).toBe(true);
    const vm = await hook(`vm?id=${live.id}`, { CallSid: callerSid });
    expect(vm.text).toContain('<Record');
    expect(vm.text).toContain(`agent=${maya.id}`);
    await new Promise((r) => setTimeout(r, 300)); // missed-call text is sent in the background
    const lead = (await db.select().from(leads).where(eq(leads.phone, caller)))[0];
    expect(lead).toMatchObject({ source: 'Inbound call', agentId: maya.id });
    const texts = await db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(texts.some((m) => m.channel === 'sms' && m.body.includes('/book/'))).toBe(true);
    // the voicemail lands with Maya
    await hook(`voicemail?agency=${maya.agencyId}&agent=${maya.id}&from=${encodeURIComponent(caller)}`, { RecordingUrl: 'https://api.twilio.com/rec/RE1', RecordingDuration: '14' });
    const vms = (await (await as(MAYA)).get('/api/voicemails')).body;
    expect(vms[0]).toMatchObject({ fromNumber: caller, durationSec: 14, leadId: lead.id });
    expect(vms[0].audio).toMatch(/^\/media\/voicemails\/.+sig=/);
  });

  it('skips agents already on a call', async () => {
    const maya = await user(MAYA);
    await db.update(users).set({ status: 'oncall' }).where(eq(users.id, maya.id));
    const r = await hook('menu?agency=' + maya.agencyId, { Digits: '1', From: '+14155550162', CallSid: sid() });
    expect(r.text).toContain('<Record');
    expect(log.some((o) => o[0] === 'call.create')).toBe(false);
    await db.update(users).set({ status: 'available' }).where(eq(users.id, maya.id));
  });

  it('after hours: message + voicemail, no ringing', async () => {
    await setSettings({ businessDays: [], businessOpen: '09:00', businessClose: '09:01' });
    const r = await hook('inbound', { From: '+14155550163', To: MAIN, CallSid: sid() });
    expect(r.text).toContain('closed');
    expect(r.text).toContain('<Record');
    expect(r.text).not.toContain('<Gather');
    await setSettings({ ...open24, phoneMenu: DEFAULT_SETTINGS.phoneMenu });
  });

  it('caller hangs up while waiting → missed call + text', async () => {
    const maya = await user(MAYA);
    await setSettings({ ...open24, phoneMenu: { ...DEFAULT_SETTINGS.phoneMenu, enabled: true, mainNumber: MAIN, options: [{ digit: '1', label: 'sales', userIds: [maya.id] }] } });
    const caller = '+14155550164', callerSid = sid();
    await hook('menu?agency=' + maya.agencyId, { Digits: '1', From: caller, CallSid: callerSid });
    const live = await latestLive();
    await hook(`conf-events?id=${live.id}`, { StatusCallbackEvent: 'participant-leave', CallSid: callerSid });
    expect(await lc(live.id)).toMatchObject({ status: 'ended', endReason: 'abandoned' });
    expect(log.some((o) => o[0] === 'call.update' && o[1] === live.agentCallSid && o[2].status === 'canceled')).toBe(true);
    await setSettings({ phoneMenu: DEFAULT_SETTINGS.phoneMenu });
  });
});

describe('logging a browser call', () => {
  it('files the conference recording under the call the agent logs', async () => {
    const { id, lead, customerSid } = await outbound();
    await hook(`conf-recording?id=${id}`, { RecordingUrl: 'https://api.twilio.com/rec/RE2', RecordingSid: 'RE2', RecordingDuration: '40' });
    await hook(`customer-status?id=${id}`, { CallStatus: 'completed', CallSid: customerSid });
    const r = await (await as(MAYA)).post(`/api/leads/${lead.id}/calls`, { result: 'call_back', durationSec: 40, liveCallId: id });
    expect(r.status).toBe(201);
    const logged = (await db.select().from(calls).where(eq(calls.leadId, lead.id))).find((c) => c.recordingUrl === 'https://api.twilio.com/rec/RE2');
    expect(logged).toBeTruthy();
    expect(await db.query.callRecordings.findFirst({ where: eq(callRecordings.recordingSid, 'RE2') })).toBeTruthy();
  });
});

describe('speed-dial contacts', () => {
  it('saves personal numbers; only the admin shares with the team', async () => {
    const m = await as(MAYA);
    const c = await m.post('/api/speed-dial/contacts', { name: 'Progressive service', phone: '(800) 776-4737' });
    expect(c.status).toBe(201);
    expect(c.body.phone).toBe('+18007764737');
    expect((await m.post('/api/speed-dial/contacts', { name: 'X', phone: '8005550000', shared: true })).status).toBe(403);
    const shared = await (await as(ADMIN)).post('/api/speed-dial/contacts', { name: 'Travelers claims', phone: '8002528377', shared: true });
    const mine = (await m.get('/api/speed-dial/contacts')).body.map((x: { name: string }) => x.name);
    expect(mine).toEqual(expect.arrayContaining(['Progressive service', 'Travelers claims']));
    expect((await (await as(DANIEL)).get('/api/speed-dial/contacts')).body.map((x: { name: string }) => x.name)).toEqual(['Travelers claims']);
    expect((await (await as(DANIEL)).delete(`/api/speed-dial/contacts/${shared.body.id}`)).status).toBe(403);
    void voicemails;
  });
});
