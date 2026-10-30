// Super Admin: users (invite / edit / remove), agency settings, lead sources, message templates.
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agencies, leads, leadSources, templates, users } from '../db/schema.js';
import { DEFAULT_SETTINGS, LINES } from '../domain.js';
import { env } from '../config.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { requireAdmin, type AuthedRequest } from '../middleware/auth.js';
import { getSettings, notify } from '../services/rules.js';
import { issueReset, publicUser } from './auth.js';
import { makeSlug } from '../lib/slug.js';
import { sendTeamEmail } from '../services/mailer.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const Hours = z.string().regex(/^\d\d:\d\d$/);
const Days = z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']));

/** Creates the user with an invite token. Emailing the link is wired in Milestone 3 (SendGrid); until then the admin copies it. */
adminRouter.post('/users/invite', ah<AuthedRequest>(async (req, res) => {
  const b = z.object({
    name: z.string().min(1).max(120), email: z.string().email(), role: z.enum(['admin', 'agent']).default('agent'),
    lines: z.array(z.enum(LINES)).default([]), hoursStart: Hours.default('08:00'), hoursEnd: Hours.default('17:00'),
    minCallsPerDay: z.number().int().min(0).default(50), maxCallsPerDay: z.number().int().min(0).default(100),
  }).parse(req.body);
  const email = b.email.toLowerCase().trim();
  if (await db.query.users.findFirst({ where: eq(users.email, email) })) throw badRequest('A user with that email already exists');
  const token = randomBytes(24).toString('hex');
  const [u] = await db.insert(users).values({ ...b, email, agencyId: req.user.agencyId, inviteToken: token, status: 'offline', bookingSlug: makeSlug(b.name) }).returning();
  const inviteLink = `${env.CLIENT_ORIGIN}/accept-invite?token=${token}`;
  await sendTeamEmail(db, { agencyId: req.user.agencyId, to: email, subject: `${req.user.name} invited you to Policy-desk CRM`, body: `Hi ${b.name.split(' ')[0]},\n\n${req.user.name} invited you to join Policy-desk CRM. Set your password here:\n${inviteLink}` });
  res.status(201).json({ user: publicUser(u), inviteLink });
}));

adminRouter.patch('/users/:id', ah<AuthedRequest>(async (req, res) => {
  const b = z.object({
    name: z.string().min(1).max(120).optional(), role: z.enum(['admin', 'agent']).optional(), lines: z.array(z.enum(LINES)).optional(),
    hoursStart: Hours.optional(), hoursEnd: Hours.optional(), daysOff: Days.optional(),
    minCallsPerDay: z.number().int().min(0).optional(), maxCallsPerDay: z.number().int().min(0).optional(), monthlyTarget: z.number().min(0).optional(),
  }).parse(req.body);
  const id = String(req.params.id);
  if (id === req.user.id && b.role === 'agent') throw badRequest('You cannot remove your own Super Admin role');
  const [u] = await db.update(users).set(b).where(and(eq(users.id, id), eq(users.agencyId, req.user.agencyId))).returning();
  if (!u) throw notFound('User not found');
  res.json(publicUser(u));
}));

/** Deactivates the user (history is kept) and moves their open leads back to intake. */
adminRouter.delete('/users/:id', ah<AuthedRequest>(async (req, res) => {
  const id = String(req.params.id);
  if (id === req.user.id) throw badRequest('You cannot remove yourself');
  const u = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.agencyId, req.user.agencyId)) });
  if (!u) throw notFound('User not found');
  const moved = await db.transaction(async (tx) => {
    await tx.update(users).set({ active: false, status: 'offline', inviteToken: null }).where(eq(users.id, id));
    const r = await tx.update(leads).set({ agentId: null }).where(eq(leads.agentId, id)).returning({ id: leads.id });
    if (r.length) await notify(tx, { agencyId: u.agencyId, userId: null, kind: 'warn', text: `${u.name} was removed. ${r.length} leads moved to intake for reassignment.` });
    return r.length;
  });
  res.json({ ok: true, leadsMovedToIntake: moved });
}));

/** Admin-triggered password reset: emails the user a link and returns it so the admin can share it directly. */
adminRouter.post('/users/:id/reset', ah<AuthedRequest>(async (req, res) => {
  const u = await db.query.users.findFirst({ where: and(eq(users.id, String(req.params.id)), eq(users.agencyId, req.user.agencyId)) });
  if (!u || !u.active) throw notFound('User not found');
  res.json({ resetLink: await issueReset(u.id) });
}));

/* ---------- settings ---------- */

