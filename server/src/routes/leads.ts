import { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appointments, calls, customers, leads, liveCalls, messages, notes, policies, users } from '../db/schema.js';
import { BAD_REASONS, CALL_RESULTS, LINES, STAGES, lineType } from '../domain.js';
import { markBad } from '../services/badleads.js';
import { ah, badRequest, forbidden } from '../lib/http.js';
import { requireAdmin, type AuthedRequest } from '../middleware/auth.js';
import { assertCanCall, getVisibleLead, leadScope } from '../services/scope.js';
import { getSettings, notify, pickAgent, recordCall, setStage } from '../services/rules.js';
import { fire, stopRuns } from '../services/automation.js';
import { emitLead } from '../services/realtime.js';
import { insertReturning } from '../db/helpers.js';
import { attachRecording } from '../integrations/delivery.js';

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
  /** Bad-lead filter: one reason, 'any' (all bad leads) or 'none' (hide bad leads). */
  bad: z.enum([...BAD_REASONS, 'any', 'none']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

leadsRouter.get('/', ah<AuthedRequest>(async (req, res) => {
  const f = ListQuery.parse(req.query);
  const where: SQL[] = [leadScope(req.user)];
  if (f.q) {
    const pattern = `%${f.q.trim()}%`;
    // Case-insensitive through MySQL's default collation.
    where.push(or(like(leads.firstName, pattern), like(leads.lastName, pattern), like(leads.phone, pattern), like(leads.email, pattern), like(leads.company, pattern),
      sql`concat(${leads.firstName}, ' ', ${leads.lastName}) like ${pattern}`)!);
  }
  if (f.stage) where.push(eq(leads.stage, f.stage));
  if (f.source) where.push(eq(leads.source, f.source));
  if (f.agent && req.user.role === 'admin') where.push(f.agent === 'none' ? isNull(leads.agentId) : eq(leads.agentId, f.agent));
  if (f.line) where.push(eq(leads.line, f.line));
  if (f.type) where.push(eq(leads.type, f.type));
  if (f.days) where.push(gte(leads.createdAt, new Date(Date.now() - f.days * 864e5)));
  if (f.bad === 'any') where.push(isNotNull(leads.badReason));
  else if (f.bad === 'none') where.push(isNull(leads.badReason));
  else if (f.bad) where.push(eq(leads.badReason, f.bad));
  if (f.intake) where.push(eq(leads.stage, 'new'), or(isNull(leads.agentId), gte(leads.createdAt, new Date(Date.now() - 3 * 864e5)))!);

  const rows = await db.select().from(leads).where(and(...where)).orderBy(desc(leads.createdAt)).limit(f.limit);

  // Flag possible duplicates (same phone appears more than once in the agency).
  const phones = [...new Set(rows.map((r) => r.phone).filter(Boolean))];
  const dupRows = phones.length
    ? await db.select({ phone: leads.phone, n: sql<number>`count(*)` }).from(leads)
      .where(and(eq(leads.agencyId, req.user.agencyId), inArray(leads.phone, phones))).groupBy(leads.phone)
    : [];
  const dup = new Set(dupRows.filter((d) => d.n > 1).map((d) => d.phone));
  res.json(rows.map((r) => ({ ...r, flags: [...(!r.phone ? ['missing_phone'] : []), ...(!r.email ? ['missing_email'] : []), ...(r.phone && dup.has(r.phone) ? ['duplicate'] : [])] })));
}));

const NewLead = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  phone: z.string().min(7).max(40),
  email: z.string().email().optional().or(z.literal('')),
  company: z.string().max(160).optional(),
  line: z.enum(LINES),
  source: z.string().min(1).max(80),
  /** Dial pad: the person who just called this number keeps the lead instead of auto-assignment. */
  assignToMe: z.boolean().optional(),
});

/** Manual lead entry. Webhook intake (Facebook, Google, vendors) will reuse createLead() in Milestone 3. */
leadsRouter.post('/', ah<AuthedRequest>(async (req, res) => {
  const body = NewLead.parse(req.body);
  const lead = await createLead(req.user.agencyId, body, body.assignToMe ? { id: req.user.id, name: req.user.name } : undefined);
  res.status(201).json(lead);
}));

