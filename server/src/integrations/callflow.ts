// Call engine. Every call runs as a Twilio conference ("room"), so an admin can listen in or whisper,
// and an agent can transfer it (warm: stay on the line; blind: drop off).
//
//   Outbound: agent's browser → /voice → agent joins the room → the customer is dialled into it.
//   Inbound:  caller → /inbound (phone menu on the main number) → caller waits in the room → the agent's browser rings.
//   Monitor:  admin's browser → /voice?monitor → joins muted (listen) or coaching the agent (whisper).
//   Transfer: a third leg (another agent's browser or any number) joins the room; the first agent leaves.
import express, { Router } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { callRecordings, leads, liveCalls, notes, phoneNumbers, users, voicemails } from '../db/schema.js';
import type { User } from '../db/schema.js';
import { ah } from '../lib/http.js';
import { getSettings, notify } from '../services/rules.js';
import { emit } from '../services/realtime.js';
import { isBusinessTime } from '../services/hours.js';
import { bookingUrl, queueMessage } from '../services/messaging.js';
import { attachRecording } from './delivery.js';
import { last10, toE164 } from './phone.js';
import { cfg } from './settings.js';
import { flagDeadNumber, isDeadNumber } from '../services/badleads.js';
import { requireTwilioSignature, twilioClient, voiceResponse } from './twilio.js';

export const callWebhooks = Router();
const form = express.urlencoded({ extended: false });
const base = () => cfg.publicApiUrl();
const hook = (path: string, id: string, extra = '') => `${base()}/webhooks/twilio/${path}?id=${id}${extra}`;
export const roomName = (id: string) => `pd-${id}`;
type Live = typeof liveCalls.$inferSelect;
type VR = ReturnType<typeof voiceResponse>;
const xml = (res: express.Response, vr: VR) => res.type('text/xml').send(vr.toString());

/** Adds <Dial><Conference> for this call's room. */
function joinRoom(vr: VR, id: string, o: { label: string; start?: boolean; wait?: boolean; muted?: boolean; coach?: string; record?: boolean }) {
  const dial = vr.dial();
  dial.conference({
    startConferenceOnEnter: o.start ?? true,
    endConferenceOnExit: false, // the engine decides when a call ends (transfers must survive an agent leaving)
    beep: 'false',
    waitUrl: o.wait ? `${base()}/webhooks/twilio/hold` : '',
    participantLabel: o.label,
    ...(o.muted ? { muted: true } : {}),
    ...(o.coach ? { coach: o.coach } : {}),
    ...(o.record === false ? {} : { record: 'record-from-start' as const, recordingStatusCallback: hook('conf-recording', id), recordingStatusCallbackEvent: ['completed' as const] }),
    statusCallback: hook('conf-events', id),
    statusCallbackEvent: ['start', 'end', 'join', 'leave'],
  }, roomName(id));
}

const live = (id: string) => db.query.liveCalls.findFirst({ where: eq(liveCalls.id, id) });
const patchLive = async (id: string, v: Partial<Live>) => (await db.update(liveCalls).set(v).where(eq(liveCalls.id, id)).returning())[0];
const callerIdFor = (u: Pick<User, 'twilioNumber'> | null | undefined) => u?.twilioNumber || cfg.twilio().callerId;

/** Tells the agent's browser and the admins' live-calls view what changed. */
async function push(c: Live, state?: 'ringing' | 'connected' | 'ended', extra: Record<string, unknown> = {}) {
  const payload = { id: c.id, agentCallSid: c.agentCallSid, logCallSid: c.logCallSid, status: c.status, transfer: c.transfer, endReason: c.endReason, ...(state ? { state } : {}), ...extra };
  if (c.agentId) emit(c.agencyId, c.agentId, 'call:state', payload);
  emit(c.agencyId, null, 'calls:changed', { id: c.id });
}

