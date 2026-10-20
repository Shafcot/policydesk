// Background worker: advances automation runs, sends appointment reminders and scheduled broadcasts,
// and runs daily jobs (auto-moves, renewals, birthdays, holidays) once per agency per local day.
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { agencies, appointments, campaigns, customers, jobRuns, leads, policies, users } from '../db/schema.js';
import { fire, processDueRuns } from './automation.js';
import { isBusinessTime, localParts } from './hours.js';
import { fill, queueMessage, varsFor, contactFor } from './messaging.js';
import { getSettings, notify, runAutoMoves } from './rules.js';
import { sendBroadcast } from './campaigns.js';
import { backupDatabase } from './backup.js';
import { deliverQueued } from '../integrations/delivery.js';

const LOCK_KEY = 4207061; // only one worker process does the work at a time

async function once(job: string, agencyId: string, day: string, fn: () => Promise<unknown>) {
  const r = await db.insert(jobRuns).values({ job, agencyId, day }).onConflictDoNothing().returning();
  if (!r.length) return false;
  try { await fn(); } catch (e) { console.error(`job ${job} failed`, e); await db.delete(jobRuns).where(and(eq(jobRuns.job, job), eq(jobRuns.agencyId, agencyId), eq(jobRuns.day, day))); }
  return true;
}

/** Renewal trigger: policies renewing in exactly N days (N from each renewal automation), in the agency's time zone. */
async function renewals(agencyId: string) {
  const autos = await db.query.automations.findMany({ where: (a, { and, eq }) => and(eq(a.agencyId, agencyId), eq(a.trigger, 'renewal_date'), eq(a.active, true)) });
  const days = [...new Set(autos.flatMap((a) => a.triggerConfig.daysBefore ?? [60, 30]))];
  for (const n of days) {
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() + n);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    const due = await db.select({ p: policies, c: customers }).from(policies).innerJoin(customers, eq(policies.customerId, customers.id))
      .where(and(eq(customers.agencyId, agencyId), eq(policies.status, 'active'), sql`${policies.renewalDate} >= ${from}`, sql`${policies.renewalDate} < ${to}`));
    for (const { p, c } of due) {
      await fire(db, 'renewal_date', { agencyId, customerId: c.id, leadId: c.leadId, policyId: p.id, daysBefore: n });
      await notify(db, { agencyId, userId: p.agentId, kind: 'renew', text: `Upcoming renewal in ${n} days: ${c.name} · ${p.line} (${p.carrier})`, leadId: c.leadId });
    }
  }
}

/** "Follow-ups due today" notification for each agent (SOW 5). */
async function followupsDue(agencyId: string) {
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const rows = await db.select({ agentId: leads.agentId, n: sql<number>`count(*)::int` }).from(leads)
    .where(and(eq(leads.agencyId, agencyId), sql`${leads.followUpAt} <= ${end}`, sql`${leads.stage} not in ('won','lost','recycled')`, sql`${leads.agentId} is not null`)).groupBy(leads.agentId);
  for (const r of rows) if (r.n > 0) await notify(db, { agencyId, userId: r.agentId, kind: 'followups', text: `You have ${r.n} follow-up${r.n === 1 ? '' : 's'} due today` });
}

/** Birthday trigger + the birthday campaign message (SOW 4). */
async function birthdays(agencyId: string, md: string) {
  const camp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.agencyId, agencyId), eq(campaigns.kind, 'birthday')) });
  const people = await db.select().from(customers).where(and(eq(customers.agencyId, agencyId), sql`right(${customers.dob}, 5) = ${md}`));
  for (const c of people) {
    await fire(db, 'birthday', { agencyId, customerId: c.id, leadId: c.leadId });
    if (camp?.active) {
      const r = { kind: 'customer' as const, id: c.id };
      const contact = await contactFor(db, r); if (!contact) continue;
      await queueMessage(db, r, { channel: camp.channel, body: fill(camp.body, await varsFor(db, contact)), subject: camp.subject, automated: true });
    }
  }
}

async function holidays(agencyId: string, md: string) {
  const list = await db.query.campaigns.findMany({ where: and(eq(campaigns.agencyId, agencyId), eq(campaigns.kind, 'holiday'), eq(campaigns.active, true), eq(campaigns.holidayDate, md)) });
  for (const h of list) await sendBroadcast(h.id, { includeCustomers: true });
}

/** Appointment reminders: notify the agent and text the lead `reminderMinutes` before the start. */
async function reminders() {
  const rows = await db.select({ a: appointments, l: leads }).from(appointments).innerJoin(leads, eq(appointments.leadId, leads.id))
    .where(and(eq(appointments.status, 'scheduled'), isNull(appointments.remindedAt), gt(appointments.startsAt, new Date()), lte(appointments.startsAt, new Date(Date.now() + 24 * 36e5))));
  for (const { a, l } of rows) {
    const st = await getSettings(l.agencyId);
    if (a.startsAt.getTime() - Date.now() > st.reminderMinutes * 6e4) continue;
    await db.update(appointments).set({ remindedAt: new Date() }).where(eq(appointments.id, a.id));
    const when = a.startsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: st.timezone });
    await notify(db, { agencyId: l.agencyId, userId: a.userId, kind: 'call', text: `Upcoming ${a.type.toLowerCase()} with ${l.firstName} ${l.lastName} at ${when}`, leadId: l.id });
    const agent = await db.query.users.findFirst({ where: eq(users.id, a.userId) });
    await queueMessage(db, { kind: 'lead', id: l.id }, { channel: 'sms', automated: true, body: `Hi ${l.firstName}, a reminder that ${agent?.name ?? 'your agent'} will talk with you at ${when}.` });
  }
}

export async function tick() {
  const { rows } = await pool.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [LOCK_KEY]);
  if (!rows[0]?.ok) return;
  try {
    await processDueRuns();
    await deliverQueued();
    await reminders();
    const due = await db.query.campaigns.findMany({ where: and(eq(campaigns.kind, 'broadcast'), isNull(campaigns.sentAt), lte(campaigns.scheduledFor, new Date())) });
    for (const c of due) {
      const st = await getSettings(c.agencyId);
      if (isBusinessTime(new Date(), st)) await sendBroadcast(c.id);
    }
    for (const a of await db.select().from(agencies)) {
      const st = await getSettings(a.id);
      const p = localParts(new Date(), st.timezone);
      if (p.h * 60 + p.min < Number(st.businessOpen.slice(0, 2)) * 60 + Number(st.businessOpen.slice(3))) continue; // daily jobs run after opening time
      await once('auto_moves', a.id, p.date, () => runAutoMoves(a.id));
      await once('renewals', a.id, p.date, () => renewals(a.id));
      await once('birthdays', a.id, p.date, () => birthdays(a.id, p.md));
      await once('holidays', a.id, p.date, () => holidays(a.id, p.md));
      await once('followups', a.id, p.date, () => followupsDue(a.id));
    }
    // One database backup per day (first agency's date is fine: the backup covers everything).
    const first = (await db.select({ id: agencies.id }).from(agencies).limit(1))[0];
    if (first && process.env.BACKUP_DIR) await once('backup', first.id, new Date().toISOString().slice(0, 10), async () => { const r = await backupDatabase(); if (r) console.log('Backup written', r.file); });
  } finally {
    await pool.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

export function startWorker(everyMs = 15_000) {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await tick(); } catch (e) { console.error('worker tick failed', e); } finally { busy = false; } };
  setTimeout(run, 2000);
  return setInterval(run, everyMs);
}
