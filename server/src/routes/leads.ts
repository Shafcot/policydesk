import { Router } from 'express';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appointments, calls, customers, leads, messages, notes, policies, users } from '../db/schema.js';
import { CALL_RESULTS, LINES, STAGES, lineType } from '../domain.js';
import { ah, badRequest, forbidden } from '../lib/http.js';
import { requireAdmin, type AuthedRequest } from '../middleware/auth.js';
import { assertCanCall, getVisibleLead, leadScope } from '../services/scope.js';
import { getSettings, notify, pickAgent, recordCall, setStage } from '../services/rules.js';
import { fire, stopRuns } from '../services/automation.js';
import { emitLead } from '../services/realtime.js';

export const leadsRouter = Router();

const ListQuery = z.object({
  q: z.string().optional(),
  stage: z.enum(STAGES).optional(),
  source: z.string().optional(),
  agent: z.string().optional(), // user id or "none"
  line: z.string().optional(),
  type: z.enum(['personal', 'commercial']).optional(),
  days: z.coerce.number().int().positive().optional(),
  intake: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

leadsRouter.get('/', ah<AuthedRequest>(async (req, res) => {
  const f = ListQuery.parse(req.query);
  const where: SQL[] = [leadScope(req.user)];
  if (f.q) {
    const like = `%${f.q.trim()}%`;
    where.push(or(ilike(leads.firstName, like), ilike(leads.lastName, like), ilike(leads.phone, like), ilike(leads.email, like), ilike(leads.company, like),
      sql`(${leads.firstName} || ' ' || ${leads.lastName}) ilike ${like}`)!);
  }
  if (f.stage) where.push(eq(leads.stage, f.stage));
  if (f.source) where.push(eq(leads.source, f.source));
  if (f.agent && req.user.role === 'admin') where.push(f.agent === 'none' ? isNull(leads.agentId) : eq(leads.agentId, f.agent));
  if (f.line) where.push(eq(leads.line, f.line));
  if (f.type) where.push(eq(leads.type, f.type));
  if (f.days) where.push(gte(leads.createdAt, new Date(Date.now() - f.days * 864e5)));
  if (f.intake) where.push(eq(leads.stage, 'new'), or(isNull(leads.agentId), gte(leads.createdAt, new Date(Date.now() - 3 * 864e5)))!);

  const rows = await db.select().from(leads).where(and(...where)).orderBy(desc(leads.createdAt)).limit(f.limit);

  // Flag possible duplicates (same phone appears more than once in the agency).
  const phones = [...new Set(rows.map((r) => r.phone))];
  const dupRows = phones.length
    ? await db.select({ phone: leads.phone, n: sql<number>`count(*)::int` }).from(leads)
      .where(and(eq(leads.agencyId, req.user.agencyId), inArray(leads.phone, phones))).groupBy(leads.phone)
    : [];
  const dup = new Set(dupRows.filter((d) => d.n > 1).map((d) => d.phone));
  res.json(rows.map((r) => ({ ...r, flags: [...(!r.email ? ['missing_email'] : []), ...(dup.has(r.phone) ? ['duplicate'] : [])] })));
}));

const NewLead = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  phone: z.string().min(7).max(40),
  email: z.string().email().optional().or(z.literal('')),
  company: z.string().max(160).optional(),
  line: z.enum(LINES),
  source: z.string().min(1).max(80),
});

/** Manual lead entry. Webhook intake (Facebook, Google, vendors) will reuse createLead() in Milestone 3. */
leadsRouter.post('/', ah<AuthedRequest>(async (req, res) => {
  const body = NewLead.parse(req.body);
  const lead = await createLead(req.user.agencyId, body);
  res.status(201).json(lead);
}));