/** On a call = no new calls routed to them. Back to available when the call ends (unless they changed it). */
async function setOnCall(userId: string | null | undefined, on: boolean) {
  if (!userId) return;
  const [u] = await db.update(users).set({ status: on ? 'oncall' : 'available' })
    .where(and(eq(users.id, userId), on ? sql`${users.status} <> 'offline'` : eq(users.status, 'oncall'))).returning();
  if (u) { emit(u.agencyId, u.id, 'me:status', { status: u.status }); emit(u.agencyId, null, 'users:changed', {}); }
}

async function endRoom(c: Live, reason: string) {
  if (c.status === 'ended') return;
  const ended = await patchLive(c.id, { status: 'ended', endedAt: new Date(), endReason: c.endReason ?? reason, transfer: null });
  // End the room, then any leg still ringing or connected (a customer still ringing isn't in the room yet).
  if (c.conferenceSid) await twilioClient().conferences(c.conferenceSid).update({ status: 'completed' }).catch((e) => console.warn('ending conference failed', e?.message));
  for (const sid of [c.agentCallSid, c.customerCallSid, c.transfer?.callSid]) {
    if (!sid) continue;
    await twilioClient().calls(sid).update({ status: 'completed' }).catch(() => twilioClient().calls(sid).update({ status: 'canceled' })).catch(() => undefined);
  }
  await setOnCall(c.agentId, false);
  if (c.transfer?.userId) await setOnCall(c.transfer.userId, false);
  await push(ended, 'ended');
}

export async function leadByPhone(phone: string, agencyId?: string) {
  const d = last10(phone);
  if (d.length < 10) return null;
  const [l] = await db.select().from(leads).where(and(sql`right(regexp_replace(${leads.phone}, '\\D', '', 'g'), 10) = ${d}`, ...(agencyId ? [eq(leads.agencyId, agencyId)] : []))).orderBy(sql`${leads.updatedAt} desc`).limit(1);
  return l ?? null;
}

/* ---------------- Outbound + monitoring (TwiML App voice URL) ---------------- */

callWebhooks.post('/voice', form, requireTwilioSignature, ah(async (req, res) => {
  const vr = voiceResponse();
  const refuse = (msg: string) => { vr.say(msg); vr.hangup(); xml(res, vr); };
  const user = await db.query.users.findFirst({ where: eq(users.id, String(req.body.From ?? '').replace(/^client:/, '')) });
  if (!user?.active) return refuse('Your account cannot make calls.');
  const agentSid = String(req.body.CallSid ?? '');

  // Admin listening in (muted) or whispering to the agent (only the agent hears).
  if (req.body.monitor) {
    const c = await live(String(req.body.monitor));
    if (user.role !== 'admin' || !c || c.agencyId !== user.agencyId || c.status === 'ended') return refuse('That call has ended.');
    const whisper = req.body.mode === 'whisper' && c.agentCallSid;
    joinRoom(vr, c.id, { label: 'monitor', start: false, muted: !whisper, coach: whisper ? c.agentCallSid! : undefined, record: false });
    return xml(res, vr);
  }

  // Dial pad: a typed number. If it belongs to a lead, the same ownership rules apply as calling the lead.
  let lead = req.body.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, String(req.body.leadId)) }) : null;
  const typed = !req.body.leadId && req.body.to ? toE164(String(req.body.to)) : null;
  if (!req.body.leadId && !typed) return refuse('That phone number is not valid.');
  if (typed) lead = await leadByPhone(typed, user.agencyId);
  if (lead) {
    const allowed = lead.agencyId === user.agencyId && (user.role === 'admin' || lead.agentId === user.id) && (!lead.lockedById || lead.lockedById === user.id);
    if (!allowed) return refuse('You can’t call this lead. It belongs to another agent or is on another call.');
  }
  const to = typed ?? toE164(lead?.phone);
  if (!to) return refuse('This lead has no valid phone number.');
  if (lead) await db.update(leads).set({ lockedById: user.id }).where(eq(leads.id, lead.id));
  const [c] = await db.insert(liveCalls).values({ agencyId: user.agencyId, direction: 'out', agentId: user.id, agentCallSid: agentSid, logCallSid: agentSid, customerNumber: to, leadId: lead?.id ?? null }).returning();
  await setOnCall(user.id, true);
  joinRoom(vr, c.id, { label: 'agent' });
  await push(c, 'ringing');
  xml(res, vr);
}));

