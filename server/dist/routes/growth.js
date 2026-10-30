// Automations, campaigns and tasks.
import { Router } from 'express';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { automationRuns, automations, campaigns, customers, leads, tasks } from '../db/schema.js';
import { ACTIONS, CALL_RESULTS, CONDITIONS, STAGES, TRIGGERS } from '../domain.js';
import { env } from '../config.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { requireAdmin } from '../middleware/auth.js';
import { audienceFor, sendBroadcast } from '../services/campaigns.js';
import { isBusinessTime, localParts, nextBusinessTime } from '../services/hours.js';
import { receiveReply } from '../services/inbound.js';
import { getSettings } from '../services/rules.js';
import { getVisibleLead } from '../services/scope.js';
export const growthRouter = Router();
/* ---------- automations (admin) ---------- */
const StepSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('wait'), amount: z.number().int().min(0).max(1000), unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']) }),
    z.object({ type: z.literal('condition'), condition: z.enum(CONDITIONS) }),
    z.object({ type: z.literal('action'), action: z.enum(ACTIONS), templateId: z.string().uuid().nullable().optional(), stage: z.enum(STAGES).optional(), text: z.string().max(300).optional() }),
]);
const AutomationIn = z.object({
    name: z.string().min(1).max(120),
    active: z.boolean(),
    trigger: z.enum(TRIGGERS),
    triggerConfig: z.object({ stages: z.array(z.enum(STAGES)).optional(), results: z.array(z.enum(CALL_RESULTS)).optional(), daysBefore: z.array(z.number().int().min(0).max(365)).optional() }),
    steps: z.array(StepSchema).max(40),
    stopOnReply: z.boolean(), stopOnBooking: z.boolean(), stopOnWonLost: z.boolean(), businessHoursOnly: z.boolean(),
});
growthRouter.get('/automations', requireAdmin, ah(async (req, res) => {
    const list = await db.query.automations.findMany({ where: eq(automations.agencyId, req.user.agencyId), orderBy: [asc(automations.createdAt), asc(automations.name)] });
    const stats = list.length ? await db.select({
        id: automationRuns.automationId,
        active: sql `count(*) filter (where ${automationRuns.status} = 'active')::int`,
        completed: sql `count(*) filter (where ${automationRuns.status} = 'completed')::int`,
        stopped: sql `count(*) filter (where ${automationRuns.status} = 'stopped')::int`,
    }).from(automationRuns).where(inArray(automationRuns.automationId, list.map((a) => a.id))).groupBy(automationRuns.automationId) : [];
    res.json(list.map((a) => ({ ...a, stats: stats.find((s) => s.id === a.id) ?? { active: 0, completed: 0, stopped: 0 } })));
}));
growthRouter.post('/automations', requireAdmin, ah(async (req, res) => {
    const b = AutomationIn.parse(req.body);
    const [a] = await db.insert(automations).values({ ...b, agencyId: req.user.agencyId }).returning();
    res.status(201).json(a);
}));
growthRouter.put('/automations/:id', requireAdmin, ah(async (req, res) => {
    const b = AutomationIn.parse(req.body);
    const [a] = await db.update(automations).set({ ...b, updatedAt: new Date() }).where(and(eq(automations.id, String(req.params.id)), eq(automations.agencyId, req.user.agencyId))).returning();
    if (!a)
        throw notFound('Automation not found');
    // Runs already past the end of a shortened flow finish on their next tick.
    res.json(a);
}));
growthRouter.delete('/automations/:id', requireAdmin, ah(async (req, res) => {
    await db.delete(automations).where(and(eq(automations.id, String(req.params.id)), eq(automations.agencyId, req.user.agencyId)));
    res.json({ ok: true });
}));
growthRouter.get('/automations/:id/runs', requireAdmin, ah(async (req, res) => {
    const a = await db.query.automations.findFirst({ where: and(eq(automations.id, String(req.params.id)), eq(automations.agencyId, req.user.agencyId)) });
    if (!a)
        throw notFound('Automation not found');
    const rows = await db.select({ r: automationRuns, first: leads.firstName, last: leads.lastName, customer: customers.name })
        .from(automationRuns).leftJoin(leads, eq(automationRuns.leadId, leads.id)).leftJoin(customers, eq(automationRuns.customerId, customers.id))
        .where(eq(automationRuns.automationId, a.id)).orderBy(desc(automationRuns.updatedAt)).limit(50);
    res.json(rows.map(({ r, first, last, customer }) => ({ ...r, contact: first ? `${first} ${last}` : customer ?? '—' })));
}));
/** Lead page: the flows this lead is in. */
growthRouter.get('/leads/:id/runs', ah(async (req, res) => {
    const lead = await getVisibleLead(req.user, String(req.params.id));
    const rows = await db.select({ r: automationRuns, name: automations.name }).from(automationRuns).innerJoin(automations, eq(automationRuns.automationId, automations.id))
        .where(eq(automationRuns.leadId, lead.id)).orderBy(desc(automationRuns.createdAt)).limit(20);
    res.json(rows.map(({ r, name }) => ({ id: r.id, name, status: r.status, stepIndex: r.stepIndex, nextRunAt: r.nextRunAt, stopReason: r.stopReason, log: r.log })));
}));
/* ---------- tasks ---------- */
growthRouter.get('/tasks', ah(async (req, res) => {
    const mine = req.user.role === 'admin' ? or(eq(tasks.userId, req.user.id), isNull(tasks.userId)) : eq(tasks.userId, req.user.id);
    const rows = await db.select({ t: tasks, first: leads.firstName, last: leads.lastName, customer: customers.name }).from(tasks)
        .leftJoin(leads, eq(tasks.leadId, leads.id)).leftJoin(customers, eq(tasks.customerId, customers.id))
        .where(and(eq(tasks.agencyId, req.user.agencyId), mine, isNull(tasks.doneAt))).orderBy(asc(tasks.dueAt)).limit(50);
    res.json(rows.map(({ t, first, last, customer }) => ({ ...t, contact: first ? `${first} ${last}` : customer })));
}));
growthRouter.patch('/tasks/:id', ah(async (req, res) => {
    const { done } = z.object({ done: z.boolean() }).parse(req.body);
    const mine = req.user.role === 'admin' ? or(eq(tasks.userId, req.user.id), isNull(tasks.userId)) : eq(tasks.userId, req.user.id);
    const [t] = await db.update(tasks).set({ doneAt: done ? new Date() : null }).where(and(eq(tasks.id, String(req.params.id)), eq(tasks.agencyId, req.user.agencyId), mine)).returning();
    if (!t)
        throw notFound('Task not found');
    res.json(t);
}));
/* ---------- campaigns (admin) ---------- */
const Audience = z.object({ stage: z.string().optional(), line: z.string().optional(), type: z.string().optional(), includeCustomers: z.boolean().optional() });
growthRouter.get('/campaigns', requireAdmin, ah(async (req, res) => {
    const st = await getSettings(req.user.agencyId);
    const md = localParts(new Date(), st.timezone).md;
    const list = await db.query.campaigns.findMany({ where: eq(campaigns.agencyId, req.user.agencyId), orderBy: desc(campaigns.createdAt) });
    const bdays = await db.select({ id: customers.id, name: customers.name }).from(customers).where(and(eq(customers.agencyId, req.user.agencyId), sql `right(${customers.dob}, 5) = ${md}`));
    res.json({ campaigns: list, birthdaysToday: bdays });
}));
growthRouter.post('/campaigns/audience', requireAdmin, ah(async (req, res) => {
    const a = await audienceFor(req.user.agencyId, Audience.parse(req.body));
    res.json({ recipients: a.recipients.length, excluded: a.excluded });
}));
growthRouter.post('/campaigns/broadcast', requireAdmin, ah(async (req, res) => {
    const b = z.object({ name: z.string().min(1).max(120), channel: z.enum(['sms', 'email']), subject: z.string().max(240).optional(), body: z.string().min(1).max(5000), audience: Audience, sendAt: z.string().datetime().optional() }).parse(req.body);
    const st = await getSettings(req.user.agencyId);
    const want = b.sendAt ? new Date(b.sendAt) : new Date();
    const when = nextBusinessTime(want, st); // broadcasts only go out during business hours
    const [c] = await db.insert(campaigns).values({ agencyId: req.user.agencyId, kind: 'broadcast', name: b.name, channel: b.channel, subject: b.subject ?? null, body: b.body, audience: b.audience, scheduledFor: when }).returning();
    if (when <= new Date() && isBusinessTime(new Date(), st)) {
        const r = await sendBroadcast(c.id);
        return res.status(201).json({ ...c, sentAt: new Date(), recipients: r?.sent ?? 0, excluded: r?.excluded ?? 0 });
    }
    res.status(201).json(c);
}));
growthRouter.post('/campaigns/holiday', requireAdmin, ah(async (req, res) => {
    const b = z.object({ name: z.string().min(1).max(120), holidayDate: z.string().regex(/^\d\d-\d\d$/), body: z.string().min(1).max(1000), channel: z.enum(['sms', 'email']).default('sms') }).parse(req.body);
    const [c] = await db.insert(campaigns).values({ ...b, agencyId: req.user.agencyId, kind: 'holiday' }).returning();
    res.status(201).json(c);
}));
growthRouter.patch('/campaigns/:id', requireAdmin, ah(async (req, res) => {
    const b = z.object({ active: z.boolean().optional(), body: z.string().min(1).max(5000).optional(), subject: z.string().max(240).nullable().optional(), name: z.string().min(1).max(120).optional(), holidayDate: z.string().regex(/^\d\d-\d\d$/).optional(), channel: z.enum(['sms', 'email']).optional() }).parse(req.body);
    const c = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, String(req.params.id)), eq(campaigns.agencyId, req.user.agencyId)) });
    if (!c)
        throw notFound('Campaign not found');
    if (c.kind === 'broadcast' && c.sentAt)
        throw badRequest('This broadcast was already sent');
    const [u] = await db.update(campaigns).set(b).where(eq(campaigns.id, c.id)).returning();
    res.json(u);
}));
growthRouter.delete('/campaigns/:id', requireAdmin, ah(async (req, res) => {
    await db.delete(campaigns).where(and(eq(campaigns.id, String(req.params.id)), eq(campaigns.agencyId, req.user.agencyId), or(isNull(campaigns.sentAt), sql `${campaigns.kind} <> 'broadcast'`)));
    res.json({ ok: true });
}));
/* ---------- development helper ---------- */
/** Simulates a lead replying (SMS/email) until provider webhooks exist in Milestone 3. Disabled in production. */
growthRouter.post('/dev/inbound', requireAdmin, ah(async (req, res) => {
    if (env.NODE_ENV === 'production')
        throw notFound();
    const b = z.object({ leadId: z.string().uuid(), channel: z.enum(['sms', 'email']).default('sms'), body: z.string().min(1).max(2000) }).parse(req.body);
    await getVisibleLead(req.user, b.leadId);
    res.json(await receiveReply(b.leadId, b.channel, b.body));
}));
//# sourceMappingURL=growth.js.map