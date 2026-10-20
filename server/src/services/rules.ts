// Business rules from SOW section 6: lead assignment, call result → stage, auto-moves, notifications.
import { and, eq, gte, inArray, isNull, lt, max, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, appointments, calls, deviceTokens, leads, notes, notifications, users, type Lead, type User } from '../db/schema.js';
import { enabled } from '../integrations/settings.js';
import { pushTo } from '../integrations/providers.js';
import { fire, stopRuns } from './automation.js';
import { emit } from './realtime.js';
import { sendTeamEmail } from './mailer.js';
import { env } from '../config.js';
import { DEFAULT_SETTINGS, NOT_REACHED, RESULT_STAGE, STAGE_LABELS, type AgencySettings, type CallResult, type Stage } from '../domain.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

export async function getSettings(agencyId: string, x: Exec = db): Promise<AgencySettings> {
  const a = await x.query.agencies.findFirst({ where: eq(agencies.id, agencyId) });
  return { ...DEFAULT_SETTINGS, ...(a?.settings ?? {}) };
}

export async function notify(x: Exec, n: { agencyId: string; userId?: string | null; kind: string; text: string; leadId?: string | null }) {
  const [row] = await x.insert(notifications).values({ agencyId: n.agencyId, userId: n.userId ?? null, kind: n.kind, text: n.text, leadId: n.leadId ?? null }).returning();
  // Live push (bell + toast). Email copies of notifications are sent once SendGrid is connected.
  emit(n.agencyId, n.userId ?? null, 'notification', row);
  if (enabled.push()) {
    const ids = n.userId ? [n.userId] : (await x.query.users.findMany({ where: and(eq(users.agencyId, n.agencyId), eq(users.role, 'admin'), eq(users.active, true)) })).map((u) => u.id);
    const toks = ids.length ? (await x.select().from(deviceTokens).where(inArray(deviceTokens.userId, ids))).map((t) => t.token) : [];
    if (toks.length) setImmediate(() => {
      pushTo(toks, { title: 'Policy-desk CRM', body: n.text, link: n.leadId ? `${env.CLIENT_ORIGIN}/?lead=${n.leadId}` : env.CLIENT_ORIGIN })
        .then((bad) => (bad.length ? db.delete(deviceTokens).where(inArray(deviceTokens.token, bad)) : null)).catch((e) => console.error('push failed', e));
    });
  }
  if (EMAIL_KINDS.has(n.kind)) {
    const to = n.userId
      ? await x.query.users.findMany({ where: and(eq(users.id, n.userId), eq(users.notifyByEmail, true), eq(users.active, true)) })
      : await x.query.users.findMany({ where: and(eq(users.agencyId, n.agencyId), eq(users.role, 'admin'), eq(users.notifyByEmail, true), eq(users.active, true)) });
    const link = n.leadId ? `${env.CLIENT_ORIGIN}/?lead=${n.leadId}` : env.CLIENT_ORIGIN;
    for (const u of to) await sendTeamEmail(x, { agencyId: n.agencyId, to: u.email, subject: n.text.slice(0, 200), body: `${n.text}\n\nOpen in Policy-desk CRM: ${link}\n\nYou can turn off email notifications from your account menu.` });
  }
}

/** Notification kinds that also go out by email (SOW 5). */
const EMAIL_KINDS = new Set(['lead', 'call', 'bad', 'reply', 'book', 'renew', 'task', 'requote', 'followups']);

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/** Calls each agent has made today, keyed by user id. */
export async function callsTodayByUser(agencyId: string, x: Exec = db): Promise<Map<string, number>> {
  const rows = await x
    .select({ userId: calls.userId, n: sql<number>`count(*)::int` })
    .from(calls).innerJoin(leads, eq(calls.leadId, leads.id))
    .where(and(eq(leads.agencyId, agencyId), gte(calls.startedAt, startOfToday())))
    .groupBy(calls.userId);
  return new Map(rows.filter((r) => r.userId).map((r) => [r.userId!, r.n]));
}

/**
 * Picks an agent for a new lead. Round robin = the eligible agent who was assigned a lead least recently.
 * Skips offline / at-limit agents per settings. Returns null when nobody matches (lead stays in intake).
 */
export async function pickAgent(lead: Pick<Lead, 'agencyId' | 'line'>, x: Exec = db): Promise<User | null> {
  const st = await getSettings(lead.agencyId, x);
  let pool = await x.query.users.findMany({ where: and(eq(users.agencyId, lead.agencyId), eq(users.role, 'agent'), eq(users.active, true)) });
  pool = pool.filter((u) => !u.inviteToken);
  if (st.skipOffline) pool = pool.filter((u) => u.status !== 'offline');
  if (st.assignRule === 'availability') pool = pool.filter((u) => u.status === 'available');
  if (st.assignRule === 'line') pool = pool.filter((u) => u.lines.includes(lead.line));
  if (st.skipAtLimit) {
    const today = await callsTodayByUser(lead.agencyId, x);
    pool = pool.filter((u) => (today.get(u.id) ?? 0) < u.maxCallsPerDay);
  }
  if (!pool.length) return null;
  const last = await x
    .select({ agentId: leads.agentId, at: max(leads.createdAt) })
    .from(leads).where(inArray(leads.agentId, pool.map((u) => u.id))).groupBy(leads.agentId);
  const lastAt = new Map(last.map((r) => [r.agentId!, r.at ? new Date(r.at).getTime() : 0]));
  pool.sort((a, b) => (lastAt.get(a.id) ?? 0) - (lastAt.get(b.id) ?? 0));
  return pool[0];
}

