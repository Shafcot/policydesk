// Live calls (admin monitoring), transfers, voicemails and speed-dial contacts.
import { Router } from 'express';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { leads, liveCalls, speedDialContacts, users, voicemails } from '../db/schema.js';
import { ah, badRequest, forbidden, notFound } from '../lib/http.js';
import { requireAdmin } from '../middleware/auth.js';
import { cancelTransfer, completeTransfer, startTransfer } from '../integrations/callflow.js';
import { toE164 } from '../integrations/phone.js';
import { signPath } from '../integrations/signed.js';
import { enabled } from '../integrations/settings.js';
export const callsRouter = Router();
/** Calls ringing or in progress right now (Super Admin: listen in / whisper). */
callsRouter.get('/calls/live', requireAdmin, ah(async (req, res) => {
    const rows = await db.select({ c: liveCalls, agentName: users.name, firstName: leads.firstName, lastName: leads.lastName })
        .from(liveCalls).leftJoin(users, eq(liveCalls.agentId, users.id)).leftJoin(leads, eq(liveCalls.leadId, leads.id))
        .where(and(eq(liveCalls.agencyId, req.user.agencyId), inArray(liveCalls.status, ['ringing', 'active']), gt(liveCalls.createdAt, new Date(Date.now() - 4 * 3600_000)))).orderBy(liveCalls.createdAt);
    res.json({ voice: enabled.voice(), calls: rows.map(({ c, agentName, firstName, lastName }) => ({
            id: c.id, direction: c.direction, status: c.status, agentId: c.agentId, agentName, leadId: c.leadId,
            leadName: firstName ? `${firstName} ${lastName}` : null, number: c.customerNumber, answeredAt: c.answeredAt, createdAt: c.createdAt,
            transfer: c.transfer ? { mode: c.transfer.mode, label: c.transfer.label, state: c.transfer.state } : null,
        })) });
}));
const mine = async (req, id) => {
    const c = await db.query.liveCalls.findFirst({ where: and(eq(liveCalls.id, id), eq(liveCalls.agencyId, req.user.agencyId)) });
    if (!c || c.status === 'ended')
        throw notFound('This call has ended');
    if (c.agentId !== req.user.id && req.user.role !== 'admin')
        throw forbidden('This isn’t your call');
    return c;
};
/** Who an agent can transfer to: teammates (with status) and shared speed-dial contacts. */
callsRouter.get('/calls/transfer-targets', ah(async (req, res) => {
    const team = await db.query.users.findMany({ where: and(eq(users.agencyId, req.user.agencyId), eq(users.active, true)) });
    const contacts = await db.query.speedDialContacts.findMany({ where: and(eq(speedDialContacts.agencyId, req.user.agencyId), or(eq(speedDialContacts.shared, true), eq(speedDialContacts.userId, req.user.id))) });
    res.json({
        users: team.filter((u) => u.id !== req.user.id && !u.inviteToken).map((u) => ({ id: u.id, name: u.name, role: u.role, status: u.status })),
        contacts: contacts.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
    });
}));
callsRouter.post('/calls/live/:id/transfer', ah(async (req, res) => {
    const c = await mine(req, String(req.params.id));
    if (c.status !== 'active')
        throw badRequest('You can transfer once the call is connected');
    if (c.transfer)
        throw badRequest('A transfer is already in progress');
    const b = z.object({ mode: z.enum(['warm', 'blind']), userId: z.string().uuid().optional(), number: z.string().max(40).optional() }).refine((x) => x.userId || x.number, 'Pick who to transfer to').parse(req.body);
    if (b.number && !toE164(b.number))
        throw badRequest('That phone number isn’t valid');
    try {
        const t = await startTransfer(c, req.user, b);
        res.json({ transfer: t.transfer });
    }
    catch (e) {
        throw badRequest(e instanceof Error ? e.message : 'Transfer failed');
    }
}));
callsRouter.post('/calls/live/:id/transfer/complete', ah(async (req, res) => {
    const c = await mine(req, String(req.params.id));
    try {
        await completeTransfer(c);
        res.json({ ok: true });
    }
    catch (e) {
        throw badRequest(e instanceof Error ? e.message : 'Could not complete the transfer');
    }
}));
callsRouter.post('/calls/live/:id/transfer/cancel', ah(async (req, res) => {
    await cancelTransfer(await mine(req, String(req.params.id)));
    res.json({ ok: true });
}));
/* ---------- voicemails ---------- */
callsRouter.get('/voicemails', ah(async (req, res) => {
    const scope = req.user.role === 'admin' ? or(eq(voicemails.userId, req.user.id), isNull(voicemails.userId), eq(voicemails.agencyId, req.user.agencyId)) : eq(voicemails.userId, req.user.id);
    const rows = await db.select({ v: voicemails, firstName: leads.firstName, lastName: leads.lastName, userName: users.name }).from(voicemails)
        .leftJoin(leads, eq(voicemails.leadId, leads.id)).leftJoin(users, eq(voicemails.userId, users.id))
        .where(and(eq(voicemails.agencyId, req.user.agencyId), scope)).orderBy(desc(voicemails.createdAt)).limit(50);
    res.json(rows.map(({ v, firstName, lastName, userName }) => ({ ...v, recordingUrl: undefined, leadName: firstName ? `${firstName} ${lastName}` : null, userName, audio: signPath(`/media/voicemails/${v.id}`, 3600) })));
}));
callsRouter.patch('/voicemails/:id', ah(async (req, res) => {
    const v = await db.query.voicemails.findFirst({ where: and(eq(voicemails.id, String(req.params.id)), eq(voicemails.agencyId, req.user.agencyId)) });
    if (!v || (v.userId !== req.user.id && req.user.role !== 'admin'))
        throw notFound('Voicemail not found');
    await db.update(voicemails).set({ heardAt: new Date() }).where(eq(voicemails.id, v.id));
    res.json({ ok: true });
}));
/* ---------- speed-dial contacts (carrier lines etc.) ---------- */
callsRouter.get('/speed-dial/contacts', ah(async (req, res) => {
    res.json(await db.query.speedDialContacts.findMany({ where: and(eq(speedDialContacts.agencyId, req.user.agencyId), or(eq(speedDialContacts.shared, true), eq(speedDialContacts.userId, req.user.id))), orderBy: speedDialContacts.name }));
}));
callsRouter.post('/speed-dial/contacts', ah(async (req, res) => {
    const b = z.object({ name: z.string().min(1).max(120), phone: z.string().min(3).max(40), note: z.string().max(200).optional(), shared: z.boolean().default(false) }).parse(req.body);
    const phone = toE164(b.phone);
    if (!phone)
        throw badRequest('Enter a valid phone number');
    if (b.shared && req.user.role !== 'admin')
        throw forbidden('Only the Super Admin can share contacts with the team');
    const [c] = await db.insert(speedDialContacts).values({ agencyId: req.user.agencyId, userId: req.user.id, name: b.name, phone, note: b.note || null, shared: b.shared }).returning();
    res.status(201).json(c);
}));
callsRouter.delete('/speed-dial/contacts/:id', ah(async (req, res) => {
    const c = await db.query.speedDialContacts.findFirst({ where: and(eq(speedDialContacts.id, String(req.params.id)), eq(speedDialContacts.agencyId, req.user.agencyId)) });
    if (!c)
        throw notFound('Contact not found');
    if (c.userId !== req.user.id && req.user.role !== 'admin')
        throw forbidden('You can only remove your own contacts');
    await db.delete(speedDialContacts).where(eq(speedDialContacts.id, c.id));
    res.json({ ok: true });
}));
//# sourceMappingURL=calls.js.map