/** The customer answered an outbound call: optional recording notice, then into the room. */
callWebhooks.post('/customer-join', form, requireTwilioSignature, ah(async (req, res) => {
  const vr = voiceResponse();
  const id = String(req.query.id);
  if (cfg.twilio().recordingNotice) vr.say(cfg.twilio().recordingNotice);
  joinRoom(vr, id, { label: 'customer' });
  xml(res, vr);
}));

/** Outbound customer leg progress: ringing → answered → ended. */
callWebhooks.post('/customer-status', form, requireTwilioSignature, ah(async (req, res) => {
  const c = await live(String(req.query.id));
  if (!c || c.status === 'ended') return res.sendStatus(204);
  const st = String(req.body.CallStatus ?? '');
  if (st === 'ringing') await push(c, 'ringing');
  else if (st === 'in-progress') await push(await patchLive(c.id, { status: 'active', answeredAt: new Date() }), 'connected');
  else if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(st)) {
    await endRoom(c, c.answeredAt ? 'completed' : st);
    // The carrier says the number doesn't exist / isn't in service → Bad number.
    if (st === 'failed' && c.leadId && isDeadNumber(req.body)) await flagDeadNumber(c.leadId);
  }
  res.sendStatus(204);
}));

/* ---------------- Conference events ---------------- */

callWebhooks.post('/conf-events', form, requireTwilioSignature, ah(async (req, res) => {
  const c = await live(String(req.query.id));
  if (!c) return res.sendStatus(204);
  const ev = String(req.body.StatusCallbackEvent ?? '');
  const sid = String(req.body.CallSid ?? '');
  if (ev === 'conference-start' || (!c.conferenceSid && req.body.ConferenceSid)) await patchLive(c.id, { conferenceSid: String(req.body.ConferenceSid) });
  const fresh = (await live(c.id))!;
  if (ev === 'participant-join' && fresh.direction === 'out' && sid === fresh.agentCallSid && !fresh.customerCallSid && fresh.status !== 'ended') {
    // Agent is in the room: dial the customer into it.
    const agent = fresh.agentId ? await db.query.users.findFirst({ where: eq(users.id, fresh.agentId) }) : null;
    try {
      const call = await twilioClient().calls.create({
        to: fresh.customerNumber, from: callerIdFor(agent), timeout: 25,
        url: hook('customer-join', fresh.id), statusCallback: hook('customer-status', fresh.id), statusCallbackEvent: ['ringing', 'answered', 'completed'],
      });
      await patchLive(fresh.id, { customerCallSid: call.sid });
    } catch (e) {
      console.error('dialing customer failed', e);
      await endRoom(fresh, 'failed');
    }
  }
  if (ev === 'participant-leave' && fresh.status !== 'ended') {
    const handoff = fresh.transfer && (fresh.transfer.mode === 'blind' || fresh.transfer.state === 'handoff');
    if (sid === fresh.customerCallSid) {
      if (fresh.direction === 'in' && fresh.status === 'ringing') await missed(fresh, 'abandoned'); // hung up while waiting
      else await endRoom(fresh, 'completed');
    } else if (sid === fresh.agentCallSid && !handoff) await endRoom(fresh, 'completed');
    else if (fresh.transfer?.callSid === sid && fresh.transfer.state !== 'handoff') {
      await push(await patchLive(fresh.id, { transfer: null }), undefined, { transferEnded: true });
    }
  }
  if (ev === 'conference-end') await endRoom(fresh, 'completed');
  res.sendStatus(204);
}));

