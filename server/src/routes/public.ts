// Public booking page (SOW 3: "Booking link per agent – leads pick a free time slot"). No sign-in required.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agencies, appointments, leads, notes, users } from '../db/schema.js';
import { LINES, lineType } from '../domain.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { stopRuns } from '../services/automation.js';
import { localParts, zonedToUtc } from '../services/hours.js';
import { emitLead } from '../services/realtime.js';
import { getSettings, notify } from '../services/rules.js';

export const publicRouter = Router();
publicRouter.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

const SLOT_MIN = 30;
const DAYS_AHEAD = 14;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function agentBySlug(slug: string) {
  const u = await db.query.users.findFirst({ where: and(eq(users.bookingSlug, slug), eq(users.active, true)) });
  if (!u) throw notFound('This booking link is not valid');
  const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, u.agencyId) });
  return { u, agency: agency!, st: await getSettings(u.agencyId) };
}

/** Free 30-minute slots inside the agent's working hours, skipping days off and booked times. Times are in the agency's time zone. */
async function freeSlots(u: typeof users.$inferSelect, tz: string) {
  const now = new Date();
  const until = new Date(now.getTime() + DAYS_AHEAD * 864e5);
  const busy = await db.select({ s: appointments.startsAt, d: appointments.durationMin }).from(appointments)
    .where(and(eq(appointments.userId, u.id), inArray(appointments.status, ['scheduled']), gte(appointments.startsAt, now), lt(appointments.startsAt, until)));
  const [sh, sm] = u.hoursStart.split(':').map(Number);
  const [eh, em] = u.hoursEnd.split(':').map(Number);
  const today = localParts(now, tz);
  const days: { date: string; label: string; slots: string[] }[] = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + i, 12));
    const dow = DOW[base.getUTCDay()];
    if (u.daysOff.includes(dow)) continue;
    const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, d = base.getUTCDate();
    const slots: string[] = [];
    for (let t = sh * 60 + sm; t + SLOT_MIN <= eh * 60 + em; t += SLOT_MIN) {
      const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      if (start.getTime() < now.getTime() + 60 * 60_000) continue; // at least 1 hour notice
      const end = start.getTime() + SLOT_MIN * 60_000;
      const clash = busy.some((b) => b.s.getTime() < end && b.s.getTime() + b.d * 60_000 > start.getTime());
      if (!clash) slots.push(start.toISOString());
    }
    if (slots.length) days.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, label: `${dow} ${base.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`, slots });
  }
  return days;
}

publicRouter.get('/book/:slug', ah(async (req, res) => {
  const { u, agency, st } = await agentBySlug(String(req.params.slug));
  res.json({ agent: u.name.split(' ')[0] + (u.name.includes(' ') ? ` ${u.name.split(' ').at(-1)![0]}.` : ''), agency: agency.name, brandName: agency.brandName, timezone: st.timezone, lines: LINES, days: await freeSlots(u, st.timezone) });
}));

publicRouter.post('/book/:slug', ah(async (req, res) => {
  const { u, st } = await agentBySlug(String(req.params.slug));
  const b = z.object({
    firstName: z.string().min(1).max(80), lastName: z.string().min(1).max(80), phone: z.string().min(7).max(40), email: z.string().email().or(z.literal('')).optional(),
    line: z.enum(LINES), slot: z.string().datetime(), note: z.string().max(500).optional(),
  }).parse(req.body);
  const slot = new Date(b.slot);
  const valid = (await freeSlots(u, st.timezone)).some((d) => d.slots.includes(slot.toISOString()));
  if (!valid) throw badRequest('That time was just taken. Please pick another slot.');
  const digits = b.phone.replace(/\D/g, '').slice(-10);
  const result = await db.transaction(async (tx) => {
    // Match an existing lead by phone in this agency, otherwise create one owned by this agent.
    const [existing] = await tx.select().from(leads).where(and(eq(leads.agencyId, u.agencyId), sql`right(regexp_replace(${leads.phone}, '\\D', '', 'g'), 10) = ${digits}`)).limit(1);
    const lead = existing ?? (await tx.insert(leads).values({
      agencyId: u.agencyId, firstName: b.firstName, lastName: b.lastName, phone: b.phone, email: b.email || null,
      line: b.line, type: lineType(b.line), source: 'Booking link', agentId: u.id,
    }).returning())[0];
    await tx.insert(appointments).values({ leadId: lead.id, userId: lead.agentId ?? u.id, startsAt: slot, durationMin: SLOT_MIN, type: 'Discovery call' });
    await tx.insert(notes).values({ leadId: lead.id, body: `Booked a ${SLOT_MIN}-minute call through ${u.name}'s booking link.${b.note ? ` Note: ${b.note}` : ''}` });
    await stopRuns(tx, lead.id, 'booking');
    const when = slot.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: st.timezone });
    await notify(tx, { agencyId: u.agencyId, userId: lead.agentId ?? u.id, kind: 'book', text: `${b.firstName} ${b.lastName} booked a call for ${when}`, leadId: lead.id });
    return { lead, when };
  });
  emitLead(u.agencyId, result.lead.agentId, existingOrNew(result.lead.createdAt), { id: result.lead.id });
  res.status(201).json({ ok: true, when: result.when });
}));

const existingOrNew = (createdAt: Date) => (Date.now() - createdAt.getTime() < 10_000 ? 'lead:new' : 'lead:changed');
