// Incoming webhooks from Twilio, SendGrid, Facebook Lead Ads, Google Ads lead forms, and vendors / website forms.
// Every endpoint verifies the sender (signature, secret key or token) before touching data.
import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request } from 'express';
import multer from 'multer';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, callRecordings, leads, leadSources, notes, users } from '../db/schema.js';
import { LINES } from '../domain.js';
import { ah } from '../lib/http.js';
import { createLead } from '../routes/leads.js';
import { receiveReply } from '../services/inbound.js';
import { getSettings } from '../services/rules.js';
import { notify } from '../services/rules.js';
import { attachRecording, updateSmsStatus } from './delivery.js';
import { last10, toE164 } from './phone.js';
import { cfg, enabled } from './settings.js';
import { messagingResponse, requireTwilioSignature } from './twilio.js';
import { verificationToken as rcVerificationToken } from './ringcentral.js';
import { callWebhooks, leadByPhone } from './callflow.js';

export const webhooks = Router();
type RawReq = Request & { rawBody?: Buffer };
const form = express.urlencoded({ extended: false });
const json = express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as RawReq).rawBody = buf; } });

export { leadByPhone };
const defaultAgency = async () => cfg.defaultAgencyId() || (await db.select({ id: agencies.id }).from(agencies).orderBy(agencies.createdAt).limit(1))[0]?.id;

/* ---------------- Twilio voice: see callflow.ts (conference-based calls, phone menu, transfers) ---------------- */

webhooks.use('/twilio', callWebhooks);

/** Recording finished → store it and link it to the logged call (matched on CallSid). */
webhooks.post('/twilio/recording', form, requireTwilioSignature, ah(async (req, res) => {
  if (req.body.RecordingStatus === 'completed' && req.body.CallSid && req.body.RecordingUrl) {
    await db.insert(callRecordings).values({ callSid: String(req.body.CallSid), recordingSid: String(req.body.RecordingSid), url: String(req.body.RecordingUrl), durationSec: Number(req.body.RecordingDuration ?? 0) }).onDuplicateKeyUpdate({ set: { callSid: sql`call_sid` } });
    await attachRecording(String(req.body.CallSid));
  }
  res.sendStatus(204);
}));

/* ---------------- Twilio SMS ---------------- */

webhooks.post('/twilio/sms', form, requireTwilioSignature, ah(async (req, res) => {
  const lead = await leadByPhone(String(req.body.From ?? ''));
  if (lead) await receiveReply(lead.id, 'sms', String(req.body.Body ?? ''));
  res.type('text/xml').send(messagingResponse().toString()); // empty reply; Twilio Advanced Opt-Out handles STOP confirmations
}));

webhooks.post('/twilio/sms-status', form, requireTwilioSignature, ah(async (req, res) => {
  await updateSmsStatus(String(req.body.MessageSid ?? ''), String(req.body.MessageStatus ?? ''), req.body.ErrorCode ? String(req.body.ErrorCode) : undefined);
  res.sendStatus(204);
}));

/* ---------------- RingCentral (incoming texts to an agent's RingCentral number) ---------------- */

const seenRc = new Set<string>();
/** RingCentral webhook: first a validation handshake (echo the token), then instant SMS events for that user. */
webhooks.post('/ringcentral', json, ah(async (req, res) => {
  const handshake = req.header('validation-token');
  if (handshake) { res.setHeader('Validation-Token', handshake); return res.sendStatus(200); }
  const userId = String(req.query.u ?? '');
  const given = String(req.header('verification-token') ?? '');
  const want = userId ? rcVerificationToken(userId) : '';
  if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) return res.sendStatus(403);
  res.sendStatus(200); // acknowledge fast; RingCentral retries slow responses
  const m = req.body?.body as { id?: string | number; type?: string; direction?: string; from?: { phoneNumber?: string }; subject?: string } | undefined;
  if (!m || m.type !== 'SMS' || m.direction !== 'Inbound' || !m.from?.phoneNumber || !m.subject) return;
  const key = `${userId}:${m.id}`;
  if (seenRc.has(key)) return; // RingCentral can deliver the same event twice
  seenRc.add(key); if (seenRc.size > 2000) seenRc.delete(seenRc.values().next().value!);
  try {
    const u = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, userId) });
    const lead = u ? await leadByPhone(m.from.phoneNumber, u.agencyId) : null;
    if (lead) await receiveReply(lead.id, 'sms', String(m.subject).slice(0, 5000));
  } catch (e) { console.error('RingCentral text failed', e); }
}));