/** Conference recording → stored under the call the result is logged with. */
callWebhooks.post('/conf-recording', form, requireTwilioSignature, ah(async (req, res) => {
  const c = await live(String(req.query.id));
  if (c?.logCallSid && req.body.RecordingUrl) {
    await db.insert(callRecordings).values({ callSid: c.logCallSid, recordingSid: String(req.body.RecordingSid ?? ''), url: String(req.body.RecordingUrl), durationSec: Number(req.body.RecordingDuration ?? 0) }).onConflictDoNothing();
    await attachRecording(c.logCallSid);
  }
  res.sendStatus(204);
}));

/** What a caller hears while their call is connected or transferred. */
callWebhooks.post('/hold', form, requireTwilioSignature, (_req, res) => {
  const vr = voiceResponse();
  vr.say('Please hold while we connect your call.');
  vr.play({ loop: 0 }, 'http://com.twilio.sounds.music.s3.amazonaws.com/MARKOVICHAMP-Borghestral.mp3');
  xml(res, vr);
});

/* ---------------- Inbound + phone menu ---------------- */

/** Phone number voice URL. The main number plays the phone menu; an agent's own number rings that agent. */
callWebhooks.post('/inbound', form, requireTwilioSignature, ah(async (req, res) => {
  const vr = voiceResponse();
  const from = toE164(String(req.body.From ?? '')) ?? String(req.body.From ?? '');
  const to = toE164(String(req.body.To ?? '')) ?? String(req.body.To ?? '');
  const num = await db.query.phoneNumbers.findFirst({ where: eq(phoneNumbers.number, to) });
  const agencyId = num?.agencyId ?? (await db.query.users.findFirst({ where: eq(users.twilioNumber, to) }))?.agencyId ?? (await defaultAgency());
  if (!agencyId) { vr.say('This number is not in service.'); return xml(res, vr); }
  const st = await getSettings(agencyId);
  const agencyName = await agencyLabel(agencyId);
  const menu = st.phoneMenu;
  const isMain = menu.enabled && menu.mainNumber && toE164(menu.mainNumber) === to;
  const lead = await leadByPhone(from, agencyId);
  const sid = String(req.body.CallSid ?? '');

  if (isMain) {
    if (!isBusinessTime(new Date(), st)) {
      vr.say(fill(menu.afterHoursMessage, agencyName));
      return voicemailTwiml(vr, { agencyId, userId: lead?.agentId ?? null, from, callSid: sid, afterHours: true }), xml(res, vr);
    }
    const g = vr.gather({ numDigits: 1, timeout: 6, action: `${base()}/webhooks/twilio/menu?agency=${agencyId}`, method: 'POST' });
    g.say([fill(menu.greeting, agencyName), ...menu.options.filter((o) => o.digit && o.label).map((o) => `For ${o.label}, press ${o.digit}.`)].join(' '));
    vr.redirect({ method: 'POST' }, `${base()}/webhooks/twilio/menu?agency=${agencyId}&none=1`);
    return xml(res, vr);
  }
  // Direct line: the number's user, else the lead's owner.
  const ownerId = num?.userId ?? (await db.query.users.findFirst({ where: and(eq(users.twilioNumber, to), eq(users.active, true)) }))?.id ?? lead?.agentId ?? null;
  await route(vr, { agencyId, candidates: ownerId ? [ownerId] : [], from, callSid: sid, leadId: lead?.id ?? null, label: 'direct line' });
  xml(res, vr);
}));

/** Phone menu choice → the option's people (first available rings). No choice → default people or any available agent. */
callWebhooks.post('/menu', form, requireTwilioSignature, ah(async (req, res) => {
  const vr = voiceResponse();
  const agencyId = String(req.query.agency);
  const st = await getSettings(agencyId);
  const digit = req.query.none ? '' : String(req.body.Digits ?? '');
  const opt = st.phoneMenu.options.find((o) => o.digit === digit);
  const from = toE164(String(req.body.From ?? '')) ?? String(req.body.From ?? '');
  const lead = await leadByPhone(from, agencyId);
  const candidates = opt ? opt.userIds : st.phoneMenu.defaultUserIds;
  // A known lead with no choice goes to their own agent first.
  const ordered = !opt && lead?.agentId ? [lead.agentId, ...candidates.filter((x) => x !== lead.agentId)] : candidates;
  await route(vr, { agencyId, candidates: ordered, anyAgent: !opt && !candidates.length, from, callSid: String(req.body.CallSid ?? ''), leadId: lead?.id ?? null, label: opt?.label ?? 'main line' });
  xml(res, vr);
}));

