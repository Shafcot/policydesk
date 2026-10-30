// Signed-in endpoints for integrations: status, browser-calling token, recordings, push registration.
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { calls, deviceTokens, leads } from '../db/schema.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { requireAdmin } from '../middleware/auth.js';
import { integrationStatus, cfg, enabled, rawSetting, sourceOf } from '../integrations/settings.js';
import { GROUPS, fieldDef, saveIntegrationSettings } from '../integrations/store.js';
import { openai } from '../integrations/providers.js';
import { twilioClient } from '../integrations/twilio.js';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { signPath, verifyPath, readUnsubToken } from '../integrations/signed.js';
import { fetchRecording, voiceToken } from '../integrations/twilio.js';
import { getVisibleLead } from '../services/scope.js';
import { stopRuns } from '../services/automation.js';
export const integrationsRouter = Router();
integrationsRouter.get('/integrations/status', ah(async (req, res) => {
    const st = integrationStatus();
    if (req.user.role !== 'admin')
        return res.json({ voice: st.voice, sms: st.sms, email: st.email, push: st.push });
    const api = cfg.publicApiUrl() || `${req.protocol}://${req.get('host')}`; // falls back to the address this page was loaded from
    res.json({ ...st, webhooks: {
            twilioVoiceApp: `${api}/webhooks/twilio/voice`, twilioInbound: `${api}/webhooks/twilio/inbound`, twilioSms: `${api}/webhooks/twilio/sms`,
            sendgridInbound: `${api}/webhooks/sendgrid/inbound?key=<SENDGRID_INBOUND_KEY>`, facebook: `${api}/webhooks/facebook`, googleAds: `${api}/webhooks/google-ads`, leads: `${api}/webhooks/leads/<source key>`,
        } });
}));
/** Browser calling token (Twilio Voice SDK). 404 when calling is not connected, so the dialer stays in manual mode. */
integrationsRouter.get('/voice/token', ah(async (req, res) => {
    if (!enabled.voice())
        throw notFound('Calling is not connected yet');
    res.json({ token: voiceToken(req.user.id), identity: req.user.id });
}));
/** Signed, short-lived link the audio player can load without an auth header. */
integrationsRouter.get('/calls/:id/recording-url', ah(async (req, res) => {
    const call = await db.query.calls.findFirst({ where: eq(calls.id, String(req.params.id)) });
    if (!call?.recordingUrl)
        throw notFound('No recording for this call');
    await getVisibleLead(req.user, call.leadId); // same visibility rules as the lead
    res.json({ url: signPath(`/media/recordings/${call.id}`, 3600) });
}));
integrationsRouter.post('/push/register', ah(async (req, res) => {
    const { token } = z.object({ token: z.string().min(20).max(4096) }).parse(req.body);
    await db.insert(deviceTokens).values({ token, userId: req.user.id }).onConflictDoUpdate({ target: deviceTokens.token, set: { userId: req.user.id } });
    res.json({ ok: true });
}));
integrationsRouter.delete('/push/register', ah(async (req, res) => {
    const { token } = z.object({ token: z.string() }).parse(req.body);
    await db.delete(deviceTokens).where(and(eq(deviceTokens.token, token), eq(deviceTokens.userId, req.user.id)));
    res.json({ ok: true });
}));
/** Media + unsubscribe (no sign-in; protected by signatures). Mounted at the app root. */
export const mediaRouter = Router();
mediaRouter.get('/media/recordings/:id', ah(async (req, res) => {
    const path = `/media/recordings/${req.params.id}`;
    if (!verifyPath(path, String(req.query.exp ?? ''), String(req.query.sig ?? '')))
        return res.sendStatus(403);
    const call = await db.query.calls.findFirst({ where: eq(calls.id, String(req.params.id)) });
    if (!call?.recordingUrl)
        return res.sendStatus(404);
    const r = await fetchRecording(call.recordingUrl).catch(() => null);
    if (!r?.ok)
        return res.status(502).type('text/plain').send('Recording is not available right now');
    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
}));
mediaRouter.get('/api/public/unsubscribe/:token', ah(async (req, res) => {
    const t = readUnsubToken(String(req.params.token));
    let leadId = null;
    if (t?.kind === 'lead')
        leadId = t.id;
    if (t?.kind === 'customer')
        leadId = (await db.query.customers.findFirst({ where: (c, { eq }) => eq(c.id, t.id) }))?.leadId ?? null;
    if (leadId) {
        await db.update(leads).set({ optOut: true }).where(eq(leads.id, leadId));
        await stopRuns(db, leadId, 'opt_out');
    }
    res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 16px"><h2>You’re unsubscribed</h2><p>${t ? 'You won’t receive any more messages from us.' : 'This link is not valid.'}</p></body>`);
}));
/* ---------- API keys (Settings → Integrations) ---------- */
const GROUP_ON = {
    general: () => !!cfg.publicApiUrl(), twilio: () => enabled.voice() || enabled.sms(), sendgrid: enabled.email, openai: enabled.ai,
    firebase: () => enabled.push() && !!cfg.firebaseWeb().apiKey, facebook: enabled.facebook, google: enabled.googleAds,
};
const mask = (v) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);
/** Every key with where its value comes from. Secrets are never sent back, only the last 4 characters. */
integrationsRouter.get('/admin/integrations/keys', requireAdmin, ah(async (_req, res) => {
    res.json({
        publicApiUrl: cfg.publicApiUrl(),
        groups: GROUPS.map((g) => ({
            ...g, connected: GROUP_ON[g.id]?.() ?? false,
            fields: g.fields.map((f) => { const v = rawSetting(f.key); return { ...f, source: sourceOf(f.key), value: f.secret ? null : v, preview: f.secret && v ? mask(v) : null }; }),
        })),
    });
}));
const CHECKS = {
    PUBLIC_API_URL: [/^https:\/\/[^\s/]+(\/.*)?$/, 'The public address must start with https://'],
    TWILIO_ACCOUNT_SID: [/^AC[0-9a-f]{32}$/i, 'The Account SID starts with AC and has 34 characters'],
    TWILIO_AUTH_TOKEN: [/^[0-9a-f]{32}$/i, 'The Auth Token has 32 characters'],
    TWILIO_API_KEY: [/^SK[0-9a-f]{32}$/i, 'The API key SID starts with SK'],
    TWILIO_TWIML_APP_SID: [/^AP[0-9a-f]{32}$/i, 'The TwiML App SID starts with AP'],
    TWILIO_MESSAGING_SERVICE_SID: [/^MG[0-9a-f]{32}$/i, 'The Messaging Service SID starts with MG'],
    TWILIO_CALLER_ID: [/^\+[1-9]\d{7,14}$/, 'Enter the caller ID like +15125550100'],
    SENDGRID_API_KEY: [/^SG\./, 'SendGrid API keys start with SG.'],
    SENDGRID_FROM_EMAIL: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid From email'],
    SENDGRID_INBOUND_DOMAIN: [/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Enter the reply domain without https://, e.g. reply.youragency.com'],
};
integrationsRouter.put('/admin/integrations/keys', requireAdmin, ah(async (req, res) => {
    const { values } = z.object({ values: z.record(z.string(), z.string().max(20000).nullable()) }).parse(req.body);
    for (const [k, v] of Object.entries(values)) {
        if (!fieldDef(k))
            throw badRequest(`Unknown setting ${k}`);
        if (v === null || !v.trim())
            continue;
        const check = CHECKS[k];
        if (check && !check[0].test(v.trim()))
            throw badRequest(check[1]);
        if (k === 'FIREBASE_SERVICE_ACCOUNT_JSON') {
            try {
                const j = JSON.parse(v);
                if (!j.private_key || !j.client_email)
                    throw new Error();
            }
            catch {
                throw badRequest('Paste the whole service account JSON file (it contains "private_key" and "client_email")');
            }
        }
    }
    await saveIntegrationSettings(values);
    res.json({ ok: true, status: integrationStatus() });
}));
/** Checks the saved keys against the provider. */
integrationsRouter.post('/admin/integrations/test/:group', requireAdmin, ah(async (req, res) => {
    const g = String(req.params.group);
    const ok = (message) => res.json({ ok: true, message });
    const fail = (message) => res.json({ ok: false, message });
    try {
        if (g === 'twilio') {
            const t = cfg.twilio();
            if (!t.accountSid || !t.authToken)
                return fail('Add the Account SID and Auth Token first.');
            const acct = await twilioClient().api.v2010.accounts(t.accountSid).fetch();
            const missing = [!t.apiKey && 'API key', !t.apiSecret && 'API key secret', !t.twimlAppSid && 'TwiML App'].filter(Boolean);
            return ok(`Connected to "${acct.friendlyName}" (${acct.status}${acct.type === 'Trial' ? ', trial account' : ''}).${missing.length ? ` Browser calling still needs: ${missing.join(', ')}. Use "Set up calling".` : ''}${!t.messagingServiceSid && !t.callerId ? ' Texting needs a Messaging Service SID or default caller ID.' : ''}`);
        }
        if (g === 'sendgrid') {
            const s = cfg.sendgrid();
            if (!s.apiKey)
                return fail('Add the API key first.');
            const r = await fetch('https://api.sendgrid.com/v3/scopes', { headers: { authorization: `Bearer ${s.apiKey}` } });
            if (r.status === 401 || r.status === 403)
                return fail('SendGrid rejected the API key.');
            const scopes = (await r.json()).scopes ?? [];
            if (!scopes.includes('mail.send'))
                return fail('This API key does not have Mail Send permission.');
            return ok(`API key works and can send mail.${s.from ? '' : ' Add a From email to start sending.'}`);
        }
        if (g === 'openai') {
            if (!cfg.openai().apiKey)
                return fail('Add the API key first.');
            await openai().models.retrieve(cfg.openai().chatModel);
            return ok(`API key works (model ${cfg.openai().chatModel} available).`);
        }
        if (g === 'firebase') {
            const sa = cfg.firebase().serviceAccount;
            if (!sa)
                return fail('Add the service account JSON first.');
            const app = initializeApp({ credential: cert(JSON.parse(sa)) }, `test-${Date.now()}`);
            try {
                await getMessaging(app).send({ topic: 'connection-test', notification: { title: 'test' } }, true);
            }
            finally {
                await deleteApp(app);
            }
            const w = cfg.firebaseWeb();
            return ok(`Service account works.${w.apiKey && w.projectId && w.messagingSenderId && w.appId && w.vapidKey ? '' : ' Fill in all the web app fields so browsers can turn on push.'}`);
        }
        if (g === 'facebook') {
            const f = cfg.facebook();
            if (!f.pageToken)
                return fail('Add the Page access token first.');
            const r = await fetch(`https://graph.facebook.com/${f.graphVersion}/me?fields=name&access_token=${encodeURIComponent(f.pageToken)}`);
            const j = (await r.json());
            return j.name ? ok(`Page token works for "${j.name}".`) : fail(j.error?.message ?? 'Facebook rejected the token.');
        }
        return fail('There is nothing to test for this one. It works once saved.');
    }
    catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
}));
/** Creates the Twilio API key and TwiML App for browser calling, using the saved Account SID + Auth Token. */
integrationsRouter.post('/admin/integrations/twilio/setup', requireAdmin, ah(async (_req, res) => {
    const t = cfg.twilio();
    const base = cfg.publicApiUrl();
    if (!t.accountSid || !t.authToken)
        throw badRequest('Save the Twilio Account SID and Auth Token first.');
    if (!/^https:\/\//.test(base))
        throw badRequest('The app needs a public https:// address first (App address section).');
    const c = twilioClient();
    const voiceUrl = `${base}/webhooks/twilio/voice`;
    const values = {};
    if (t.twimlAppSid) {
        try {
            await c.applications(t.twimlAppSid).update({ voiceUrl, voiceMethod: 'POST' });
        }
        catch {
            values.TWILIO_TWIML_APP_SID = '';
        }
    }
    if (!t.twimlAppSid || values.TWILIO_TWIML_APP_SID === '') {
        const app = await c.applications.create({ friendlyName: 'CRM browser calling', voiceUrl, voiceMethod: 'POST' });
        values.TWILIO_TWIML_APP_SID = app.sid;
    }
    if (!t.apiKey || !t.apiSecret) {
        const key = await c.newKeys.create({ friendlyName: 'CRM browser calling' });
        values.TWILIO_API_KEY = key.sid;
        values.TWILIO_API_SECRET = key.secret;
    }
    await saveIntegrationSettings(values);
    res.json({ ok: true, voice: enabled.voice(), message: 'Browser calling is set up. Reload the page to start calling from the browser.' });
}));
/** Firebase web config for the browser (public values). */
integrationsRouter.get('/integrations/push-config', ah(async (_req, res) => {
    const w = cfg.firebaseWeb();
    res.json(enabled.push() && w.apiKey && w.projectId && w.messagingSenderId && w.appId && w.vapidKey ? w : null);
}));
//# sourceMappingURL=integrations.js.map