export async function createLead(agencyId: string, body: z.infer<typeof NewLead>, owner?: { id: string; name: string }) {
  const agent = owner ?? await pickAgent({ agencyId, line: body.line });
  const [lead] = await insertReturning(db, leads, {
    agencyId, firstName: body.firstName, lastName: body.lastName, phone: body.phone, email: body.email || null,
    company: body.company || null, line: body.line, type: lineType(body.line), source: body.source,
    agentId: agent?.id ?? null, automation: 'New-lead drip',
  });
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
    db.query.customers.findFirst({ where: eq(customers.leadId, lead.id) })
      .then(async (c) => (c ? { ...c, policies: await db.select().from(policies).where(eq(policies.customerId, c.id)) } : undefined)),
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
  /** Take over from the AI ('stopped') or hand back to it (null = AI may answer again). */
  aiStatus: z.enum(['stopped']).nullable().optional(),
  /** Mark as a bad lead, or null to clear. */
  badReason: z.enum(BAD_REASONS).nullable().optional(),
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
    if (body.aiStatus !== undefined) { set.aiStatus = body.aiStatus; if (body.aiStatus === null) set.aiTurns = 0; }
    await tx.update(leads).set(set).where(eq(leads.id, lead.id));
    if (body.automation === null) await stopRuns(tx, lead.id, 'manual');
    if (body.badReason !== undefined) {
      if (body.badReason === null && lead.badReason && req.user.role !== 'admin') throw forbidden('Only the Super Admin can clear a bad-lead flag');
      await markBad(tx, { ...lead, ...set } as typeof lead, body.badReason, { id: req.user.id, name: req.user.name });
    }
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

/** Super Admin: permanently deletes leads with their calls, notes, messages, appointments, tasks and automation runs.
 *  Customers and policies created from a won lead are kept (they just lose the link to the lead). */
leadsRouter.post('/delete', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }).parse(req.body);
  const scope = and(inArray(leads.id, ids), eq(leads.agencyId, req.user.agencyId));
  const gone = await db.select({ id: leads.id, agentId: leads.agentId }).from(leads).where(scope);
  await db.delete(leads).where(scope);
  for (const l of gone) emitLead(req.user.agencyId, l.agentId, 'lead:deleted', { id: l.id });
  res.json({ deleted: gone.length });
}));

leadsRouter.post('/bulk', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), agentId: z.string().uuid().optional(), stage: z.enum(STAGES).optional(), badReason: z.enum(BAD_REASONS).nullable().optional() }).parse(req.body);
  if (body.stage === 'won') throw badRequest('Won leads need a policy; mark them won one at a time');
  const rows = await db.query.leads.findMany({ where: and(inArray(leads.id, body.ids), eq(leads.agencyId, req.user.agencyId)) });
  await db.transaction(async (tx) => {
    if (body.agentId) {
      await tx.update(leads).set({ agentId: body.agentId, updatedAt: new Date() }).where(inArray(leads.id, rows.map((r) => r.id)));
      await notify(tx, { agencyId: req.user.agencyId, userId: body.agentId, kind: 'lead', text: `${rows.length} leads were assigned to you` });
    }
    if (body.stage) for (const l of rows) await setStage(tx, l, body.stage, { id: req.user.id, name: req.user.name });
    if (body.badReason !== undefined) for (const l of rows) await markBad(tx, l, body.badReason, { id: req.user.id, name: req.user.name });
  });
  res.json({ updated: rows.length });
}));

leadsRouter.post('/:id/calls', ah<AuthedRequest>(async (req, res) => {
  const lead = await getVisibleLead(req.user, String(req.params.id));
  assertCanCall(req.user, lead);
  const body = z.object({ result: z.enum(CALL_RESULTS), durationSec: z.number().int().min(0).max(36000).optional(), notes: z.string().max(5000).optional(), callSid: z.string().regex(/^CA[0-9a-f]{32}$/).optional(), liveCallId: z.string().uuid().optional() }).parse(req.body);
  // A browser call: the recording is filed under the call's first leg, whoever ends up logging it.
  if (body.liveCallId) {
    const lc = await db.query.liveCalls.findFirst({ where: and(eq(liveCalls.id, body.liveCallId), eq(liveCalls.agencyId, req.user.agencyId)) });
    if (lc?.logCallSid) body.callSid = lc.logCallSid;
    if (lc && !lc.leadId) await db.update(liveCalls).set({ leadId: lead.id }).where(eq(liveCalls.id, lc.id));
  }
  const updated = await recordCall(lead, req.user, body);
  if (body.callSid) await attachRecording(body.callSid); // the recording may have arrived first
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
  const [n] = await insertReturning(db, notes, { leadId: lead.id, userId: req.user.id, body });
  res.status(201).json({ ...n, userName: req.user.name });
}));