/** Rings the first available person (in the browser) while the caller waits in the room; nobody free → voicemail. */
async function route(vr: VR, r: { agencyId: string; candidates: string[]; anyAgent?: boolean; from: string; callSid: string; leadId: string | null; label: string }) {
  let pool = r.candidates.length
    ? await db.query.users.findMany({ where: and(inArray(users.id, r.candidates), eq(users.agencyId, r.agencyId), eq(users.active, true)) })
    : r.anyAgent ? await db.query.users.findMany({ where: and(eq(users.agencyId, r.agencyId), eq(users.active, true), eq(users.role, 'agent')) }) : [];
  pool = pool.filter((u) => !u.inviteToken);
  const order = new Map(r.candidates.map((id, i) => [id, i]));
  pool.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  const agent = pool.find((u) => u.status === 'available');
  const voicemailFor = agent?.id ?? r.candidates[0] ?? null;
  if (!agent || !cfg.twilio().accountSid) {
    vr.say('Sorry, nobody is available to take your call right now.');
    return voicemailTwiml(vr, { agencyId: r.agencyId, userId: voicemailFor, from: r.from, callSid: r.callSid });
  }
  const [c] = await db.insert(liveCalls).values({ agencyId: r.agencyId, direction: 'in', agentId: agent.id, customerCallSid: r.callSid, customerNumber: r.from, leadId: r.leadId }).returning();
  try {
    const leg = await twilioClient().calls.create({
      to: `client:${agent.id}`, from: r.from, timeout: 20,
      url: hook('agent-join', c.id), statusCallback: hook('agent-status', c.id), statusCallbackEvent: ['answered', 'completed'],
    });
    const withLeg = await patchLive(c.id, { agentCallSid: leg.sid, logCallSid: leg.sid });
    await incoming(withLeg, agent.id, r.label);
    joinRoom(vr, c.id, { label: 'customer', start: false, wait: true });
  } catch (e) {
    console.error('ringing agent failed', e);
    await patchLive(c.id, { status: 'ended', endedAt: new Date(), endReason: 'failed' });
    vr.say('Sorry, we could not connect your call.');
    voicemailTwiml(vr, { agencyId: r.agencyId, userId: agent.id, from: r.from, callSid: r.callSid });
  }
}

/** Tells the ringing agent's browser who is calling, so the call bar can show the lead. */
async function incoming(c: Live, userId: string, label: string, transferFrom?: string) {
  const lead = c.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, c.leadId) }) : null;
  emit(c.agencyId, userId, 'call:incoming', { id: c.id, callSid: c.transfer?.userId === userId ? c.transfer.callSid : c.agentCallSid, number: c.customerNumber, leadId: lead?.id ?? null, leadName: lead ? `${lead.firstName} ${lead.lastName}` : null, label, transferFrom: transferFrom ?? null });
  emit(c.agencyId, null, 'calls:changed', { id: c.id });
}

/** The agent answered an inbound call: into the room; the caller stops waiting. */
callWebhooks.post('/agent-join', form, requireTwilioSignature, ah(async (req, res) => {
  const vr = voiceResponse();
  const c = await live(String(req.query.id));
  if (!c || c.status === 'ended') { vr.hangup(); return xml(res, vr); }
  joinRoom(vr, c.id, { label: 'agent' });
  xml(res, vr);
}));