export async function createLead(agencyId: string, body: z.infer<typeof NewLead>) {
  const agent = await pickAgent({ agencyId, line: body.line });
  const [lead] = await db.insert(leads).values({
    agencyId, firstName: body.firstName, lastName: body.lastName, phone: body.phone, email: body.email || null,
    company: body.company || null, line: body.line, type: lineType(body.line), source: body.source,
    agentId: agent?.id ?? null, automation: 'New-lead drip',
  }).returning();
  await db.insert(notes).values({ leadId: lead.id, body: `Lead received from ${body.source}. Requested ${body.line} quote.` });
  const name = `${lead.firstName} ${lead.lastName}`;
  await fire(db, 'new_lead', { agencyId, leadId: lead.id });
  emitLead(agencyId, lead.agentId, 'lead:new', { id: lead.id, name, source: lead.source });
  if (agent) await notify(db, { agencyId, userId: agent.id, kind: 'lead', text: `New lead assigned to ${agent.name}: ${name}`, leadId: lead.id });
  else await notify(db, { agencyId, userId: null, kind: 'warn', text: `No agent matched ${name}. Lead is waiting in intake.`, leadId: lead.id });
  return lead;
}

leadsRouter.get('/:id', ah<AuthedRequest>(async (req, res) => {
  const lead = await getVisibleLead(req.user, String(req.params.id));
  const [callRows, noteRows, msgRows, apptRows, cust] = await Promise.all([
    db.select({ c: calls, userName: users.name }).from(calls).leftJoin(users, eq(calls.userId, users.id)).where(eq(calls.leadId, lead.id)).orderBy(desc(calls.startedAt)),
    db.select({ n: notes, userName: users.name }).from(notes).leftJoin(users, eq(notes.userId, users.id)).where(eq(notes.leadId, lead.id)).orderBy(desc(notes.createdAt)),
    db.select().from(messages).where(eq(messages.leadId, lead.id)).orderBy(asc(messages.createdAt)),
    db.select().from(appointments).where(eq(appointments.leadId, lead.id)).orderBy(desc(appointments.startsAt)),
    db.query.customers.findFirst({ where: eq(customers.leadId, lead.id), with: { policies: true } }),
  ]);
  const people = await db.query.users.findMany({ where: inArray(users.id, [lead.agentId, lead.lastCallById, lead.lockedById].filter(Boolean) as string[]) });
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  res.json({
    ...lead,
    agentName: nameOf(lead.agentId),
    lastCallByName: nameOf(lead.lastCallById),
    lockedByName: lead.lockedById && lead.lockedById !== req.user.id ? nameOf(lead.lockedById) : null,
    calls: callRows.map((r) => ({ ...r.c, userName: r.userName })),
    notes: noteRows.map((r) => ({ ...r.n, userName: r.userName })),
    messages: msgRows,
    appointments: apptRows,
    policies: cust?.policies ?? [],
  });
}));

const Patch = z.object({
  stage: z.enum(STAGES).optional(),
  agentId: z.string().uuid().nullable().optional(),
  followUpAt: z.string().datetime().nullable().optional(),
  custom: z.record(z.string()).optional(),
  email: z.string().email().or(z.literal('')).optional(),
  automation: z.string().nullable().optional(),
});

leadsRouter.patch('/:id', ah<AuthedRequest>(async (req, res) => {
  const lead = await getVisibleLead(req.user, String(req.params.id));
  const body = Patch.parse(req.body);
  if (body.agentId !== undefined && req.user.role !== 'admin') throw forbidden('Only the Super Admin can reassign leads');
  if (body.stage === 'won') throw badRequest('Use “Mark won” to create the customer and policy');
  await db.transaction(async (tx) => {
    const set: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
    if (body.agentId !== undefined) set.agentId = body.agentId;
    if (body.followUpAt !== undefined) set.followUpAt = body.followUpAt ? new Date(body.followUpAt) : null;
    if (body.custom) set.custom = { ...lead.custom, ...body.custom };
    if (body.email !== undefined) set.email = body.email || null;
    await tx.update(leads).set(set).where(eq(leads.id, lead.id));
    if (body.automation === null) await stopRuns(tx, lead.id, 'manual');
    if (body.stage) await setStage(tx, lead, body.stage, { id: req.user.id, name: req.user.name });
    if (body.agentId && body.agentId !== lead.agentId) {
      const a = await tx.query.users.findFirst({ where: eq(users.id, body.agentId) });
      if (!a || a.agencyId !== req.user.agencyId) throw badRequest('That agent is not in your agency');
      await notify(tx, { agencyId: lead.agencyId, userId: a.id, kind: 'lead', text: `Lead assigned to you: ${lead.firstName} ${lead.lastName}`, leadId: lead.id });
    }
  });
  const fresh = await getVisibleLead(req.user, lead.id);
  emitLead(fresh.agencyId, fresh.agentId, 'lead:changed', { id: fresh.id });
  res.json(fresh);
}));