/** Queue for the power dialer, in SOW order: new → call-backs due → follow-ups due today → no-answer retries. */
leadsRouter.get('/queue/mine', ah<AuthedRequest>(async (req, res) => {
  const st = await getSettings(req.user.agencyId);
  const eod = new Date(); eod.setHours(23, 59, 59, 999);
  const now = Date.now();
  const rows = await db.select().from(leads).where(and(leadScope(req.user), isNull(leads.badReason), sql`${leads.phone} <> ''`, inArray(leads.stage, ['new', 'attempted', 'followup', 'ready', 'quoted', 'requote'])));
  const q: { bucket: string; lead: typeof rows[number] }[] = [];
  rows.filter((l) => l.stage === 'new' && l.attempts < st.attemptsDay1).sort((a, b) => +b.createdAt - +a.createdAt).forEach((lead) => q.push({ bucket: 'new', lead }));
  rows.filter((l) => l.stage === 'followup' && l.callbackRequested && l.followUpAt && +l.followUpAt <= +eod).sort((a, b) => +a.followUpAt! - +b.followUpAt!).forEach((lead) => q.push({ bucket: 'callback', lead }));
  rows.filter((l) => ['followup', 'ready', 'quoted', 'requote'].includes(l.stage) && !l.callbackRequested && l.followUpAt && +l.followUpAt <= +eod).sort((a, b) => +a.followUpAt! - +b.followUpAt!).forEach((lead) => q.push({ bucket: 'followup', lead }));
  rows.filter((l) => l.stage === 'attempted' && l.attempts < st.maxAttempts && (!l.lastAttemptAt || now - +l.lastAttemptAt > st.retryHours * 3600e3)).sort((a, b) => +(a.lastAttemptAt ?? 0) - +(b.lastAttemptAt ?? 0)).forEach((lead) => q.push({ bucket: 'retry', lead }));
  res.json(q);
}));

/**
 * Spreadsheet import (SOW 7: leads from the old CRM / vendors). Rows are mapped to these fields in the browser.
 * Duplicates (same phone as an existing lead) are skipped and reported. Imported leads don't start automations unless asked.
 */