callWebhooks.post('/agent-status', form, requireTwilioSignature, ah(async (req, res) => {
  const c = await live(String(req.query.id));
  if (!c || c.status === 'ended') return res.sendStatus(204);
  const st = String(req.body.CallStatus ?? '');
  if (st === 'in-progress') { await setOnCall(c.agentId, true); await push(await patchLive(c.id, { status: 'active', answeredAt: new Date() }), 'connected'); }
  else if (c.status === 'ringing' && ['busy', 'no-answer', 'failed', 'canceled', 'completed'].includes(st)) {
    // Not answered: the caller leaves a voicemail for that agent.
    await patchLive(c.id, { status: 'ended', endedAt: new Date(), endReason: 'missed' });
    if (c.customerCallSid) await twilioClient().calls(c.customerCallSid).update({ url: hook('vm', c.id), method: 'POST' }).catch((e) => console.warn('voicemail redirect failed', e));
    await push((await live(c.id))!, 'ended');
  }
  res.sendStatus(204);
}));

/** Voicemail prompt for a call nobody answered. */
callWebhooks.post('/vm', form, requireTwilioSignature, ah(async (req, res) => {
  const vr = voiceResponse();
  const c = await live(String(req.query.id));
  if (!c) { vr.hangup(); return xml(res, vr); }
  const userId = req.query.agent ? String(req.query.agent) : c.agentId;
  vr.say('Sorry we missed you.');
  voicemailTwiml(vr, { agencyId: c.agencyId, userId, from: c.customerNumber, callSid: c.customerCallSid ?? '' });
  xml(res, vr);
}));

function voicemailTwiml(vr: VR, v: { agencyId: string; userId: string | null; from: string; callSid: string; afterHours?: boolean }) {
  if (!v.afterHours) vr.say('Please leave a message after the tone.');
  vr.record({ maxLength: 120, playBeep: true, recordingStatusCallback: `${base()}/webhooks/twilio/voicemail?agency=${v.agencyId}&agent=${v.userId ?? ''}&from=${encodeURIComponent(v.from)}`, recordingStatusCallbackEvent: ['completed'] });
  // The missed-call text goes out now (whether or not they leave a message).
  setImmediate(() => { missedText(v.agencyId, v.userId, v.from).catch((e) => console.error('missed-call text failed', e)); });
}

async function missed(c: Live, reason: string) {
  await patchLive(c.id, { status: 'ended', endedAt: new Date(), endReason: reason });
  if (c.agentCallSid) await twilioClient().calls(c.agentCallSid).update({ status: 'canceled' }).catch(() => undefined);
  await push((await live(c.id))!, 'ended');
  await notify(db, { agencyId: c.agencyId, userId: c.agentId, kind: 'call', text: `Missed call from ${c.customerNumber}`, leadId: c.leadId });
  await missedText(c.agencyId, c.agentId, c.customerNumber);
}

/** Missed / after-hours callers get a text with the booking link (once per 12 hours per number). */
export async function missedText(agencyId: string, userId: string | null, from: string) {
  const st = await getSettings(agencyId);
  if (!st.missedCallTextOn || last10(from).length < 10) return null;
  const agent = userId ? await db.query.users.findFirst({ where: eq(users.id, userId) }) : null;
  let lead = await leadByPhone(from, agencyId);
  if (lead?.optOut) return null;
  if (!lead) {
    // Unknown caller → a lead, so the text, any reply and the voicemail live in one place.
    [lead] = await db.insert(leads).values({ agencyId, firstName: 'Caller', lastName: from.slice(-4), phone: from, line: 'Auto', type: 'personal', source: 'Inbound call', agentId: agent?.role === 'agent' ? agent.id : null }).returning();
    await db.insert(notes).values({ leadId: lead.id, body: `Created from a missed call from ${from}. Update the name after you speak with them.` });
  }
  const recent = await db.execute(sql`select 1 from messages where lead_id = ${lead.id} and direction = 'out' and channel = 'sms' and automated = true and body like ${'%/book/%'} and created_at > now() - interval '12 hours' limit 1`);
  if (recent.rows.length) return null;
  const owner = agent ?? (lead.agentId ? await db.query.users.findFirst({ where: eq(users.id, lead.agentId) }) : null)
    ?? (await db.query.users.findFirst({ where: and(eq(users.agencyId, agencyId), eq(users.role, 'admin')) }));
  const body = fill(st.missedCallText, await agencyLabel(agencyId)).replaceAll('{booking}', bookingUrl(owner?.bookingSlug));
  return queueMessage(db, { kind: 'lead', id: lead.id }, { channel: 'sms', body, automated: true });
}