adminRouter.get('/settings', ah<AuthedRequest>(async (req, res) => {
  const a = await db.query.agencies.findFirst({ where: eq(agencies.id, req.user.agencyId) });
  res.json({ agency: { name: a!.name, brandName: a!.brandName, brandColor: a!.brandColor, logoUrl: a!.logoUrl }, settings: await getSettings(req.user.agencyId) });
}));

const SettingsPatch = z.object({
  assignRule: z.enum(['round_robin', 'availability', 'line']), skipOffline: z.boolean(), skipAtLimit: z.boolean(),
  attemptsDay1: z.number().int().min(1).max(20), attemptsPerDay: z.number().int().min(0).max(20), maxAttempts: z.number().int().min(1).max(50), retryHours: z.number().min(0).max(72),
  requoteMonths: z.number().int().min(1).max(24), autoRequote: z.boolean(), autoRecycle: z.boolean(),
  teamTarget: z.number().min(0), teamTargetVisible: z.boolean(),
  businessDays: Days, businessOpen: Hours, businessClose: Hours, timezone: z.string().min(3),
  reviewLinks: z.object({ google: z.string().max(400), facebook: z.string().max(400), yelp: z.string().max(400) }),
  optOutKeywords: z.array(z.string().min(1).max(20)).min(1),
  customFields: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]+$/).max(40), label: z.string().min(1).max(60), type: z.enum(['text', 'number', 'date']) })).max(30),
  reminderMinutes: z.number().int().min(0).max(1440),
  screeningQuestions: z.array(z.string().max(200)).max(6).transform((a) => a.map((q) => q.trim()).filter(Boolean)),
}).partial();

adminRouter.patch('/settings', ah<AuthedRequest>(async (req, res) => {
  const b = z.object({ settings: SettingsPatch.optional(), agency: z.object({ name: z.string().min(1).max(160), brandName: z.string().min(1).max(80), brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() }).partial().optional() }).parse(req.body);
  const current = await getSettings(req.user.agencyId);
  await db.update(agencies).set({ ...(b.agency ?? {}), ...(b.settings ? { settings: { ...DEFAULT_SETTINGS, ...current, ...b.settings } } : {}) }).where(eq(agencies.id, req.user.agencyId));
  res.json({ settings: await getSettings(req.user.agencyId) });
}));

/* ---------- lead sources ---------- */

adminRouter.post('/lead-sources', ah<AuthedRequest>(async (req, res) => {
  const b = z.object({ name: z.string().min(1).max(80), costPerLead: z.number().min(0).default(0), isVendor: z.boolean().default(false) }).parse(req.body);
  const [s] = await db.insert(leadSources).values({ ...b, agencyId: req.user.agencyId, webhookKey: randomBytes(16).toString('hex') }).returning();
  res.status(201).json(s);
}));
adminRouter.patch('/lead-sources/:id', ah<AuthedRequest>(async (req, res) => {
  const b = z.object({ costPerLead: z.number().min(0).optional(), isVendor: z.boolean().optional() }).parse(req.body);
  const [s] = await db.update(leadSources).set(b).where(and(eq(leadSources.id, String(req.params.id)), eq(leadSources.agencyId, req.user.agencyId))).returning();
  if (!s) throw notFound('Source not found');
  res.json(s);
}));

/** New webhook key for a vendor (the old address stops working). */
adminRouter.post('/lead-sources/:id/rotate-key', ah<AuthedRequest>(async (req, res) => {
  const [s] = await db.update(leadSources).set({ webhookKey: randomBytes(16).toString('hex') }).where(and(eq(leadSources.id, String(req.params.id)), eq(leadSources.agencyId, req.user.agencyId))).returning();
  if (!s) throw notFound('Source not found');
  res.json(s);
}));

/* ---------- templates ---------- */

const Tpl = z.object({ channel: z.enum(['sms', 'email']), name: z.string().min(1).max(80), subject: z.string().max(240).nullable().optional(), body: z.string().min(1).max(5000) });
adminRouter.post('/templates', ah<AuthedRequest>(async (req, res) => {
  const [t] = await db.insert(templates).values({ ...Tpl.parse(req.body), agencyId: req.user.agencyId }).returning();
  res.status(201).json(t);
}));
adminRouter.patch('/templates/:id', ah<AuthedRequest>(async (req, res) => {
  const [t] = await db.update(templates).set(Tpl.partial().parse(req.body)).where(and(eq(templates.id, String(req.params.id)), eq(templates.agencyId, req.user.agencyId))).returning();
  if (!t) throw notFound('Template not found');
  res.json(t);
}));
adminRouter.delete('/templates/:id', ah<AuthedRequest>(async (req, res) => {
  await db.delete(templates).where(and(eq(templates.id, String(req.params.id)), eq(templates.agencyId, req.user.agencyId)));
  res.json({ ok: true });
}));

