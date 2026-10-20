// Signed-in endpoints for integrations: status, browser-calling token, recordings, push registration.
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { calls, deviceTokens, leads, users } from '../db/schema.js';
import { ah, notFound } from '../lib/http.js';
import { requireAdmin, type AuthedRequest } from '../middleware/auth.js';
import { integrationStatus, cfg, enabled } from '../integrations/settings.js';
import { signPath, verifyPath, readUnsubToken } from '../integrations/signed.js';
import { fetchRecording, voiceToken } from '../integrations/twilio.js';
import { getVisibleLead } from '../services/scope.js';
import { stopRuns } from '../services/automation.js';
import { env } from '../config.js';

export const integrationsRouter = Router();

integrationsRouter.get('/integrations/status', ah<AuthedRequest>(async (req, res) => {
  const st = integrationStatus();
  if (req.user.role !== 'admin') return res.json({ voice: st.voice, sms: st.sms, email: st.email, push: st.push });
  const api = cfg.publicApiUrl() || '(set PUBLIC_API_URL)';
  res.json({ ...st, webhooks: {
    twilioVoiceApp: `${api}/webhooks/twilio/voice`, twilioInbound: `${api}/webhooks/twilio/inbound`, twilioSms: `${api}/webhooks/twilio/sms`,
    sendgridInbound: `${api}/webhooks/sendgrid/inbound?key=<SENDGRID_INBOUND_KEY>`, facebook: `${api}/webhooks/facebook`, googleAds: `${api}/webhooks/google-ads`, leads: `${api}/webhooks/leads/<source key>`,
  } });
}));

/** Browser calling token (Twilio Voice SDK). 404 when calling is not connected, so the dialer stays in manual mode. */
integrationsRouter.get('/voice/token', ah<AuthedRequest>(async (req, res) => {
  if (!enabled.voice()) throw notFound('Calling is not connected yet');
  res.json({ token: voiceToken(req.user.id), identity: req.user.id });
}));

/** Admin sets an agent's Twilio number (caller ID + inbound routing). */
integrationsRouter.patch('/admin/users/:id/twilio-number', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  const { number } = z.object({ number: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable() }).parse(req.body);
  const [u] = await db.update(users).set({ twilioNumber: number }).where(and(eq(users.id, String(req.params.id)), eq(users.agencyId, req.user.agencyId))).returning();
  if (!u) throw notFound('User not found');
  res.json({ twilioNumber: u.twilioNumber });
}));

/** Signed, short-lived link the audio player can load without an auth header. */
integrationsRouter.get('/calls/:id/recording-url', ah<AuthedRequest>(async (req, res) => {
  const call = await db.query.calls.findFirst({ where: eq(calls.id, String(req.params.id)) });
  if (!call?.recordingUrl) throw notFound('No recording for this call');
  await getVisibleLead(req.user, call.leadId); // same visibility rules as the lead
  res.json({ url: signPath(`/media/recordings/${call.id}`, 3600) });
}));

integrationsRouter.post('/push/register', ah<AuthedRequest>(async (req, res) => {
  const { token } = z.object({ token: z.string().min(20).max(4096) }).parse(req.body);
  await db.insert(deviceTokens).values({ token, userId: req.user.id }).onConflictDoUpdate({ target: deviceTokens.token, set: { userId: req.user.id } });
  res.json({ ok: true });
}));
integrationsRouter.delete('/push/register', ah<AuthedRequest>(async (req, res) => {
  const { token } = z.object({ token: z.string() }).parse(req.body);
  await db.delete(deviceTokens).where(and(eq(deviceTokens.token, token), eq(deviceTokens.userId, req.user.id)));
  res.json({ ok: true });
}));

/** Media + unsubscribe (no sign-in; protected by signatures). Mounted at the app root. */
export const mediaRouter = Router();
mediaRouter.get('/media/recordings/:id', ah(async (req, res) => {
  const path = `/media/recordings/${req.params.id}`;
  if (!verifyPath(path, String(req.query.exp ?? ''), String(req.query.sig ?? ''))) return res.sendStatus(403);
  const call = await db.query.calls.findFirst({ where: eq(calls.id, String(req.params.id)) });
  if (!call?.recordingUrl) return res.sendStatus(404);
  const r = await fetchRecording(call.recordingUrl).catch(() => null);
  if (!r?.ok) return res.status(502).type('text/plain').send('Recording is not available right now');
  res.setHeader('content-type', 'audio/mpeg');
  res.setHeader('cache-control', 'private, max-age=3600');
  res.send(Buffer.from(await r.arrayBuffer()));
}));
mediaRouter.get('/api/public/unsubscribe/:token', ah(async (req, res) => {
  const t = readUnsubToken(String(req.params.token));
  let leadId: string | null = null;
  if (t?.kind === 'lead') leadId = t.id;
  if (t?.kind === 'customer') leadId = (await db.query.customers.findFirst({ where: (c, { eq }) => eq(c.id, t.id) }))?.leadId ?? null;
  if (leadId) { await db.update(leads).set({ optOut: true }).where(eq(leads.id, leadId)); await stopRuns(db, leadId, 'opt_out'); }
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 16px"><h2>You’re unsubscribed</h2><p>${t ? 'You won’t receive any more messages from us.' : 'This link is not valid.'}</p></body>`);
}));
