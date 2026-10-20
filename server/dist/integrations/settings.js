// Which integrations are switched on. Each is enabled by filling its keys in server/.env (see INTEGRATIONS.md).
const v = (k) => (process.env[k] ?? '').trim();
export const cfg = {
    /** Public HTTPS address of this API, used to build webhook URLs for Twilio and to verify Twilio signatures. */
    publicApiUrl: () => v('PUBLIC_API_URL').replace(/\/$/, ''),
    twilio: () => ({ accountSid: v('TWILIO_ACCOUNT_SID'), authToken: v('TWILIO_AUTH_TOKEN'), apiKey: v('TWILIO_API_KEY'), apiSecret: v('TWILIO_API_SECRET'), twimlAppSid: v('TWILIO_TWIML_APP_SID'), messagingServiceSid: v('TWILIO_MESSAGING_SERVICE_SID'), callerId: v('TWILIO_CALLER_ID'), recordingNotice: v('CALL_RECORDING_NOTICE') }),
    sendgrid: () => ({ apiKey: v('SENDGRID_API_KEY'), from: v('SENDGRID_FROM_EMAIL'), fromName: v('SENDGRID_FROM_NAME') || 'Policy-desk CRM', inboundDomain: v('SENDGRID_INBOUND_DOMAIN'), inboundKey: v('SENDGRID_INBOUND_KEY') }),
    openai: () => ({ apiKey: v('OPENAI_API_KEY'), transcribeModel: v('OPENAI_TRANSCRIBE_MODEL') || 'whisper-1', chatModel: v('OPENAI_CHAT_MODEL') || 'gpt-4o-mini' }),
    firebase: () => ({ serviceAccount: v('FIREBASE_SERVICE_ACCOUNT_JSON') }),
    facebook: () => ({ appSecret: v('FACEBOOK_APP_SECRET'), verifyToken: v('FACEBOOK_VERIFY_TOKEN'), pageToken: v('FACEBOOK_PAGE_ACCESS_TOKEN'), graphVersion: v('FACEBOOK_GRAPH_VERSION') || 'v21.0' }),
    googleAds: () => ({ webhookKey: v('GOOGLE_ADS_WEBHOOK_KEY') }),
    /** Agency that receives leads from Facebook / Google webhooks (single-agency installs can leave it empty = first agency). */
    defaultAgencyId: () => v('DEFAULT_AGENCY_ID'),
};
export const enabled = {
    voice: () => { const t = cfg.twilio(); return !!(t.accountSid && t.authToken && t.apiKey && t.apiSecret && t.twimlAppSid && cfg.publicApiUrl()); },
    sms: () => { const t = cfg.twilio(); return !!(t.accountSid && t.authToken && (t.messagingServiceSid || t.callerId)); },
    email: () => { const s = cfg.sendgrid(); return !!(s.apiKey && s.from); },
    inboundEmail: () => { const s = cfg.sendgrid(); return !!(s.inboundDomain && s.inboundKey); },
    ai: () => !!cfg.openai().apiKey,
    push: () => !!cfg.firebase().serviceAccount,
    facebook: () => { const f = cfg.facebook(); return !!(f.appSecret && f.verifyToken && f.pageToken); },
    googleAds: () => !!cfg.googleAds().webhookKey,
};
export function integrationStatus() {
    return Object.fromEntries(Object.entries(enabled).map(([k, f]) => [k, f()]));
}
//# sourceMappingURL=settings.js.map