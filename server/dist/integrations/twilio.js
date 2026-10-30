import twilio from 'twilio';
import { cfg, enabled } from './settings.js';
let client = null;
/** REST client; rebuilt when the Account SID or Auth Token changes in Settings → Integrations. */
export function twilioClient() {
    const t = cfg.twilio();
    if (!t.accountSid || !t.authToken)
        throw new Error('Twilio is not connected. Add the Account SID and Auth Token in Settings → Integrations.');
    const key = `${t.accountSid}:${t.authToken}`;
    if (client?.key !== key)
        client = { key, c: twilio(t.accountSid, t.authToken) };
    return client.c;
}
/** Access token for the agent's browser (Voice SDK). Identity = user id, so inbound calls can ring that agent. */
export function voiceToken(identity, ttlSec = 3600) {
    const t = cfg.twilio();
    const { AccessToken } = twilio.jwt;
    const token = new AccessToken(t.accountSid, t.apiKey, t.apiSecret, { identity, ttl: ttlSec });
    token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: t.twimlAppSid, incomingAllow: true }));
    return token.toJwt();
}
/** Rejects requests that were not signed by Twilio (X-Twilio-Signature over the public URL + form params). */
export function requireTwilioSignature(req, res, next) {
    const t = cfg.twilio();
    const url = `${cfg.publicApiUrl()}${req.originalUrl}`;
    const ok = !!t.authToken && twilio.validateRequest(t.authToken, String(req.header('x-twilio-signature') ?? ''), url, req.body ?? {});
    if (!ok)
        return res.status(403).type('text/plain').send('Invalid Twilio signature');
    next();
}
/** Sends an SMS. Uses the Messaging Service when set (needed for A2P 10DLC), otherwise the default caller ID. */
export async function sendSms(to, body) {
    const t = cfg.twilio();
    const msg = await twilioClient().messages.create({
        to, body,
        ...(t.messagingServiceSid ? { messagingServiceSid: t.messagingServiceSid } : { from: t.callerId }),
        statusCallback: `${cfg.publicApiUrl()}/webhooks/twilio/sms-status`,
    });
    return { sid: msg.sid, status: msg.status };
}
/** Downloads a recording (Twilio media URLs need account credentials). */
export async function fetchRecording(url) {
    const t = cfg.twilio();
    const mp3 = url.endsWith('.mp3') ? url : `${url}.mp3`;
    return fetch(mp3, { headers: { authorization: `Basic ${Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64')}` } });
}
export const voiceResponse = () => new twilio.twiml.VoiceResponse();
export const messagingResponse = () => new twilio.twiml.MessagingResponse();
export { enabled };
//# sourceMappingURL=twilio.js.map