/** Voicemail recorded → saved for the agent it was meant for (or the agency) and they're notified. */
callWebhooks.post('/voicemail', form, requireTwilioSignature, ah(async (req, res) => {
  const from = String(req.query.from ?? req.body.From ?? '');
  const agencyId = String(req.query.agency || '') || (await defaultAgency());
  if (!agencyId || !req.body.RecordingUrl) return res.sendStatus(204);
  const userId = req.query.agent ? String(req.query.agent) : null;
  const lead = await leadByPhone(from, agencyId);
  const [vm] = await db.insert(voicemails).values({ agencyId, userId: userId || lead?.agentId || null, leadId: lead?.id ?? null, fromNumber: from.slice(0, 20), recordingUrl: String(req.body.RecordingUrl), durationSec: Number(req.body.RecordingDuration ?? 0) }).returning();
  await notify(db, { agencyId, userId: vm.userId, kind: 'call', text: `New voicemail from ${lead ? `${lead.firstName} ${lead.lastName}` : from} (${vm.durationSec}s)`, leadId: lead?.id ?? null });
  emit(agencyId, vm.userId, 'voicemail:new', { id: vm.id });
  res.sendStatus(204);
}));

/* ---------------- Transfers (called from the API) ---------------- */

/** Starts a transfer: rings another agent's browser or any number into the room. Blind = the agent drops off now. */
export async function startTransfer(c: Live, by: User, t: { mode: 'warm' | 'blind'; userId?: string; number?: string }) {
  const target = t.userId ? await db.query.users.findFirst({ where: and(eq(users.id, t.userId), eq(users.agencyId, c.agencyId), eq(users.active, true)) }) : null;
  if (t.userId && !target) throw new Error('That user can’t take calls');
  const number = t.number ? toE164(t.number) : null;
  if (!target && !number) throw new Error('Pick an agent or enter a valid number');
  const leg = await twilioClient().calls.create({
    to: target ? `client:${target.id}` : number!, from: target ? c.customerNumber : callerIdFor(by), timeout: 25,
    url: hook('transfer-join', c.id), statusCallback: hook('transfer-status', c.id), statusCallbackEvent: ['answered', 'completed'],
  });
  const label = target?.name ?? number!;
  const withT = await patchLive(c.id, { transfer: { mode: t.mode, callSid: leg.sid, userId: target?.id ?? null, number, label, state: 'ringing' } });
  if (target) await incoming(withT, target.id, 'transfer', by.name);
  if (t.mode === 'blind') {
    if (c.conferenceSid) await twilioClient().conferences(c.conferenceSid).update({ announceUrl: `${base()}/webhooks/twilio/transfer-announce` }).catch(() => undefined);
    if (c.agentCallSid) await twilioClient().calls(c.agentCallSid).update({ status: 'completed' }).catch(() => undefined);
    await setOnCall(c.agentId, false);
  }
  await push(withT);
  return withT;
}

/** Warm transfer: the first agent leaves, the target keeps the call. */
export async function completeTransfer(c: Live) {
  if (!c.transfer || c.transfer.state !== 'joined') throw new Error('The other person hasn’t joined yet');
  await patchLive(c.id, { transfer: { ...c.transfer, state: 'handoff' } });
  if (c.agentCallSid) await twilioClient().calls(c.agentCallSid).update({ status: 'completed' }).catch(() => undefined);
  await handOver((await live(c.id))!);
}