/* ---------------- SendGrid Inbound Parse ---------------- */

/** Email replies: reply+<l|c>.<id>@<inbound domain>. Protected by ?key= (Inbound Parse has no signature). */
webhooks.post('/sendgrid/inbound', multer().none(), ah(async (req, res) => {
  const key = cfg.sendgrid().inboundKey;
  if (!key || req.query.key !== key) return res.sendStatus(403);
  const to = String(req.body.to ?? '');
  const m = to.match(/reply\+([lc])\.([0-9a-f-]{36})@/i);
  const text = String(req.body.text ?? '').split(/\r?\nOn .+wrote:\r?\n/)[0].split(/\r?\n-{2,}\s*\r?\n/)[0].trim();
  if (m?.[1] === 'l' && text) await receiveReply(m[2], 'email', text.slice(0, 5000), String(req.body.subject ?? ''));
  res.sendStatus(200);
}));

/* ---------------- Lead sources ---------------- */

type LeadIn = { firstName: string; lastName: string; phone: string; email?: string; company?: string; line?: string; zip?: string; extra?: Record<string, string> };
const pickLine = (s?: string) => LINES.find((l) => l.toLowerCase() === (s ?? '').trim().toLowerCase()) ?? LINES.find((l) => (s ?? '').toLowerCase().includes(l.toLowerCase())) ?? 'Auto';

async function intake(agencyId: string, source: string, l: LeadIn) {
  if (!l.phone || last10(l.phone).length < 10) return { ok: false as const, reason: 'missing phone' };
  if (await leadByPhone(l.phone, agencyId)) return { ok: true as const, duplicate: true };
  const lead = await createLead(agencyId, { firstName: (l.firstName || 'Unknown').slice(0, 80), lastName: (l.lastName || '-').slice(0, 80), phone: l.phone, email: l.email && /@/.test(l.email) ? l.email : '', company: l.company, line: pickLine(l.line) as (typeof LINES)[number], source });
  // Extra form questions fill the agency's custom fields (matched by key, label or a common alias); the rest go in a note.
  const st = await getSettings(agencyId);
  const custom: Record<string, string> = l.zip ? { zip: l.zip } : {};
  const leftovers: string[] = [];
  for (const [k, v] of Object.entries(l.extra ?? {})) {
    const key = matchCustomField(k, st.customFields);
    if (key) custom[key] = v; else leftovers.push(`${k.replace(/_/g, ' ')}: ${v}`);
  }
  if (Object.keys(custom).length) await db.update(leads).set({ custom }).where(eq(leads.id, lead.id));
  if (leftovers.length) await db.insert(notes).values({ leadId: lead.id, body: `Form answers from ${source}:\n${leftovers.join('\n')}` });
  return { ok: true as const, id: lead.id };
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const ALIASES: Record<string, string> = { date_of_birth: 'dob', birthdate: 'dob', birth_date: 'dob', birthday: 'dob', current_carrier: 'carrier', current_insurance: 'carrier', current_insurer: 'carrier', insurance_company: 'carrier', current_insurance_company: 'carrier', postal_code: 'zip', zip_code: 'zip', zipcode: 'zip' };
/** Which custom field a form question fills, if any. */
function matchCustomField(question: string, fields: { key: string; label: string }[]) {
  const n = norm(question);
  const want = ALIASES[n] ?? n;
  return fields.find((f) => f.key === want || norm(f.label) === n || norm(f.label) === want)?.key ?? null;
}
const KNOWN = new Set(['full_name', 'fullname', 'name', 'first_name', 'firstname', 'fname', 'last_name', 'lastname', 'lname', 'phone', 'phone_number', 'phonenumber', 'mobile', 'cell', 'email', 'email_address', 'emailaddress', 'company', 'company_name', 'business_name', 'line', 'product', 'insurance_type', 'coverage', 'lob', 'zip', 'zip_code', 'postal_code', 'zipcode', 'google_key', 'key', 'source']);

/**
 * Flattens a vendor payload. Vendors such as MediaAlpha, EverQuote or QuoteWizard nest the person under
 * objects like `lead.contact` or `drivers[0]`. `paths` holds every value by its full path (`lead_contact_phone`);
 * `byKey` also makes it reachable by any trailing part of the path (`contact_phone`, `phone`). Shallower values
 * win, so top-level fields take priority over nested ones.
 */
export function flattenPayload(input: unknown): { paths: Record<string, string>; byKey: Record<string, string> } {
  const paths: Record<string, string> = {}, byKey: Record<string, string> = {};
  const queue: [unknown, string][] = [[input, '']];
  while (queue.length) {
    const [v, path] = queue.shift()!;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) { v.slice(0, 10).forEach((x, i) => queue.push([x, i === 0 ? path : `${path}_${i + 1}`])); continue; }
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 200)) queue.push([x, path ? `${path}_${norm(k)}` : norm(k)]); continue; }
    const s = String(v).trim();
    if (!s || !path || path in paths) continue;
    paths[path] = s;
    const parts = path.split('_');
    for (let i = 0; i < parts.length; i++) { const k = parts.slice(i).join('_'); if (!(k in byKey)) byKey[k] = s; }
  }
  return { paths, byKey };
}

