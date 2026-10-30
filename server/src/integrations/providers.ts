// SendGrid (email), OpenAI (transcripts, summaries, AI replies) and Firebase (browser push).
import sgMail from '@sendgrid/mail';
import OpenAI, { toFile } from 'openai';
import { cert, deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { cfg, enabled } from './settings.js';

/* ---------- SendGrid ---------- */

let sgKey = '';
function sg() {
  const k = cfg.sendgrid().apiKey;
  if (k !== sgKey) { sgMail.setApiKey(k); sgKey = k; }
  return sgMail;
}

/** Sends one email. `replyTo` routes replies through Inbound Parse back to the lead's thread. */
export async function sendEmail(e: { to: string; subject: string; text: string; replyTo?: string }) {
  const s = cfg.sendgrid();
  const [res] = await sg().send({ to: e.to, from: { email: s.from, name: s.fromName }, replyTo: e.replyTo, subject: e.subject, text: e.text });
  return { id: String(res.headers['x-message-id'] ?? ''), status: res.statusCode };
}

/* ---------- OpenAI ---------- */

let ai: { key: string; c: OpenAI } | null = null;
export const openai = () => { const k = cfg.openai().apiKey; if (ai?.key !== k) ai = { key: k, c: new OpenAI({ apiKey: k }) }; return ai.c; };

export async function transcribe(audio: ArrayBuffer, filename = 'call.mp3') {
  const r = await openai().audio.transcriptions.create({ model: cfg.openai().transcribeModel, file: await toFile(Buffer.from(audio), filename) });
  return r.text;
}

/** Two-to-three sentence call summary for the lead page. */
export async function summarizeCall(transcript: string, ctx: { lead: string; line: string; result: string }) {
  const r = await openai().chat.completions.create({
    model: cfg.openai().chatModel, temperature: 0.2, max_tokens: 160,
    messages: [
      { role: 'system', content: 'You summarize insurance sales calls for a CRM. Write 2-3 short plain sentences: what the lead wants, key facts (current carrier, renewal date, price, objections), and the agreed next step. No preamble.' },
      { role: 'user', content: `Lead: ${ctx.lead}. Line: ${ctx.line}. Call result: ${ctx.result}.\n\nTranscript:\n${transcript.slice(0, 12000)}` },
    ],
  });
  return r.choices[0]?.message?.content?.trim() ?? '';
}

/** Speed-to-lead first reply: friendly SMS that asks the screening questions and offers the booking link. */
export async function aiSpeedToLead(ctx: { first: string; agency: string; line: string; questions: string[]; booking: string }) {
  const r = await openai().chat.completions.create({
    model: cfg.openai().chatModel, temperature: 0.5, max_tokens: 180,
    messages: [
      { role: 'system', content: 'You write a single SMS (under 320 characters) for an insurance agency replying to a brand-new lead while no agent is free. Be warm and brief, ask the screening questions as a short numbered list, and include the booking link exactly as given. No emojis. Do not promise prices.' },
      { role: 'user', content: `Lead first name: ${ctx.first}. Agency: ${ctx.agency}. They asked about: ${ctx.line}. Questions: ${ctx.questions.join(' | ')}. Booking link: ${ctx.booking}` },
    ],
  });
  return r.choices[0]?.message?.content?.trim() ?? '';
}

/* ---------- Firebase Cloud Messaging ---------- */

let fbKey = '';
async function fcm() {
  const sa = cfg.firebase().serviceAccount;
  if (sa !== fbKey) { await Promise.all(getApps().map((a) => deleteApp(a))); fbKey = ''; }
  if (!getApps().length) { initializeApp({ credential: cert(JSON.parse(sa)) }); fbKey = sa; }
  return getMessaging();
}

/** Sends a browser push to the given device tokens. Returns tokens Firebase reports as invalid so they can be removed. */
export async function pushTo(tokens: string[], n: { title: string; body: string; link: string }) {
  if (!tokens.length) return [];
  const r = await (await fcm()).sendEachForMulticast({ tokens, notification: { title: n.title, body: n.body }, webpush: { fcmOptions: { link: n.link } } });
  return r.responses.map((x, i) => (!x.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(x.error?.code ?? '') ? tokens[i] : null)).filter(Boolean) as string[];
}

export { enabled };