export async function cancelTransfer(c: Live) {
  if (c.transfer?.callSid) await twilioClient().calls(c.transfer.callSid).update({ status: 'completed' }).catch(() => undefined);
  await push(await patchLive(c.id, { transfer: null }), undefined, { transferEnded: true });
}

/** The target now owns the call (and the lead, when it's another agent). */
async function handOver(c: Live) {
  const t = c.transfer!;
  const prev = c.agentId;
  await setOnCall(prev, false);
  if (prev) emit(c.agencyId, prev, 'call:state', { id: c.id, state: 'ended', handedOff: true, agentCallSid: c.agentCallSid });
  const next = await patchLive(c.id, { agentId: t.userId ?? null, agentCallSid: t.callSid ?? null, transfer: null });
  if (t.userId) {
    await setOnCall(t.userId, true);
    if (c.leadId) {
      await db.update(leads).set({ agentId: t.userId, lockedById: t.userId, updatedAt: new Date() }).where(eq(leads.id, c.leadId));
      await db.insert(notes).values({ leadId: c.leadId, userId: prev, body: `Call transferred to ${t.label} (${t.mode}). The lead is now theirs.` });
    }
  } else if (c.leadId) await db.insert(notes).values({ leadId: c.leadId, userId: prev, body: `Call transferred to ${t.label} (${t.mode}).` });
  await push(next, 'connected');
}

callWebhooks.post('/transfer-join', form, requireTwilioSignature, ah(async (req, res) => {
  const vr = voiceResponse();
  const c = await live(String(req.query.id));
  if (!c || c.status === 'ended') { vr.say('This call has ended.'); vr.hangup(); return xml(res, vr); }
  joinRoom(vr, c.id, { label: 'transfer' });
  xml(res, vr);
}));

callWebhooks.post('/transfer-announce', form, requireTwilioSignature, (_req, res) => {
  const vr = voiceResponse(); vr.say('Please hold while I transfer your call.'); xml(res, vr);
});

callWebhooks.post('/transfer-status', form, requireTwilioSignature, ah(async (req, res) => {
  const c = await live(String(req.query.id));
  if (!c?.transfer || c.status === 'ended' || req.body.CallSid !== c.transfer.callSid) return res.sendStatus(204);
  const st = String(req.body.CallStatus ?? '');
  if (st === 'in-progress') {
    const joined = await patchLive(c.id, { transfer: { ...c.transfer, state: 'joined' } });
    if (joined.transfer?.userId) await setOnCall(joined.transfer.userId, true);
    if (c.transfer.mode === 'blind') await handOver(joined); else await push(joined);
  } else if (c.transfer.state === 'ringing' && ['busy', 'no-answer', 'failed', 'canceled', 'completed'].includes(st)) {
    if (c.transfer.mode === 'blind') {
      // Nobody picked up and the first agent already left: voicemail for the target agent, or a polite goodbye.
      if (c.customerCallSid) await twilioClient().calls(c.customerCallSid).update({ url: hook('vm', c.id, c.transfer.userId ? `&agent=${c.transfer.userId}` : ''), method: 'POST' }).catch(() => undefined);
      await patchLive(c.id, { status: 'ended', endedAt: new Date(), endReason: 'transfer_failed', transfer: null });
      await push((await live(c.id))!, 'ended');
    } else await push(await patchLive(c.id, { transfer: { ...c.transfer, state: 'failed' } }), undefined, { transferFailed: st });
  }
  res.sendStatus(204);
}));

/* ---------------- helpers ---------------- */

async function defaultAgency() {
  const a = cfg.defaultAgencyId();
  if (a) return a;
  const r = await db.execute<{ id: string }>(sql`select id from agencies order by created_at limit 1`);
  return r.rows[0]?.id ?? null;
}
async function agencyLabel(agencyId: string) {
  const r = await db.execute<{ name: string }>(sql`select name from agencies where id = ${agencyId}`);
  return r.rows[0]?.name ?? 'our agency';
}
const fill = (t: string, agency: string) => t.replaceAll('{agency}', agency);