leadsRouter.post('/import', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  const Row = z.object({
    firstName: z.string().max(80).optional(), lastName: z.string().max(80).optional(), name: z.string().max(160).optional(),
    phone: z.string().max(40).optional(), email: z.string().max(200).optional(), company: z.string().max(160).optional(),
    line: z.string().max(40).optional(), source: z.string().max(80).optional(), stage: z.string().max(40).optional(),
    agentEmail: z.string().max(200).optional(), notes: z.string().max(5000).optional(), createdAt: z.string().max(40).optional(),
  });
  const b = z.object({ rows: z.array(Row).min(1).max(10000), defaultSource: z.string().min(1).max(80), autoAssign: z.boolean().default(true), runAutomations: z.boolean().default(false),
    /** Keep rows that have no phone number (e.g. email-only leads from an old CRM). They can't be called until a number is added. */
    allowNoPhone: z.boolean().default(false) }).parse(req.body);
  const team = await db.query.users.findMany({ where: eq(users.agencyId, req.user.agencyId) });
  const existing = await db.select({ phone: leads.phone, email: leads.email }).from(leads).where(eq(leads.agencyId, req.user.agencyId));
  const seen = new Set(existing.map((l) => l.phone.replace(/\D/g, '').slice(-10)).filter((k) => k.length >= 7));
  const seenEmail = new Set(existing.map((l) => (l.email ?? '').trim().toLowerCase()).filter(Boolean));
  const stageByName = new Map(STAGES.map((k) => [k, k] as const));
  Object.entries({ 'new': 'new', 'contact attempted': 'attempted', 'needs follow-up': 'followup', 'follow up': 'followup', 'ready to quote': 'ready', 'quoted': 'quoted', 'won': 'won', 'sold': 'won', 'lost': 'lost', 'ready for re-quote': 'requote', 'recycled': 'recycled' } as const)
    .forEach(([k, v]) => stageByName.set(k as never, v));
  let duplicates = 0; const skipped: { row: number; reason: string }[] = [];
  // Validate and map every row first, then write in bulk (large migrations send thousands of rows).
  const ready: { lead: typeof leads.$inferInsert; note: string }[] = [];
  for (const [i, r] of b.rows.entries()) {
    const rowNo = i + 2; // header is row 1
    const [first, ...rest] = (r.name ?? '').trim().split(/\s+/);
    const firstName = (r.firstName || first || '').trim(), lastName = (r.lastName || rest.join(' ') || '').trim();
    const phone = (r.phone ?? '').trim();
    const hasPhone = phone.replace(/\D/g, '').length >= 7;
    if (!firstName || (!hasPhone && !b.allowNoPhone)) { skipped.push({ row: rowNo, reason: 'Missing name or phone' }); continue; }
    const email = (r.email ?? '').trim().toLowerCase();
    if (hasPhone) {
      const key = phone.replace(/\D/g, '').slice(-10);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
    } else if (email) {
      // No phone: the email is the only way to spot a duplicate.
      if (seenEmail.has(email)) { duplicates++; continue; }
    }
    if (email) seenEmail.add(email);
    const line = LINES.find((l) => l.toLowerCase() === (r.line ?? '').trim().toLowerCase()) ?? 'Auto';
    const stage = stageByName.get((r.stage ?? '').trim().toLowerCase() as never) ?? 'new';
    let agentId = team.find((u) => u.email.toLowerCase() === (r.agentEmail ?? '').trim().toLowerCase())?.id ?? null;
    if (!agentId && b.autoAssign && stage !== 'won') agentId = (await pickAgent({ agencyId: req.user.agencyId, line }))?.id ?? null;
    const created = r.createdAt && !Number.isNaN(Date.parse(r.createdAt)) ? new Date(r.createdAt) : new Date();
    ready.push({
      lead: {
        agencyId: req.user.agencyId, firstName: firstName.slice(0, 80), lastName: (lastName || '-').slice(0, 80), phone: hasPhone ? phone : '', email: r.email?.trim() || null,
        company: r.company?.trim() || null, line, type: lineType(line), source: r.source?.trim() || b.defaultSource, stage, agentId, createdAt: created, stageChangedAt: created,
      },
      note: `Imported from ${b.defaultSource}.${r.notes ? `\n\n${r.notes}` : ''}`,
    });
  }
  for (let i = 0; i < ready.length; i += 500) {
    const part = ready.slice(i, i + 500);
    await db.transaction(async (tx) => {
      const ids = await insertReturning(tx, leads, part.map((p) => p.lead));
      await tx.insert(notes).values(ids.map((x, j) => ({ leadId: x.id, body: part[j].note })));
      if (b.runAutomations) for (const x of ids) await fire(tx, 'new_lead', { agencyId: req.user.agencyId, leadId: x.id });
    });
  }
  const imported = ready.length;
  if (imported) await notify(db, { agencyId: req.user.agencyId, userId: null, kind: 'lead', text: `${imported} leads imported from a spreadsheet` });
  res.json({ imported, duplicates, skipped: skipped.slice(0, 200) });
}));

/**
 * Adds notes to leads that are already in Bliss, matched by their exact phone number (data migrations, e.g. the
 * call/note history from the old CRM after its leads were imported). Unmatched items are counted, not created.
 */
leadsRouter.post('/notes/bulk', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  const b = z.object({ items: z.array(z.object({ phone: z.string().min(1).max(40), body: z.string().min(1).max(30000) })).min(1).max(2000) }).parse(req.body);
  const phones = [...new Set(b.items.map((i) => i.phone.trim()))];
  const found = await db.select({ id: leads.id, phone: leads.phone, createdAt: leads.createdAt }).from(leads)
    .where(and(eq(leads.agencyId, req.user.agencyId), inArray(leads.phone, phones))).orderBy(desc(leads.createdAt));
  const byPhone = new Map<string, string>();
  for (const l of found) if (!byPhone.has(l.phone)) byPhone.set(l.phone, l.id); // newest lead wins
  const rows = b.items.flatMap((i) => { const leadId = byPhone.get(i.phone.trim()); return leadId ? [{ leadId, body: i.body }] : []; });
  for (let i = 0; i < rows.length; i += 500) await db.insert(notes).values(rows.slice(i, i + 500));
  res.json({ added: rows.length, unmatched: b.items.length - rows.length });
}));