const F = {
  first: ['first_name', 'firstname', 'fname', 'given_name'],
  last: ['last_name', 'lastname', 'lname', 'surname', 'family_name'],
  full: ['full_name', 'fullname', 'contact_name', 'name'],
  phone: ['phone', 'phone_number', 'phonenumber', 'primary_phone', 'home_phone', 'cell_phone', 'mobile_phone', 'day_phone', 'phone1', 'phone_1', 'mobile', 'cell', 'telephone', 'contact_phone', 'work_phone'],
  email: ['email', 'email_address', 'emailaddress', 'primary_email', 'contact_email'],
  company: ['company', 'company_name', 'business_name'],
  line: ['line', 'product', 'insurance_type', 'coverage', 'lob', 'line_of_business', 'vertical', 'lead_type', 'product_type'],
  zip: ['zip', 'zip_code', 'postal_code', 'zipcode', 'postcode'],
};
const USED = new Set(Object.values(F).flat());

/** Normalises common field names from vendors and website forms. Anything else becomes `extra` (custom fields / note). */
export function fromFields(f: Record<string, unknown>): LeadIn {
  const { paths, byKey } = flattenPayload(f);
  const g = (keys: string[]) => { for (const k of keys) if (byKey[k]) return byKey[k]; return ''; };
  const full = g(F.full);
  const [fn, ...ln] = full.split(/\s+/);
  // A path is "used" when it ends in one of the mapped field names (lead_contact_phone ends in phone).
  const isUsed = (p: string) => { const parts = p.split('_'); for (let i = 0; i < parts.length; i++) { const k = parts.slice(i).join('_'); if (USED.has(k) || KNOWN.has(k)) return true; } return false; };
  return {
    firstName: g(F.first) || fn || '', lastName: g(F.last) || ln.join(' '),
    phone: g(F.phone), email: g(F.email), company: g(F.company), line: g(F.line), zip: g(F.zip),
    extra: Object.fromEntries(Object.entries(paths).filter(([p]) => !isUsed(p)).map(([p, v]) => [p, v.slice(0, 500)]).slice(0, 40)),
  };
}