export async function setStage(x: Exec, lead: Lead, stage: Stage, actor: { id: string | null; name: string }, why?: string) {
  if (lead.stage === stage) return;
  await x.update(leads).set({
    stage, stageChangedAt: new Date(), updatedAt: new Date(),
    ...(stage === 'won' || stage === 'lost' ? { automation: null } : {}),
  }).where(eq(leads.id, lead.id));
  await x.insert(notes).values({
    leadId: lead.id, userId: actor.id,
    body: `Stage changed: ${STAGE_LABELS[lead.stage]} → ${STAGE_LABELS[stage]}${why ? ` (${why})` : ''}`,
  });
  if (stage === 'won' || stage === 'lost') await stopRuns(x, lead.id, 'won_lost');
  await fire(x, 'stage_change', { agencyId: lead.agencyId, leadId: lead.id, stage });
}

/** Logs a call and applies the SOW's call-result rules. Returns the updated lead. */
export async function recordCall(
  lead: Lead, user: User,
  input: { result: CallResult; durationSec?: number; notes?: string; recordingUrl?: string; summary?: string; transcript?: { speaker: string; text: string }[]; callSid?: string },
): Promise<Lead> {
  const st = await getSettings(lead.agencyId);
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(calls).values({
      leadId: lead.id, userId: user.id, startedAt: now, result: input.result,
      durationSec: input.durationSec ?? 0, notes: input.notes, recordingUrl: input.recordingUrl,
      summary: input.summary, transcript: input.transcript, twilioSid: input.callSid ?? null,
    });
    const reached = !NOT_REACHED.includes(input.result);
    const attempts = lead.attempts + 1;
    let stage: Stage = RESULT_STAGE[input.result];
    if (!reached && st.autoRecycle && attempts >= st.maxAttempts && !lead.lastContactAt) stage = 'recycled';

    const patch: Partial<Lead> = {
      attempts, lastAttemptAt: now, lastCallById: user.id, lockedById: null, updatedAt: now,
      ...(reached ? { lastContactAt: now } : {}),
    };
    if (input.result === 'call_back') {
      const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(10, 0, 0, 0);
      Object.assign(patch, { followUpAt: t, callbackRequested: true });
      await tx.insert(appointments).values({ leadId: lead.id, userId: lead.agentId ?? user.id, startsAt: t, durationMin: 15, type: 'Call-back' });
    } else if (!reached) {
      Object.assign(patch, { followUpAt: new Date(now.getTime() + st.retryHours * 3600e3), callbackRequested: false });
    } else if (input.result === 'quoted') {
      const t = new Date(); t.setDate(t.getDate() + 2); t.setHours(10, 0, 0, 0);
      Object.assign(patch, { followUpAt: t, callbackRequested: false });
    } else {
      Object.assign(patch, { callbackRequested: false });
    }
    await tx.update(leads).set(patch).where(eq(leads.id, lead.id));
    if (input.notes) await tx.insert(notes).values({ leadId: lead.id, userId: user.id, body: input.notes });
    // "Sold" moves to Won only once the customer + policy exist (POST /leads/:id/won), so the stage never says Won without a sale.
    if (input.result !== 'sold') await setStage(tx, lead, stage, { id: user.id, name: user.name }, `call result: ${input.result.replace('_', ' ')}`);
    await fire(tx, 'call_result', { agencyId: lead.agencyId, leadId: lead.id, result: input.result });
    const updated = await tx.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    return updated!;
  });
}

/** Nightly job (also runnable on demand): re-quote after N months, recycle after all attempts. */
export async function runAutoMoves(agencyId: string) {
  const st = await getSettings(agencyId);
  let moved = 0;
  if (st.autoRequote) {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - st.requoteMonths);
    const due = await db.query.leads.findMany({ where: and(eq(leads.agencyId, agencyId), inArray(leads.stage, ['quoted', 'lost']), lt(leads.stageChangedAt, cutoff)) });
    for (const l of due) {
      await setStage(db, l, 'requote', { id: null, name: 'Automation' }, `${st.requoteMonths} months in ${STAGE_LABELS[l.stage]}`);
      await notify(db, { agencyId, userId: l.agentId, kind: 'requote', text: `Re-quote reminder: ${l.firstName} ${l.lastName} is ready for a new quote`, leadId: l.id });
      moved++;
    }
  }
  if (st.autoRecycle) {
    const stale = await db.query.leads.findMany({ where: and(eq(leads.agencyId, agencyId), inArray(leads.stage, ['new', 'attempted']), gte(leads.attempts, st.maxAttempts), isNull(leads.lastContactAt)) });
    for (const l of stale) { await setStage(db, l, 'recycled', { id: null, name: 'Automation' }, 'all call attempts used'); moved++; }
  }
  return moved;
}
