// Free time slots in an agent's calendar and booking one. Used by the public booking page and AI texting.
// Outlook / Microsoft 365 busy times are added when calendar sync is connected (see integrations/outlook.ts).
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appointments, notes } from '../db/schema.js';
import { stopRuns } from './automation.js';
import { localParts, zonedToUtc } from './hours.js';
import { notify } from './rules.js';
export const SLOT_MIN = 30;
const DAYS_AHEAD = 14;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Extra busy times from an external calendar (set by the Outlook integration when connected). */
let externalBusy = null;
export const setExternalBusy = (fn) => { externalBusy = fn; };
/** Free 30-minute slots inside the agent's working hours, skipping days off, booked times and Outlook busy times. */
export async function freeSlots(u, tz, daysAhead = DAYS_AHEAD) {
    const now = new Date();
    const until = new Date(now.getTime() + daysAhead * 864e5);
    const booked = await db.select({ s: appointments.startsAt, d: appointments.durationMin }).from(appointments)
        .where(and(eq(appointments.userId, u.id), inArray(appointments.status, ['scheduled']), gte(appointments.startsAt, now), lt(appointments.startsAt, until)));
    const busy = booked.map((b) => ({ start: b.s, end: new Date(b.s.getTime() + b.d * 60_000) }));
    if (externalBusy)
        busy.push(...(await externalBusy(u, now, until).catch((e) => { console.warn('external calendar unavailable', e?.message ?? e); return []; })));
    const [sh, sm] = u.hoursStart.split(':').map(Number);
    const [eh, em] = u.hoursEnd.split(':').map(Number);
    const today = localParts(now, tz);
    const days = [];
    for (let i = 0; i < daysAhead; i++) {
        const base = new Date(Date.UTC(today.y, today.m - 1, today.d + i, 12));
        const dow = DOW[base.getUTCDay()];
        if (u.daysOff.includes(dow))
            continue;
        const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, d = base.getUTCDate();
        const slots = [];
        for (let t = sh * 60 + sm; t + SLOT_MIN <= eh * 60 + em; t += SLOT_MIN) {
            const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
            if (start.getTime() < now.getTime() + 60 * 60_000)
                continue; // at least 1 hour notice
            const end = start.getTime() + SLOT_MIN * 60_000;
            if (!busy.some((b) => b.start.getTime() < end && b.end.getTime() > start.getTime()))
                slots.push(start.toISOString());
        }
        if (slots.length)
            days.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, label: `${dow} ${base.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`, slots });
    }
    return days;
}
/** Books a slot for an existing lead with this agent. Caller checks the slot is free. */
export async function bookLead(x, a) {
    const [appt] = await x.insert(appointments).values({ leadId: a.lead.id, userId: a.lead.agentId ?? a.agent.id, startsAt: a.slot, durationMin: SLOT_MIN, type: 'Discovery call' }).returning();
    await x.insert(notes).values({ leadId: a.lead.id, body: `Booked a ${SLOT_MIN}-minute call ${a.via}.${a.note ? ` Note: ${a.note}` : ''}` });
    await stopRuns(x, a.lead.id, 'booking');
    const when = a.slot.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: a.tz });
    await notify(x, { agencyId: a.lead.agencyId, userId: a.lead.agentId ?? a.agent.id, kind: 'book', text: `${a.lead.firstName} ${a.lead.lastName} booked a call for ${when}`, leadId: a.lead.id });
    return { appt, when };
}
//# sourceMappingURL=booking.js.map