/** Generic lead webhook for vendors (EverQuote, MediaAlpha, …) and website forms: POST JSON or form data to /webhooks/leads/<key>. */
webhooks.post('/leads/:key', json, form, ah(async (req, res) => {
  const src = await db.query.leadSources.findFirst({ where: eq(leadSources.webhookKey, String(req.params.key)) });
  if (!src) return res.status(404).json({ error: 'Unknown source key' });
  const r = await intake(src.agencyId, src.name, fromFields(req.body ?? {}));
  if (!r.ok) return res.status(400).json({ error: `Lead rejected: ${r.reason}` });
  res.status(r.duplicate ? 200 : 201).json({ ok: true, duplicate: !!r.duplicate });
}));

/** Facebook Lead Ads: verification handshake. */
webhooks.get('/facebook', (req, res) => {
  const f = cfg.facebook();
  if (req.query['hub.mode'] === 'subscribe' && f.verifyToken && req.query['hub.verify_token'] === f.verifyToken) return res.send(String(req.query['hub.challenge'] ?? ''));
  res.sendStatus(403);
});

/** Facebook Lead Ads: leadgen events (signed with the app secret) → fetch the lead from the Graph API. */
webhooks.post('/facebook', json, ah(async (req, res) => {
  const f = cfg.facebook();
  const sig = String(req.header('x-hub-signature-256') ?? '');
  const raw = (req as RawReq).rawBody ?? Buffer.from('');
  const expected = 'sha256=' + createHmac('sha256', f.appSecret).update(raw).digest('hex');
  if (!enabled.facebook() || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(403);
  res.sendStatus(200); // acknowledge fast; Facebook retries slow responses
  const agencyId = await defaultAgency(); if (!agencyId) return;
  for (const entry of req.body?.entry ?? []) for (const ch of entry.changes ?? []) {
    if (ch.field !== 'leadgen' || !ch.value?.leadgen_id) continue;
    try {
      const r = await fetch(`https://graph.facebook.com/${f.graphVersion}/${ch.value.leadgen_id}?access_token=${encodeURIComponent(f.pageToken)}`);
      const data = await r.json() as { field_data?: { name: string; values: string[] }[] };
      const fields = Object.fromEntries((data.field_data ?? []).map((x) => [x.name, x.values?.[0] ?? '']));
      await intake(agencyId, 'Facebook Ads', fromFields(fields));
    } catch (e) { console.error('facebook lead fetch failed', e); }
  }
}));

/** Google Ads lead form webhook (key set in the form's webhook settings). */
webhooks.post('/google-ads', json, ah(async (req, res) => {
  const b = req.body ?? {};
  if (!enabled.googleAds() || b.google_key !== cfg.googleAds().webhookKey) return res.sendStatus(403);
  const cols = (b.user_column_data ?? []) as { column_id: string; column_name?: string; string_value: string }[];
  const col = Object.fromEntries(cols.map((c) => [c.column_id, c.string_value]));
  const standard = new Set(['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'PHONE_NUMBER', 'EMAIL', 'POSTAL_CODE', 'COMPANY_NAME']);
  const extra = Object.fromEntries(cols.filter((c) => !standard.has(c.column_id) && c.string_value).map((c) => [c.column_name || c.column_id, c.string_value]));
  const agencyId = await defaultAgency();
  if (!agencyId || b.is_test) return res.json({ ok: true, test: !!b.is_test });
  const [fn, ...ln] = String(col.FULL_NAME ?? '').split(/\s+/);
  const r = await intake(agencyId, 'Google Ads', { firstName: col.FIRST_NAME ?? fn ?? '', lastName: col.LAST_NAME ?? ln.join(' '), phone: col.PHONE_NUMBER ?? '', email: col.EMAIL, zip: col.POSTAL_CODE, company: col.COMPANY_NAME, extra });
  res.status(r.ok ? 200 : 400).json(r);
}));

