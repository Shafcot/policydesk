// Provider API keys entered by the Super Admin in Settings → Integrations.
// Stored encrypted (AES-256-GCM) in the database and cached in memory; environment variables are the fallback.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { integrationSettings } from '../db/schema.js';
/** Every setting that can be entered in the app. Keys match the environment variable names. */
export const GROUPS = [
    { id: 'general', name: 'App address', about: 'The public HTTPS address of this CRM. Providers send calls, texts, emails and leads here. Leave empty to use the address the app is served from.', fields: [
            { key: 'PUBLIC_API_URL', label: 'Public address', placeholder: 'https://crm.youragency.com' },
        ] },
    { id: 'twilio', name: 'Twilio: calling, recording and SMS', about: 'Account SID and Auth Token are on the Twilio Console home page. Save those, then use "Set up calling" to create the API key and TwiML app automatically.', fields: [
            { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', placeholder: 'AC…' },
            { key: 'TWILIO_AUTH_TOKEN', label: 'Auth Token', secret: true },
            { key: 'TWILIO_API_KEY', label: 'API key SID', placeholder: 'SK…', hint: 'Filled in by "Set up calling".' },
            { key: 'TWILIO_API_SECRET', label: 'API key secret', secret: true, hint: 'Filled in by "Set up calling".' },
            { key: 'TWILIO_TWIML_APP_SID', label: 'TwiML App SID', placeholder: 'AP…', hint: 'Filled in by "Set up calling".' },
            { key: 'TWILIO_MESSAGING_SERVICE_SID', label: 'Messaging Service SID', placeholder: 'MG…', hint: 'Needed for US texting (A2P 10DLC).' },
            { key: 'TWILIO_CALLER_ID', label: 'Default caller ID', placeholder: '+15125550100', hint: 'Used when a user has no number of their own.' },
            { key: 'CALL_RECORDING_NOTICE', label: 'Recording notice (optional)', placeholder: 'This call may be recorded for quality.' },
        ] },
    { id: 'sendgrid', name: 'SendGrid: email', about: 'API key with Mail Send permission, and a sender on an authenticated domain. Inbound fields are for email replies.', fields: [
            { key: 'SENDGRID_API_KEY', label: 'API key', secret: true, placeholder: 'SG.…' },
            { key: 'SENDGRID_FROM_EMAIL', label: 'From email', placeholder: 'quotes@youragency.com' },
            { key: 'SENDGRID_FROM_NAME', label: 'From name' },
            { key: 'SENDGRID_INBOUND_DOMAIN', label: 'Reply domain (Inbound Parse)', placeholder: 'reply.youragency.com' },
            { key: 'SENDGRID_INBOUND_KEY', label: 'Inbound Parse secret', secret: true, hint: 'Any random text. Also goes on the end of the Inbound Parse URL.' },
        ] },
    { id: 'openai', name: 'OpenAI: transcripts, summaries and AI replies', about: 'An API key from platform.openai.com.', fields: [
            { key: 'OPENAI_API_KEY', label: 'API key', secret: true, placeholder: 'sk-…' },
            { key: 'OPENAI_TRANSCRIBE_MODEL', label: 'Transcription model', placeholder: 'whisper-1' },
            { key: 'OPENAI_CHAT_MODEL', label: 'Chat model', placeholder: 'gpt-4o-mini' },
        ] },
    { id: 'firebase', name: 'Firebase: push notifications', about: 'Service account JSON (Project settings → Service accounts) for sending, plus the web app config and VAPID key (Project settings → General / Cloud Messaging).', fields: [
            { key: 'FIREBASE_SERVICE_ACCOUNT_JSON', label: 'Service account JSON', secret: true, multiline: true },
            { key: 'FIREBASE_WEB_API_KEY', label: 'Web API key' },
            { key: 'FIREBASE_WEB_AUTH_DOMAIN', label: 'Auth domain', placeholder: 'project.firebaseapp.com' },
            { key: 'FIREBASE_WEB_PROJECT_ID', label: 'Project ID' },
            { key: 'FIREBASE_WEB_MESSAGING_SENDER_ID', label: 'Messaging sender ID' },
            { key: 'FIREBASE_WEB_APP_ID', label: 'App ID' },
            { key: 'FIREBASE_WEB_VAPID_KEY', label: 'Web push key (VAPID)' },
        ] },
    { id: 'facebook', name: 'Facebook / Instagram Lead Ads', about: 'From your Meta app: app secret, a verify token you choose, and a Page access token with leads_retrieval.', fields: [
            { key: 'FACEBOOK_APP_SECRET', label: 'App secret', secret: true },
            { key: 'FACEBOOK_VERIFY_TOKEN', label: 'Verify token', secret: true },
            { key: 'FACEBOOK_PAGE_ACCESS_TOKEN', label: 'Page access token', secret: true },
            { key: 'FACEBOOK_GRAPH_VERSION', label: 'Graph API version', placeholder: 'v21.0' },
        ] },
    { id: 'google', name: 'Google Ads lead forms', about: 'The key you enter in the lead form\'s webhook settings.', fields: [
            { key: 'GOOGLE_ADS_WEBHOOK_KEY', label: 'Webhook key', secret: true },
        ] },
];
export const FIELD_KEYS = new Set(GROUPS.flatMap((g) => g.fields.map((f) => f.key)));
export const fieldDef = (key) => GROUPS.flatMap((g) => g.fields).find((f) => f.key === key);
const cache = new Map();
let version = 0;
/** Bumps whenever saved values change, so provider clients know to rebuild. */
export const settingsVersion = () => version;
const encKey = () => createHash('sha256').update(`${process.env.SETTINGS_ENCRYPTION_KEY || env.JWT_SECRET}:integration-settings`).digest();
function encrypt(plain) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', encKey(), iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}
function decrypt(stored) {
    try {
        const [v, iv, tag, data] = stored.split(':');
        if (v !== 'v1')
            return null;
        const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    }
    catch {
        return null;
    } // wrong key (JWT_SECRET changed) → treated as not set
}
/** Value saved in the app for `key`, if any. */
export const savedValue = (key) => cache.get(key);
/** Loads saved values into memory. Called at startup and by the worker every tick. */
export async function loadIntegrationSettings() {
    const rows = await db.select().from(integrationSettings);
    const next = new Map();
    for (const r of rows) {
        const v = decrypt(r.value);
        if (v !== null && FIELD_KEYS.has(r.key))
            next.set(r.key, v);
    }
    const changed = next.size !== cache.size || [...next].some(([k, v]) => cache.get(k) !== v);
    if (changed) {
        cache.clear();
        next.forEach((v, k) => cache.set(k, v));
        version++;
    }
}
/** Saves values (empty string or null clears the app value, falling back to the environment). */
export async function saveIntegrationSettings(values) {
    const entries = Object.entries(values).filter(([k]) => FIELD_KEYS.has(k));
    const clear = entries.filter(([, v]) => v === null || v.trim() === '').map(([k]) => k);
    const set = entries.filter(([, v]) => v !== null && v.trim() !== '');
    await db.transaction(async (tx) => {
        if (clear.length)
            await tx.delete(integrationSettings).where(inArray(integrationSettings.key, clear));
        for (const [k, v] of set) {
            const value = encrypt(fieldDef(k)?.multiline ? v.trim() : v.trim());
            await tx.insert(integrationSettings).values({ key: k, value }).onConflictDoUpdate({ target: integrationSettings.key, set: { value, updatedAt: new Date() } });
        }
    });
    await loadIntegrationSettings();
}
//# sourceMappingURL=store.js.map