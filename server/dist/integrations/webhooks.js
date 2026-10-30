// Incoming webhooks from Twilio, SendGrid, Facebook Lead Ads, Google Ads lead forms, and vendors / website forms.
// Every endpoint verifies the sender (signature, secret key or token) before touching data.
import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import multer from 'multer';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, callRecordings, leads, leadSources, users } from '../db/schema.js';
import { LINES } from '../domain.js';
import { ah } from '../lib/http.js';
import { createLead } from '../routes/leads.js';
import { receiveReply } from '../services/inbound.js';
import { notify } from '../services/rules.js';
import { attachRecording, updateSmsStatus } from './delivery.js';
import { last10, toE164 } from './phone.js';
import { cfg, enabled } from './settings.js';
import { messagingResponse, requireTwilioSignature, voiceResponse } from './twilio.js';
export const webhooks = Router();
const form = express.urlencoded({ extended: false });
const json = express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } });
export async function leadByPhone(phone, agencyId) {
    const d = last10(phone);
    if (d.length < 10)
        return null;
    const [l] = await db.select().from(leads).where(and(sql `right(regexp_replace(${leads.phone}, '\\D', '', 'g'), 10) = ${d}`, ...(agencyId ? [eq(leads.agencyId, agencyId)] : []))).orderBy(sql `${leads.updatedAt} desc`).limit(1);
    return l ?? null;
}
const defaultAgency = async () => cfg.defaultAgencyId() || (await db.select({ id: agencies.id }).from(agencies).orderBy(agencies.createdAt).limit(1))[0]?.id;
/* ---------------- Twilio voice ---------------- */
const api = () => cfg.publicApiUrl();
const recordOpts = () => ({ record: 'record-from-answer-dual', recordingStatusCallback: `${api()}/webhooks/twilio/recording`, recordingStatusCallbackEvent: ['completed'] });
/** TwiML App voice URL: the agent's browser dials a lead (param leadId). Ownership is checked again here. */
webhooks.post('/twilio/voice', form, requireTwilioSignature, ah(async (req, res) => {
    const vr = voiceResponse();
    const userId = String(req.body.From ?? '').replace(/^client:/, '');
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    const refuse = (msg) => { vr.say(msg); vr.hangup(); res.type('text/xml').send(vr.toString()); };
    if (!user?.active)
        return refuse('Your account cannot make calls.');
    // Dial pad: a typed number. If it belongs to a lead, the same ownership rules apply as calling the lead.
    let lead = req.body.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, String(req.body.leadId)) }) : null;
    const typed = !req.body.leadId && req.body.to ? toE164(String(req.body.to)) : null;
    if (!req.body.leadId && !typed)
        return refuse('That phone number is not valid.');
    if (typed)
        lead = await leadByPhone(typed, user.agencyId);
    if (lead) {
        const allowed = lead.agencyId === user.agencyId && (user.role === 'admin' || lead.agentId === user.id) && (!lead.lockedById || lead.lockedById === user.id);
        if (!allowed)
            return refuse('You can’t call this lead. It belongs to another agent or is on another call.');
    }
    const to = typed ?? toE164(lead?.phone);
    if (!to)
        return refuse('This lead has no valid phone number.');
    if (lead)
        await db.update(leads).set({ lockedById: user.id }).where(eq(leads.id, lead.id));
    const dial = vr.dial({ callerId: user.twilioNumber || cfg.twilio().callerId, answerOnBridge: true, timeout: 25, ...recordOpts() });
    // Optional recording notice played to the person called when they answer (two-party-consent states).
    if (cfg.twilio().recordingNotice)
        dial.number({ url: `${api()}/webhooks/twilio/notice` }, to);
    else
        dial.number(to);
    res.type('text/xml').send(vr.toString());
}));
webhooks.post('/twilio/notice', form, requireTwilioSignature, (_req, res) => {
    const vr = voiceResponse();
    vr.say(cfg.twilio().recordingNotice || 'This call may be recorded.');
    res.type('text/xml').send(vr.toString());
});
/** Phone number voice URL: inbound call → ring the number's agent, or the lead's owner, in the browser; otherwise voicemail. */
webhooks.post('/twilio/inbound', form, requireTwilioSignature, ah(async (req, res) => {
    const vr = voiceResponse();
    const from = String(req.body.From ?? ''), to = String(req.body.To ?? '');
    const lineOwner = await db.query.users.findFirst({ where: and(eq(users.twilioNumber, toE164(to) ?? to), eq(users.active, true)) });
    const lead = await leadByPhone(from, lineOwner?.agencyId);
    const agentId = lineOwner?.id ?? lead?.agentId ?? null;
    const agencyId = lineOwner?.agencyId ?? lead?.agencyId ?? (await defaultAgency());
    if (agencyId)
        await notify(db, { agencyId, userId: agentId, kind: 'call', text: `Incoming call from ${lead ? `${lead.firstName} ${lead.lastName}` : from}`, leadId: lead?.id ?? null });
    if (agentId) {
        const dial = vr.dial({ answerOnBridge: true, timeout: 20, ...recordOpts(), action: `${api()}/webhooks/twilio/inbound-done` });
        dial.client(agentId);
    }
    else {
        vr.say('Thanks for calling. Please leave a message after the tone.');
        vr.record({ maxLength: 120, playBeep: true, recordingStatusCallback: `${api()}/webhooks/twilio/voicemail?from=${encodeURIComponent(from)}`, recordingStatusCallbackEvent: ['completed'] });
    }
    res.type('text/xml').send(vr.toString());
}));
/** After an inbound <Dial>: if nobody answered, take a voicemail. */
webhooks.post('/twilio/inbound-done', form, requireTwilioSignature, (req, res) => {
    const vr = voiceResponse();
    if (req.body.DialCallStatus !== 'completed') {
        vr.say('Sorry we missed you. Please leave a message after the tone.');
        vr.record({ maxLength: 120, playBeep: true, recordingStatusCallback: `${api()}/webhooks/twilio/voicemail?from=${encodeURIComponent(String(req.body.From ?? ''))}`, recordingStatusCallbackEvent: ['completed'] });
    }
    res.type('text/xml').send(vr.toString());
});
webhooks.post('/twilio/voicemail', form, requireTwilioSignature, ah(async (req, res) => {
    const from = String(req.query.from ?? req.body.From ?? '');
    const lead = await leadByPhone(from);
    const agencyId = lead?.agencyId ?? (await defaultAgency());
    if (agencyId)
        await notify(db, { agencyId, userId: lead?.agentId ?? null, kind: 'call', text: `New voicemail from ${lead ? `${lead.firstName} ${lead.lastName}` : from} (${req.body.RecordingDuration ?? '?'}s)`, leadId: lead?.id ?? null });
    res.sendStatus(204);
}));
/** Recording finished → store it and link it to the logged call (matched on CallSid). */
webhooks.post('/twilio/recording', form, requireTwilioSignature, ah(async (req, res) => {
    if (req.body.RecordingStatus === 'completed' && req.body.CallSid && req.body.RecordingUrl) {
        await db.insert(callRecordings).values({ callSid: String(req.body.CallSid), recordingSid: String(req.body.RecordingSid), url: String(req.body.RecordingUrl), durationSec: Number(req.body.RecordingDuration ?? 0) }).onConflictDoNothing();
        await attachRecording(String(req.body.CallSid));
    }
    res.sendStatus(204);
}));
/* ---------------- Twilio SMS ---------------- */
webhooks.post('/twilio/sms', form, requireTwilioSignature, ah(async (req, res) => {
    const lead = await leadByPhone(String(req.body.From ?? ''));
    if (lead)
        await receiveReply(lead.id, 'sms', String(req.body.Body ?? ''));
    res.type('text/xml').send(messagingResponse().toString()); // empty reply; Twilio Advanced Opt-Out handles STOP confirmations
}));
webhooks.post('/twilio/sms-status', form, requireTwilioSignature, ah(async (req, res) => {
    await updateSmsStatus(String(req.body.MessageSid ?? ''), String(req.body.MessageStatus ?? ''), req.body.ErrorCode ? String(req.body.ErrorCode) : undefined);
    res.sendStatus(204);
}));
/* ---------------- SendGrid Inbound Parse ---------------- */
/** Email replies: reply+<l|c>.<id>@<inbound domain>. Protected by ?key= (Inbound Parse has no signature). */
webhooks.post('/sendgrid/inbound', multer().none(), ah(async (req, res) => {
    const key = cfg.sendgrid().inboundKey;
    if (!key || req.query.key !== key)
        return res.sendStatus(403);
    const to = String(req.body.to ?? '');
    const m = to.match(/reply\+([lc])\.([0-9a-f-]{36})@/i);
    const text = String(req.body.text ?? '').split(/\r?\nOn .+wrote:\r?\n/)[0].split(/\r?\n-{2,}\s*\r?\n/)[0].trim();
    if (m?.[1] === 'l' && text)
        await receiveReply(m[2], 'email', text.slice(0, 5000), String(req.body.subject ?? ''));
    res.sendStatus(200);
}));
const pickLine = (s) => LINES.find((l) => l.toLowerCase() === (s ?? '').trim().toLowerCase()) ?? LINES.find((l) => (s ?? '').toLowerCase().includes(l.toLowerCase())) ?? 'Auto';
async function intake(agencyId, source, l) {
    if (!l.phone || last10(l.phone).length < 10)
        return { ok: false, reason: 'missing phone' };
    if (await leadByPhone(l.phone, agencyId))
        return { ok: true, duplicate: true };
    const lead = await createLead(agencyId, { firstName: (l.firstName || 'Unknown').slice(0, 80), lastName: (l.lastName || '-').slice(0, 80), phone: l.phone, email: l.email && /@/.test(l.email) ? l.email : '', company: l.company, line: pickLine(l.line), source });
    const custom = { ...(l.zip ? { zip: l.zip } : {}), ...(l.extra ?? {}) };
    if (Object.keys(custom).length)
        await db.update(leads).set({ custom }).where(eq(leads.id, lead.id));
    return { ok: true, id: lead.id };
}
/** Normalises common field names from vendors and website forms. */
function fromFields(f) {
    const g = (...keys) => { for (const k of keys) {
        const v = f[k] ?? f[k.toLowerCase()];
        if (v !== undefined && v !== null && String(v).trim())
            return String(v).trim();
    } return ''; };
    const full = g('full_name', 'fullName', 'name');
    const [fn, ...ln] = full.split(/\s+/);
    return {
        firstName: g('first_name', 'firstName', 'fname') || fn || '', lastName: g('last_name', 'lastName', 'lname') || ln.join(' '),
        phone: g('phone', 'phone_number', 'phoneNumber', 'mobile', 'cell'), email: g('email', 'email_address', 'emailAddress'),
        company: g('company', 'company_name', 'business_name'), line: g('line', 'product', 'insurance_type', 'coverage', 'lob'), zip: g('zip', 'zip_code', 'postal_code', 'zipcode'),
    };
}
/** Generic lead webhook for vendors (EverQuote, MediaAlpha, …) and website forms: POST JSON or form data to /webhooks/leads/<key>. */
webhooks.post('/leads/:key', json, form, ah(async (req, res) => {
    const src = await db.query.leadSources.findFirst({ where: eq(leadSources.webhookKey, String(req.params.key)) });
    if (!src)
        return res.status(404).json({ error: 'Unknown source key' });
    const r = await intake(src.agencyId, src.name, fromFields(req.body ?? {}));
    if (!r.ok)
        return res.status(400).json({ error: `Lead rejected: ${r.reason}` });
    res.status(r.duplicate ? 200 : 201).json({ ok: true, duplicate: !!r.duplicate });
}));
/** Facebook Lead Ads: verification handshake. */
webhooks.get('/facebook', (req, res) => {
    const f = cfg.facebook();
    if (req.query['hub.mode'] === 'subscribe' && f.verifyToken && req.query['hub.verify_token'] === f.verifyToken)
        return res.send(String(req.query['hub.challenge'] ?? ''));
    res.sendStatus(403);
});
/** Facebook Lead Ads: leadgen events (signed with the app secret) → fetch the lead from the Graph API. */
webhooks.post('/facebook', json, ah(async (req, res) => {
    const f = cfg.facebook();
    const sig = String(req.header('x-hub-signature-256') ?? '');
    const raw = req.rawBody ?? Buffer.from('');
    const expected = 'sha256=' + createHmac('sha256', f.appSecret).update(raw).digest('hex');
    if (!enabled.facebook() || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
        return res.sendStatus(403);
    res.sendStatus(200); // acknowledge fast; Facebook retries slow responses
    const agencyId = await defaultAgency();
    if (!agencyId)
        return;
    for (const entry of req.body?.entry ?? [])
        for (const ch of entry.changes ?? []) {
            if (ch.field !== 'leadgen' || !ch.value?.leadgen_id)
                continue;
            try {
                const r = await fetch(`https://graph.facebook.com/${f.graphVersion}/${ch.value.leadgen_id}?access_token=${encodeURIComponent(f.pageToken)}`);
                const data = await r.json();
                const fields = Object.fromEntries((data.field_data ?? []).map((x) => [x.name, x.values?.[0] ?? '']));
                await intake(agencyId, 'Facebook Ads', fromFields(fields));
            }
            catch (e) {
                console.error('facebook lead fetch failed', e);
            }
        }
}));
/** Google Ads lead form webhook (key set in the form's webhook settings). */
webhooks.post('/google-ads', json, ah(async (req, res) => {
    const b = req.body ?? {};
    if (!enabled.googleAds() || b.google_key !== cfg.googleAds().webhookKey)
        return res.sendStatus(403);
    const col = Object.fromEntries((b.user_column_data ?? []).map((c) => [c.column_id, c.string_value]));
    const agencyId = await defaultAgency();
    if (!agencyId || b.is_test)
        return res.json({ ok: true, test: !!b.is_test });
    const [fn, ...ln] = String(col.FULL_NAME ?? '').split(/\s+/);
    const r = await intake(agencyId, 'Google Ads', { firstName: col.FIRST_NAME ?? fn ?? '', lastName: col.LAST_NAME ?? ln.join(' '), phone: col.PHONE_NUMBER ?? '', email: col.EMAIL, zip: col.POSTAL_CODE, company: col.COMPANY_NAME });
    res.status(r.ok ? 200 : 400).json(r);
}));
//# sourceMappingURL=webhooks.js.map