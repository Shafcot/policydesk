// Outlook / Microsoft 365 calendar sync (client feedback). Uses one Microsoft Entra app with application permissions
// (Calendars.ReadWrite), consented once by the agency's Microsoft 365 admin:
//   • every CRM appointment is written to the assigned user's Outlook calendar (created, moved, cancelled);
//   • busy times in Outlook block those times on the booking page and in AI booking.
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { appointments, leads, users } from '../db/schema.js';
import { setExternalBusy } from '../services/booking.js';
import { cfg, enabled } from './settings.js';
const GRAPH = 'https://graph.microsoft.com/v1.0';
let token = null;
async function accessToken() {
    const m = cfg.microsoft();
    const key = `${m.tenantId}:${m.clientId}:${m.clientSecret}`;
    if (token && token.key === key && token.exp > Date.now() + 60_000)
        return token.value;
    const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(m.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: m.clientId, client_secret: m.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const j = (await r.json());
    if (!r.ok || !j.access_token)
        throw new Error(j.error_description?.split('\r\n')[0] ?? `Microsoft sign-in failed (${r.status})`);
    token = { key, value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return token.value;
}
async function graph(path, init = {}) {
    const r = await fetch(`${GRAPH}${path}`, { ...init, headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', Prefer: 'outlook.timezone="UTC"', ...(init.headers ?? {}) } });
    if (r.status === 204)
        return undefined;
    const j = (await r.json().catch(() => ({})));
    if (!r.ok)
        throw Object.assign(new Error(j.error?.message ?? `Microsoft Graph error ${r.status}`), { status: r.status });
    return j;
}
const mailbox = (u) => u.calendarEmail || u.email;
const utc = (d) => ({ dateTime: d.toISOString().replace('Z', ''), timeZone: 'UTC' });
const parseUtc = (s) => new Date(s.endsWith('Z') ? s : `${s}Z`);
/** Busy times in the user's Outlook calendar (cached for 2 minutes). */
const busyCache = new Map();
export async function outlookBusy(u, from, until) {
    if (!enabled.outlook())
        return [];
    const k = `${u.id}:${from.toISOString().slice(0, 13)}:${until.toISOString().slice(0, 10)}`;
    const hit = busyCache.get(k);
    if (hit && Date.now() - hit.at < 120_000)
        return hit.v;
    const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: until.toISOString(), $select: 'start,end,showAs,isCancelled', $top: '500' });
    const r = await graph(`/users/${encodeURIComponent(mailbox(u))}/calendarView?${q}`);
    const v = r.value.filter((e) => !e.isCancelled && e.showAs !== 'free').map((e) => ({ start: parseUtc(e.start.dateTime), end: parseUtc(e.end.dateTime) }));
    busyCache.set(k, { at: Date.now(), v });
    return v;
}
setExternalBusy(outlookBusy);
/** Writes changed appointments to Outlook. Run by the worker; safe to run often. */
export async function syncOutlook(limit = 50) {
    if (!enabled.outlook())
        return 0;
    const rows = await db.select({ a: appointments, u: users, firstName: leads.firstName, lastName: leads.lastName, phone: leads.phone, line: leads.line })
        .from(appointments).innerJoin(users, eq(appointments.userId, users.id)).innerJoin(leads, eq(appointments.leadId, leads.id))
        .where(and(or(isNull(appointments.outlookSyncedAt), gt(appointments.updatedAt, appointments.outlookSyncedAt)), gt(appointments.startsAt, sql `now() - interval '1 day'`)))
        .limit(limit);
    for (const { a, u, firstName, lastName, phone, line } of rows) {
        const box = encodeURIComponent(mailbox(u));
        try {
            if (a.status === 'cancelled') {
                if (a.outlookEventId)
                    await graph(`/users/${box}/events/${encodeURIComponent(a.outlookEventId)}`, { method: 'DELETE' }).catch((e) => { if (e.status !== 404)
                        throw e; });
                await db.update(appointments).set({ outlookEventId: null, outlookSyncedAt: new Date() }).where(eq(appointments.id, a.id));
                continue;
            }
            const event = {
                subject: `${a.type}: ${firstName} ${lastName} (${line})`,
                body: { contentType: 'HTML', content: `Call ${firstName} at <a href="tel:${phone}">${phone}</a>.<br>Lead: <a href="${env.CLIENT_ORIGIN}/leads?lead=${a.leadId}">open in the CRM</a>` },
                start: utc(a.startsAt), end: utc(new Date(a.startsAt.getTime() + a.durationMin * 60_000)),
                isReminderOn: true, reminderMinutesBeforeStart: 10, showAs: 'busy',
            };
            let id = a.outlookEventId;
            if (id)
                await graph(`/users/${box}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(event) }).catch(async (e) => { if (e.status === 404)
                    id = null;
                else
                    throw e; });
            if (!id)
                id = (await graph(`/users/${box}/events`, { method: 'POST', body: JSON.stringify(event) })).id;
            await db.update(appointments).set({ outlookEventId: id, outlookSyncedAt: new Date() }).where(eq(appointments.id, a.id));
        }
        catch (e) {
            console.warn(`Outlook sync failed for appointment ${a.id}:`, e instanceof Error ? e.message : e);
            // Don't retry every tick: try again in an hour.
            await db.update(appointments).set({ outlookSyncedAt: new Date(Date.now() + 3600_000) }).where(eq(appointments.id, a.id));
        }
    }
    return rows.length;
}
/** Settings → Integrations → Test connection. */
export async function testOutlook(adminEmail) {
    const cal = await graph(`/users/${encodeURIComponent(adminEmail)}/calendar`);
    return `Connected to Microsoft 365. Can read and write calendars (checked "${cal.name}" for ${cal.owner?.address ?? adminEmail}).`;
}
//# sourceMappingURL=outlook.js.map