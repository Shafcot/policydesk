/**
 * Demo data for local development and client demos. seedDemo() wipes and recreates everything.
 * Run with `npm run db:seed`, or on a test server by starting with DEMO_DATA=true (only fills an empty database).
 * Sign-in: admin@policydesk.test / agent maya@policydesk.test — password from SEED_PASSWORD (default "Policydesk123!").
 */
import { sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  agencies, appointments, templates, favorites, campaigns, calls, customers, leads, leadSources, messages, notes, notifications, policies, sales, users,
} from './schema.js';
import { CARRIERS, COMMERCIAL_LINES, DEFAULT_SETTINGS, NOT_REACHED, PERSONAL_LINES, lineType, type CallResult, type Stage } from '../domain.js';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../lib/auth.js';
import { DEFAULT_SOURCES, installAgencyDefaults } from './defaults.js';


let s = 20261020;
const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const rint = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const DAY = 864e5;
const at = (dayOffset: number, h: number, m = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d; };

const FN = ['James', 'Olivia', 'Noah', 'Emma', 'Liam', 'Ava', 'Ethan', 'Sophia', 'Mason', 'Isabella', 'Lucas', 'Mia', 'Logan', 'Harper', 'Aiden', 'Evelyn', 'Carter', 'Abigail', 'Owen', 'Ella', 'Wyatt', 'Grace', 'Caleb', 'Chloe', 'Henry', 'Lily', 'Jack', 'Zoe', 'Levi', 'Nora'];
const LN = ['Johnson', 'Williams', 'Brown', 'Garcia', 'Miller', 'Davis', 'Martinez', 'Wilson', 'Anderson', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Hill', 'Scott'];
const BIZ = ['Lone Star Plumbing', 'Hill Country Roofing', 'Riverbend Bakery', 'Apex Freight LLC', 'Cedar Park Dental', 'Bluebonnet Landscaping', 'Summit HVAC', 'Northline Electric'];
const PREMIUM: Record<string, [number, number]> = { Auto: [1300, 2600], Home: [1200, 3200], Renters: [180, 360], Life: [600, 2400], Umbrella: [300, 650], 'Commercial Auto': [4500, 14000], 'General Liability': [1200, 6500], 'Workers Comp': [3000, 18000], BOP: [1500, 5200] };
const prem = (line: string) => { const [a, b] = PREMIUM[line]; return Math.round((a + rnd() * (b - a)) / 10) * 10; };
const phone = () => `(${pick(['512', '737', '210', '469', '214'])}) 555-0${rint(100, 199)}`;

const SUMMARY: Record<CallResult, (f: string, line: string) => string> = {
  no_answer: () => 'No answer. Lead re-queued for the next retry window.',
  voicemail: () => 'Reached voicemail. Left callback number and reason for call.',
  left_msg: (f) => `Spoke with a household member. Message left for ${f}.`,
  call_back: (f, l) => `${f} asked for a call-back tomorrow at 10 AM. Interested in ${l}.`,
  needs_quote: (_f, l) => `Rate increase with current carrier. Gathered details; ready to quote ${l}.`,
  quoted: (_f, l) => `Quoted ${l}. Lead reviewing with household; follow up in two days.`,
  sold: (_f, l) => `Sold ${l}. Policy bound; documents emailed.`,
  lost: () => 'Lost to a retention offer from the current carrier. Candidate for 5-month re-quote.',
};

export async function seedDemo() {
  await db.execute(sql`truncate team_emails, agencies, users, templates, favorites, automations, automation_runs, tasks, campaigns, job_runs, lead_sources, leads, calls, notes, messages, appointments, customers, policies, sales, notifications cascade`);
  const pw = await hashPassword(process.env.SEED_PASSWORD ?? 'Policydesk123!');

  const [agency] = await db.insert(agencies).values({
    name: 'Demo Insurance Agency', brandName: 'Policy-desk CRM',
    settings: { ...DEFAULT_SETTINGS, teamTarget: 240000, reviewLinks: { google: 'https://g.page/r/demo/review', facebook: 'https://facebook.com/demo/reviews', yelp: 'https://yelp.com/biz/demo' } },
  }).returning();

  const [admin] = await db.insert(users).values({ agencyId: agency.id, name: 'Rafay', email: 'admin@policydesk.test', role: 'admin', status: 'available', passwordHash: pw, bookingSlug: 'rafay' }).returning();
  const agentDefs = [
    { name: 'Maya Torres', email: 'maya@policydesk.test', hoursStart: '08:00', hoursEnd: '17:00', daysOff: ['Sat', 'Sun'], lines: ['Auto', 'Home', 'Renters', 'Life', 'Umbrella'], status: 'available' as const, monthlyTarget: 42000, maxCallsPerDay: 120 },
    { name: 'Daniel Brooks', email: 'daniel@policydesk.test', hoursStart: '08:30', hoursEnd: '17:30', daysOff: ['Sat', 'Sun'], lines: ['Commercial Auto', 'General Liability', 'Workers Comp', 'BOP'], status: 'available' as const, monthlyTarget: 65000, maxCallsPerDay: 100 },
    { name: 'Priya Shah', email: 'priya@policydesk.test', hoursStart: '09:00', hoursEnd: '18:00', daysOff: ['Sun', 'Mon'], lines: ['Auto', 'Home', 'Life', 'Umbrella'], status: 'available' as const, monthlyTarget: 40000, maxCallsPerDay: 120 },
    { name: 'Marcus Lee', email: 'marcus@policydesk.test', hoursStart: '08:00', hoursEnd: '17:00', daysOff: ['Sat', 'Sun'], lines: ['Auto', 'Commercial Auto', 'BOP', 'General Liability'], status: 'available' as const, monthlyTarget: 48000, maxCallsPerDay: 110 },
    { name: 'Elena Ruiz', email: 'elena@policydesk.test', hoursStart: '10:00', hoursEnd: '19:00', daysOff: ['Fri', 'Sat'], lines: ['Home', 'Renters', 'Auto'], status: 'offline' as const, monthlyTarget: 30000, maxCallsPerDay: 90 },
  ];
  const agents = await db.insert(users).values(agentDefs.map((a) => ({ ...a, agencyId: agency.id, role: 'agent' as const, passwordHash: pw, minCallsPerDay: 50, bookingSlug: a.name.split(' ')[0].toLowerCase() }))).returning();
  const maya = agents[0];

  await installAgencyDefaults(db, agency.id, { 'Facebook Ads': 18, 'Google Ads': 32, EverQuote: 24, MediaAlpha: 21, Instagram: 12 });
  const sourceNames = DEFAULT_SOURCES.map((d) => d[0]);

  const plan: [Stage, number][] = [['new', 10], ['attempted', 10], ['followup', 9], ['ready', 6], ['quoted', 8], ['won', 9], ['lost', 5], ['requote', 3], ['recycled', 3]];
  const finalResult: Record<Stage, CallResult> = { new: 'no_answer', attempted: 'no_answer', followup: 'call_back', ready: 'needs_quote', quoted: 'quoted', won: 'sold', lost: 'lost', requote: 'quoted', recycled: 'no_answer' };

  for (const [stage, count] of plan) {
    for (let i = 0; i < count; i++) {
      const type = rnd() < 0.7 ? 'personal' : 'commercial';
      const line = type === 'personal' ? pick(PERSONAL_LINES) : pick(COMMERCIAL_LINES);
      const elig = agents.filter((a) => a.lines.includes(line) && a.status !== 'offline');
      const agent = stage === 'new' && i < 3 ? null : (i % 4 === 0 && elig.includes(maya) ? maya : pick(elig.length ? elig : agents));
      const ageDays = stage === 'new' ? rnd() * 2 : stage === 'requote' ? 150 + rnd() * 30 : 2 + rnd() * 80;
      const created = new Date(Date.now() - ageDays * DAY);
      const first = pick(FN), last = pick(LN);
      const attempts = { new: 0, attempted: rint(1, 4), followup: rint(1, 3), ready: rint(1, 3), quoted: rint(2, 4), won: rint(2, 5), lost: rint(2, 5), requote: rint(2, 4), recycled: 8 }[stage];
      const quote = ['quoted', 'won', 'lost', 'requote'].includes(stage) ? prem(line) : null;

      const callRows: (typeof calls.$inferInsert)[] = [];
      const span = Math.max(ageDays, 0.3) * DAY;
      for (let k = 0; k < attempts; k++) {
        const t = new Date(created.getTime() + ((k + 1) * span) / (attempts + 1));
        const result = k < attempts - 1 ? pick(['no_answer', 'voicemail', 'left_msg'] as const) : stage === 'attempted' ? pick(NOT_REACHED) : finalResult[stage];
        const reached = !NOT_REACHED.includes(result);
        callRows.push({ startedAt: t, result, userId: agent?.id ?? maya.id, durationSec: reached ? rint(140, 760) : rint(18, 42), summary: SUMMARY[result](first, line), leadId: '' });
      }
      const lastCall = callRows.at(-1);
      const lastReached = [...callRows].reverse().find((c) => !NOT_REACHED.includes(c.result));
      let followUpAt: Date | null = null; let callback = false;
      if (stage === 'followup') { callback = rnd() < 0.6; followUpAt = pick([at(0, 10, 30), at(0, 14), at(1, 10), at(-1, 15)]); }
      if (stage === 'ready' || stage === 'quoted') followUpAt = at(rint(-1, 2), rint(9, 16));
      if (stage === 'attempted') followUpAt = new Date(Date.now() - rint(1, 6) * 3600e3);

      const [lead] = await db.insert(leads).values({
        agencyId: agency.id, firstName: first, lastName: last, company: type === 'commercial' ? pick(BIZ) : null, phone: phone(),
        email: rnd() < 0.08 ? null : `${first}.${last}`.toLowerCase() + '@' + pick(['gmail.com', 'yahoo.com', 'outlook.com']),
        stage, stageChangedAt: stage === 'requote' ? new Date(created.getTime() + 4 * DAY) : lastCall?.startedAt ?? created,
        source: pick(sourceNames), agentId: agent?.id ?? null, line, type: lineType(line), attempts,
        lastAttemptAt: lastCall?.startedAt ?? null, lastContactAt: lastReached?.startedAt ?? null, lastCallById: lastCall ? agent?.id ?? maya.id : null,
        followUpAt, callbackRequested: callback, quotePremium: quote,
        automation: stage === 'new' || stage === 'attempted' ? 'New-lead drip' : stage === 'requote' ? '5-month re-quote' : null,
        custom: { dob: `${1960 + rint(0, 40)}-${String(rint(1, 12)).padStart(2, '0')}-${String(rint(1, 28)).padStart(2, '0')}`, zip: String(rint(78701, 78759)), carrier: pick(CARRIERS) },
        createdAt: created,
      }).returning();

      if (callRows.length) await db.insert(calls).values(callRows.map((c) => ({ ...c, leadId: lead.id })));
      await db.insert(notes).values({ leadId: lead.id, body: `Lead received from ${lead.source}. Requested ${line} quote.`, createdAt: new Date(created.getTime() + 60e3) });
      if (agent && stage !== 'new') {
        await db.insert(messages).values([
          { leadId: lead.id, channel: 'sms', direction: 'out', automated: true, body: `Hi ${first}, thanks for requesting a quote! ${agent.name} will call you shortly. Reply STOP to opt out.`, createdAt: new Date(created.getTime() + 60e3), readAt: created },
          ...(i % 2 === 0 ? [{ leadId: lead.id, channel: 'sms' as const, direction: 'in' as const, body: pick(['Yes I am interested. Best time is after 5pm.', 'What info do you need from me?', 'Can you send the quote by text?']), createdAt: new Date(Math.min(Date.now() - 600e3, created.getTime() + 20 * 60e3)), readAt: i % 4 === 0 ? null : created }] : []),
        ]);
      }
      if (callback && agent && followUpAt) await db.insert(appointments).values({ leadId: lead.id, userId: agent.id, startsAt: followUpAt, durationMin: 15, type: 'Call-back', status: followUpAt < new Date() ? 'done' : 'scheduled' });
      if (agent && !['won', 'lost', 'recycled'].includes(stage) && rnd() < 0.5) {
        const t = at(rint(-3, 5), pick([9, 10, 11, 13, 14, 15, 16]), pick([0, 30]));
        await db.insert(appointments).values({ leadId: lead.id, userId: agent.id, startsAt: t, type: pick(['Quote review', 'Policy review', 'Discovery call']), status: t < new Date() ? (rnd() < 0.15 ? 'noshow' : 'done') : 'scheduled' });
      }
      if (stage === 'won' && agent) {
        const [cust] = await db.insert(customers).values({ agencyId: agency.id, leadId: lead.id, agentId: agent.id, name: `${first} ${last}`, company: lead.company, phone: lead.phone, email: lead.email, type: lead.type, source: lead.source, createdAt: lead.stageChangedAt }).returning();
        const eff = lead.stageChangedAt; const ren = new Date(eff); ren.setFullYear(ren.getFullYear() + 1);
        const [pol] = await db.insert(policies).values({ customerId: cust.id, agentId: agent.id, policyNumber: `${type === 'commercial' ? 'CP' : 'PL'}-${rint(100000, 999999)}`, carrier: pick(CARRIERS), line, premium: quote!, effectiveDate: eff, renewalDate: ren }).returning();
        await db.insert(sales).values({ agencyId: agency.id, customerId: cust.id, policyId: pol.id, agentId: agent.id, carrier: pol.carrier, line, source: lead.source, premium: quote!, soldAt: eff });
      }
    }
  }

  // Make sure every active agent has a working day today (demo realism).
  for (const a of agents.filter((x) => x.status !== 'offline')) {
    const theirs = await db.query.leads.findMany({ where: (l, { and, eq, notInArray }) => and(eq(l.agentId, a.id), notInArray(l.stage, ['won', 'lost', 'recycled'])), limit: 3 });
    for (const [i, l] of theirs.entries()) {
      const t = at(0, [10, 13, 15][i], i === 1 ? 30 : 0);
      await db.insert(appointments).values({ leadId: l.id, userId: a.id, startsAt: t, durationMin: 30, type: ['Quote review', 'Call-back', 'Policy review'][i], status: t < new Date() ? 'done' : 'scheduled' });
    }
  }

  const mayaLeads = await db.query.leads.findMany({ where: (l, { eq }) => eq(l.agentId, maya.id), limit: 3 });
  if (mayaLeads.length) await db.insert(favorites).values(mayaLeads.map((l) => ({ userId: maya.id, leadId: l.id })));

  // Imported book of business (older customers) → renewals in the next 90 days + six months of production.
  for (let i = 0; i < 30; i++) {
    const type = rnd() < 0.72 ? 'personal' : 'commercial';
    const line = type === 'personal' ? pick(PERSONAL_LINES) : pick(COMMERCIAL_LINES);
    const agent = i < 4 ? maya : pick(agents.filter((a) => a.lines.includes(line)));
    const eff = new Date(Date.now() - rint(8, 358) * DAY); const ren = new Date(eff); ren.setFullYear(ren.getFullYear() + 1);
    const name = `${pick(FN)} ${pick(LN)}`;
    const [cust] = await db.insert(customers).values({ agencyId: agency.id, agentId: agent.id, name, phone: phone(), email: name.toLowerCase().replace(' ', '.') + '@gmail.com', type, source: pick(sourceNames), imported: true, company: type === 'commercial' ? pick(BIZ) : null }).returning();
    const p = prem(line);
    const [pol] = await db.insert(policies).values({ customerId: cust.id, agentId: agent.id, policyNumber: `${type === 'commercial' ? 'CP' : 'PL'}-${rint(100000, 999999)}`, carrier: pick(CARRIERS), line, premium: p, effectiveDate: eff, renewalDate: ren }).returning();
    if (Date.now() - eff.getTime() < 200 * DAY) await db.insert(sales).values({ agencyId: agency.id, customerId: cust.id, policyId: pol.id, agentId: agent.id, carrier: pol.carrier, line, source: cust.source, premium: p, soldAt: eff });
  }

  const md = `${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
  const allCust = await db.select({ id: customers.id }).from(customers);
  for (const [i, c] of allCust.entries()) await db.update(customers).set({ dob: i < 2 ? `${1975 + i * 9}-${md}` : `${1955 + rint(0, 45)}-${String(rint(1, 12)).padStart(2, '0')}-${String(rint(1, 28)).padStart(2, '0')}` }).where(sql`id = ${c.id}`);

  await db.insert(notifications).values([
    { agencyId: agency.id, userId: null, kind: 'warn', text: 'No agent matched 3 new leads. They are waiting in intake.' },
    { agencyId: agency.id, userId: maya.id, kind: 'lead', text: 'New lead assigned to Maya Torres' },
    { agencyId: agency.id, userId: null, kind: 'renew', text: 'Upcoming renewals: several policies renew in the next 30 days' },
  ]);

  const counts = await db.execute(sql`select (select count(*) from leads) leads, (select count(*) from calls) calls, (select count(*) from customers) customers, (select count(*) from sales) sales`);
  console.log('Seeded', counts.rows[0]);
  console.log(`Admin: ${admin.email} · Agent: ${maya.email} · password: ${process.env.SEED_PASSWORD ? '(SEED_PASSWORD)' : 'Policydesk123!'}`);
}