leadsRouter.post('/bulk', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), agentId: z.string().uuid().optional(), stage: z.enum(STAGES).optional() }).parse(req.body);
  if (body.stage === 'won') throw badRequest('Won leads need a policy; mark them won one at a time');
  const rows = await db.query.leads.findMany({ where: and(inArray(leads.id, body.ids), eq(leads.agencyId, req.user.agencyId)) });
  await db.transaction(async (tx) => {
    if (body.agentId) {
      await tx.update(leads).set({ agentId: body.agentId, updatedAt: new Date() }).where(inArray(leads.id, rows.map((r) => r.id)));
      await notify(tx, { agencyId: req.user.agencyId, userId: body.agentId, kind: 'lead', text: `${rows.length} leads were assigned to you` });
    }
    if (body.stage) for (const l of rows) await setStage(tx, l, body.stage, { id: req.user.id, name: req.user.name });
  });
  res.json({ updated: rows.length });
}));

leadsRouter.post('/:id/calls', ah<AuthedRequest>(async (req, res) => {
  const lead = await getVisibleLead(req.user, String(req.params.id));
  assertCanCall(req.user, lead);
  const body = z.object({ result: z.enum(CALL_RESULTS), durationSec: z.number().int().min(0).max(36000).optional(), notes: z.string().max(5000).optional() }).parse(req.body);
  const updated = await recordCall(lead, req.user, body);
  res.status(201).json(updated);
}));

/** Lock a lead while a call is live so nobody else dials it. Released when the call result is logged. */
leadsRouter.post('/:id/lock', ah<AuthedRequest>(async (req, res) => {
  const lead = await getVisibleLead(req.user, String(req.params.id));
  assertCanCall(req.user, lead);
  await db.update(leads).set({ lockedById: req.user.id }).where(eq(leads.id, lead.id));
  res.json({ ok: true });
}));

leadsRouter.post('/:id/notes', ah<AuthedRequest>(async (req, res) => {
  const lead = await getVisibleLead(req.user, String(req.params.id));
  const { body } = z.object({ body: z.string().min(1).max(5000) }).parse(req.body);
  const [n] = await db.insert(notes).values({ leadId: lead.id, userId: req.user.id, body }).returning();
  res.status(201).json({ ...n, userName: req.user.name });
}));

/** Queue for the power dialer, in SOW order: new → call-backs due → follow-ups due today → no-answer retries. */
leadsRouter.get('/queue/mine', ah<AuthedRequest>(async (req, res) => {
  const st = await getSettings(req.user.agencyId);
  const eod = new Date(); eod.setHours(23, 59, 59, 999);
  const now = Date.now();
  const rows = await db.select().from(leads).where(and(leadScope(req.user), inArray(leads.stage, ['new', 'attempted', 'followup', 'ready', 'quoted', 'requote'])));
  const q: { bucket: string; lead: typeof rows[number] }[] = [];
  rows.filter((l) => l.stage === 'new' && l.attempts < st.attemptsDay1).sort((a, b) => +b.createdAt - +a.createdAt).forEach((lead) => q.push({ bucket: 'new', lead }));
  rows.filter((l) => l.stage === 'followup' && l.callbackRequested && l.followUpAt && +l.followUpAt <= +eod).sort((a, b) => +a.followUpAt! - +b.followUpAt!).forEach((lead) => q.push({ bucket: 'callback', lead }));
  rows.filter((l) => ['followup', 'ready', 'quoted', 'requote'].includes(l.stage) && !l.callbackRequested && l.followUpAt && +l.followUpAt <= +eod).sort((a, b) => +a.followUpAt! - +b.followUpAt!).forEach((lead) => q.push({ bucket: 'followup', lead }));
  rows.filter((l) => l.stage === 'attempted' && l.attempts < st.maxAttempts && (!l.lastAttemptAt || now - +l.lastAttemptAt > st.retryHours * 3600e3)).sort((a, b) => +(a.lastAttemptAt ?? 0) - +(b.lastAttemptAt ?? 0)).forEach((lead) => q.push({ bucket: 'retry', lead }));
  res.json(q);
}));
