// Public booking page (SOW 3: "Booking link per agent – leads pick a free time slot"). No sign-in required.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agencies, leads, users } from '../db/schema.js';
import { LINES, lineType } from '../domain.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { bookLead, freeSlots } from '../services/booking.js';
import { emitLead } from '../services/realtime.js';
import { getSettings } from '../services/rules.js';

export const publicRouter = Router();
publicRouter.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

async function agentBySlug(slug: string) {
  const u = await db.query.users.findFirst({ where: and(eq(users.bookingSlug, slug), eq(users.active, true)) });
  if (!u) throw notFound('This booking link is not valid');
  const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, u.agencyId) });
  return { u, agency: agency!, st: await getSettings(u.agencyId) };
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
    const { when } = await bookLead(tx, { lead, agent: u, slot, tz: st.timezone, via: `through ${u.name}'s booking link`, note: b.note });
    return { lead, when };
  });
  emitLead(u.agencyId, result.lead.agentId, existingOrNew(result.lead.createdAt), { id: result.lead.id });
  res.status(201).json({ ok: true, when: result.when });
}));

const existingOrNew = (createdAt: Date) => (Date.now() - createdAt.getTime() < 10_000 ? 'lead:new' : 'lead:changed');
