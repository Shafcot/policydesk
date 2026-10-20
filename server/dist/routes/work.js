// Dialer (speed dial, favorites), calendar and inbox endpoints.
import { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appointments, calls, favorites, leads, messages, templates, users } from '../db/schema.js';
import { ah, badRequest, forbidden, notFound } from '../lib/http.js';
import { getSettings, notify } from '../services/rules.js';
import { fire, stopRuns } from '../services/automation.js';
import { queueMessage } from '../services/messaging.js';
import { getVisibleLead, leadScope } from '../services/scope.js';
export const workRouter = Router();
/* ---------- speed dial ---------- */
/** Top 20 most-called contacts for this user + their favorites (SOW 3). */
workRouter.get('/speed-dial', ah(async (req, res) => {
    const counts = db.select({ leadId: calls.leadId, n: sql `count(*)::int`.as('n') })
        .from(calls).where(eq(calls.userId, req.user.id)).groupBy(calls.leadId).as('counts');
    const top = await db.select({ lead: leads, n: counts.n }).from(counts).innerJoin(leads, eq(leads.id, counts.leadId))
        .where(leadScope(req.user)).orderBy(desc(counts.n)).limit(20);
    const favs = await db.select({ lead: leads }).from(favorites).innerJoin(leads, eq(leads.id, favorites.leadId))
        .where(and(eq(favorites.userId, req.user.id), leadScope(req.user)));
    const favIds = new Set(favs.map((f) => f.lead.id));
    const shape = (l, n = 0) => ({ id: l.id, firstName: l.firstName, lastName: l.lastName, phone: l.phone, stage: l.stage, calls: n, favorite: favIds.has(l.id) });
    res.json({
        favorites: favs.map((f) => shape(f.lead, top.find((t) => t.lead.id === f.lead.id)?.n ?? 0)),
        top: top.filter((t) => !favIds.has(t.lead.id)).map((t) => shape(t.lead, t.n)),
    });
}));
workRouter.put('/favorites/:leadId', ah(async (req, res) => {
    const lead = await getVisibleLead(req.user, String(req.params.leadId));
    await db.insert(favorites).values({ userId: req.user.id, leadId: lead.id }).onConflictDoNothing();
    res.json({ ok: true });
}));
workRouter.delete('/favorites/:leadId', ah(async (req, res) => {
    await db.delete(favorites).where(and(eq(favorites.userId, req.user.id), eq(favorites.leadId, String(req.params.leadId))));
    res.json({ ok: true });
}));
/* ---------- calendar ---------- */
workRouter.get('/appointments', ah(async (req, res) => {
    const q = z.object({ from: z.string().datetime(), to: z.string().datetime(), agent: z.string().uuid().optional() }).parse(req.query);
    const who = req.user.role === 'admin' ? (q.agent ? [eq(appointments.userId, q.agent)] : []) : [eq(appointments.userId, req.user.id)];
    const rows = await db.select({ a: appointments, firstName: leads.firstName, lastName: leads.lastName, line: leads.line, agentName: users.name })
        .from(appointments).innerJoin(leads, eq(appointments.leadId, leads.id)).innerJoin(users, eq(appointments.userId, users.id))
        .where(and(eq(leads.agencyId, req.user.agencyId), gte(appointments.startsAt, new Date(q.from)), lt(appointments.startsAt, new Date(q.to)), ...who))
        .orderBy(asc(appointments.startsAt));
    res.json(rows.map((r) => ({ ...r.a, leadName: `${r.firstName} ${r.lastName}`, line: r.line, agentName: r.agentName })));
}));
workRouter.post('/appointments', ah(async (req, res) => {
    const body = z.object({ leadId: z.string().uuid(), startsAt: z.string().datetime(), type: z.string().min(1).max(40), durationMin: z.number().int().min(5).max(480).default(30) }).parse(req.body);
    const lead = await getVisibleLead(req.user, body.leadId);
    const userId = lead.agentId ?? req.user.id;
    const [a] = await db.insert(appointments).values({ leadId: lead.id, userId, startsAt: new Date(body.startsAt), type: body.type, durationMin: body.durationMin }).returning();
    if (body.type === 'Call-back')
        await db.update(leads).set({ callbackRequested: true, followUpAt: new Date(body.startsAt), updatedAt: new Date() }).where(eq(leads.id, lead.id));
    await stopRuns(db, lead.id, 'booking'); // booking stops automations set to stop on booking (SOW 4)
    await notify(db, { agencyId: lead.agencyId, userId, kind: 'book', text: `Appointment booked: ${lead.firstName} ${lead.lastName} · ${body.type}`, leadId: lead.id });
    res.status(201).json(a);
}));
workRouter.patch('/appointments/:id', ah(async (req, res) => {
    const { status } = z.object({ status: z.enum(['done', 'noshow', 'cancelled', 'scheduled']) }).parse(req.body);
    const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, String(req.params.id)) });
    if (!appt)
        throw notFound('Appointment not found');
    const lead = await getVisibleLead(req.user, appt.leadId);
    if (req.user.role !== 'admin' && appt.userId !== req.user.id)
        throw forbidden();
    await db.update(appointments).set({ status }).where(eq(appointments.id, appt.id));
    if (status === 'noshow') {
        // SOW 6 missed appointment: the "Missed appointment" automation texts the lead to rebook and alerts agent + admin.
        const started = await fire(db, 'missed_appointment', { agencyId: lead.agencyId, leadId: lead.id });
        if (!started.length)
            await notify(db, { agencyId: lead.agencyId, userId: appt.userId, kind: 'bad', text: `Missed appointment: ${lead.firstName} ${lead.lastName}`, leadId: lead.id });
    }
    res.json({ ok: true });
}));
/** Agents set their own working hours and days off. */
workRouter.patch('/users/me/hours', ah(async (req, res) => {
    const body = z.object({ hoursStart: z.string().regex(/^\d\d:\d\d$/).optional(), hoursEnd: z.string().regex(/^\d\d:\d\d$/).optional(), daysOff: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).optional() }).parse(req.body);
    const [u] = await db.update(users).set(body).where(eq(users.id, req.user.id)).returning();
    res.json({ hoursStart: u.hoursStart, hoursEnd: u.hoursEnd, daysOff: u.daysOff });
}));
/* ---------- inbox ---------- */
workRouter.get('/inbox', ah(async (req, res) => {
    const last = db.select({
        leadId: messages.leadId,
        lastAt: sql `max(${messages.createdAt})`.as('last_at'),
        unread: sql `count(*) filter (where ${messages.direction} = 'in' and ${messages.readAt} is null)::int`.as('unread'),
        sms: sql `count(*) filter (where ${messages.channel} = 'sms')::int`.as('sms_n'),
        email: sql `count(*) filter (where ${messages.channel} = 'email')::int`.as('email_n'),
    }).from(messages).groupBy(messages.leadId).as('last');
    const rows = await db.select({ lead: leads, lastAt: last.lastAt, unread: last.unread, sms: last.sms, email: last.email })
        .from(last).innerJoin(leads, eq(leads.id, last.leadId)).where(leadScope(req.user)).orderBy(desc(last.lastAt)).limit(200);
    const ids = rows.map((r) => r.lead.id);
    const latest = ids.length
        ? await db.selectDistinctOn([messages.leadId], { leadId: messages.leadId, channel: messages.channel, direction: messages.direction, subject: messages.subject, body: messages.body })
            .from(messages).where(inArray(messages.leadId, ids)).orderBy(messages.leadId, desc(messages.createdAt))
        : [];
    const byLead = new Map(latest.map((m) => [m.leadId, m]));
    res.json(rows.map((r) => ({
        leadId: r.lead.id, name: `${r.lead.firstName} ${r.lead.lastName}`, stage: r.lead.stage, phone: r.lead.phone, email: r.lead.email, optOut: r.lead.optOut,
        lastAt: r.lastAt, unread: r.unread, sms: r.sms, email_count: r.email, last: byLead.get(r.lead.id) ?? null,
    })));
}));
workRouter.post('/leads/:id/read', ah(async (req, res) => {
    const lead = await getVisibleLead(req.user, String(req.params.id));
    await db.update(messages).set({ readAt: new Date() }).where(and(eq(messages.leadId, lead.id), eq(messages.direction, 'in'), isNull(messages.readAt)));
    res.json({ ok: true });
}));
/** Send SMS/email. Stored as "queued" until Twilio/SendGrid are connected in Milestone 3. */
workRouter.post('/leads/:id/messages', ah(async (req, res) => {
    const lead = await getVisibleLead(req.user, String(req.params.id));
    const body = z.object({ channel: z.enum(['sms', 'email']), subject: z.string().max(240).optional(), body: z.string().min(1).max(5000) }).parse(req.body);
    if (lead.optOut)
        throw badRequest('This lead opted out. Messages are blocked.');
    if (req.user.role !== 'admin' && lead.agentId !== req.user.id)
        throw forbidden('Only the lead owner can message this lead');
    if (body.channel === 'email' && !lead.email)
        throw badRequest('This lead has no email address');
    const m = await queueMessage(db, { kind: 'lead', id: lead.id }, { channel: body.channel, subject: body.subject, body: body.body, userId: req.user.id });
    if (!m)
        throw badRequest('This lead cannot receive that message');
    res.status(201).json(m);
}));
workRouter.get('/templates', ah(async (req, res) => {
    res.json(await db.select().from(templates).where(eq(templates.agencyId, req.user.agencyId)).orderBy(asc(templates.channel), asc(templates.name)));
}));
/** Settings the calendar and dialer need (non-sensitive subset visible to agents). */
workRouter.get('/settings/public', ah(async (req, res) => {
    const st = await getSettings(req.user.agencyId);
    res.json({ attemptsDay1: st.attemptsDay1, attemptsPerDay: st.attemptsPerDay, maxAttempts: st.maxAttempts, retryHours: st.retryHours, reminderMinutes: st.reminderMinutes, customFields: st.customFields, teamTargetVisible: st.teamTargetVisible, businessOpen: st.businessOpen, businessClose: st.businessClose, businessDays: st.businessDays });
}));
//# sourceMappingURL=work.js.map