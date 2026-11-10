// Outbox: delivers queued SMS/email through Twilio / SendGrid, and turns call recordings into transcripts + summaries.
import { and, eq, inArray } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { callRecordings, calls, customers, leads, messages } from '../db/schema.js';
import { sendEmail, summarizeCall, transcribe } from './providers.js';
import { cfg, enabled } from './settings.js';
import { toE164 } from './phone.js';
import { unsubToken } from './signed.js';
import { fetchRecording, sendSms } from './twilio.js';
/** Sends up to `limit` queued messages whose channel has a provider. Safe to run from several workers (row locks). */
export async function deliverQueued(limit = 50) {
    const channels = [...(enabled.sms() ? ['sms'] : []), ...(enabled.email() ? ['email'] : [])];
    if (!channels.length)
        return 0;
    const batch = await db.transaction(async (tx) => {
        const rows = await tx.select({ id: messages.id }).from(messages)
            .where(and(eq(messages.status, 'queued'), eq(messages.direction, 'out'), inArray(messages.channel, channels)))
            .orderBy(messages.createdAt).limit(limit).for('update', { skipLocked: true });
        if (rows.length)
            await tx.update(messages).set({ status: 'sending' }).where(inArray(messages.id, rows.map((r) => r.id)));
        return rows.map((r) => r.id);
    });
    for (const id of batch)
        await deliverOne(id);
    return batch.length;
}
async function deliverOne(id) {
    const m = await db.query.messages.findFirst({ where: eq(messages.id, id) });
    if (!m)
        return;
    const lead = m.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, m.leadId) }) : null;
    const cust = m.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, m.customerId) }) : null;
    const phone = lead?.phone ?? cust?.phone ?? null;
    const email = lead?.email ?? cust?.email ?? null;
    const optedOut = lead?.optOut ?? false;
    const fail = (error) => db.update(messages).set({ status: 'failed', error: error.slice(0, 500) }).where(eq(messages.id, id));
    if (optedOut)
        return fail('Contact opted out');
    try {
        if (m.channel === 'sms') {
            const to = toE164(phone);
            if (!to)
                return fail('No valid phone number');
            const r = await sendSms(to, m.body);
            await db.update(messages).set({ status: 'sent', providerId: r.sid, error: null }).where(eq(messages.id, id));
        }
        else {
            if (!email)
                return fail('No email address');
            const kind = lead ? 'lead' : 'customer';
            const contactId = (lead?.id ?? cust?.id);
            const sg = cfg.sendgrid();
            // Replies go to reply+<l|c>.<id>@inbound-domain → Inbound Parse → back into the thread.
            const replyTo = enabled.inboundEmail() ? `reply+${kind[0]}.${contactId}@${sg.inboundDomain}` : undefined;
            const unsub = `${env.CLIENT_ORIGIN}/api/public/unsubscribe/${unsubToken(kind, contactId)}`;
            const r = await sendEmail({ to: email, subject: m.subject ?? 'A message from your agent', text: `${m.body}\n\n—\nDon't want these emails? Unsubscribe: ${unsub}`, replyTo });
            await db.update(messages).set({ status: 'sent', providerId: r.id, error: null }).where(eq(messages.id, id));
        }
    }
    catch (e) {
        await fail(e instanceof Error ? e.message : String(e));
    }
}
/** Twilio SMS status callback → delivered / failed / undelivered. */
export async function updateSmsStatus(sid, status, errorCode) {
    const map = { delivered: 'delivered', sent: 'sent', failed: 'failed', undelivered: 'failed' };
    if (!map[status])
        return;
    await db.update(messages).set({ status: map[status], ...(errorCode ? { error: `Twilio error ${errorCode}` } : {}) }).where(eq(messages.providerId, sid));
}
/** Links a finished recording to its call (whichever arrives second) and starts transcription. */
export async function attachRecording(callSid) {
    const rec = await db.query.callRecordings.findFirst({ where: eq(callRecordings.callSid, callSid) });
    const call = await db.query.calls.findFirst({ where: eq(calls.twilioSid, callSid) });
    if (!rec || !call || call.recordingUrl)
        return;
    await db.update(calls).set({ recordingUrl: rec.url, durationSec: Math.max(call.durationSec, rec.durationSec), transcriptStatus: enabled.ai() ? 'pending' : null }).where(eq(calls.id, call.id));
    if (enabled.ai())
        setImmediate(() => { transcribeCall(call.id).catch((e) => console.error('transcription failed', e)); });
}
/** Recording → transcript (OpenAI) → 2-3 sentence summary on the lead page (SOW 6). */
export async function transcribeCall(callId) {
    const call = await db.query.calls.findFirst({ where: eq(calls.id, callId) });
    if (!call?.recordingUrl)
        return;
    try {
        const res = await fetchRecording(call.recordingUrl);
        if (!res.ok)
            throw new Error(`recording download failed: ${res.status}`);
        const text = await transcribe(await res.arrayBuffer());
        const lead = await db.query.leads.findFirst({ where: eq(leads.id, call.leadId) });
        const summary = text.trim() ? await summarizeCall(text, { lead: lead ? `${lead.firstName} ${lead.lastName}` : 'lead', line: lead?.line ?? '', result: call.result.replace('_', ' ') }) : '';
        await db.update(calls).set({ transcript: [{ speaker: 'Call', text }], summary: summary || call.summary, transcriptStatus: 'done' }).where(eq(calls.id, callId));
    }
    catch (e) {
        await db.update(calls).set({ transcriptStatus: 'failed' }).where(eq(calls.id, callId));
        throw e;
    }
}
//# sourceMappingURL=delivery.js.map