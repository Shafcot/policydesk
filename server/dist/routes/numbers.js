// Phone numbers: the agency's pool of numbers (added by hand, imported from Twilio, or bought through Twilio),
// each assignable to one user as their caller ID and inbound line. Plus the dial pad's number lookup.
import { Router } from 'express';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { phoneNumbers, users } from '../db/schema.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { requireAdmin } from '../middleware/auth.js';
import { cfg } from '../integrations/settings.js';
import { toE164 } from '../integrations/phone.js';
import { twilioClient } from '../integrations/twilio.js';
import { leadByPhone } from '../integrations/webhooks.js';
export const numbersRouter = Router();
const twilioRest = () => !!(cfg.twilio().accountSid && cfg.twilio().authToken);
const E164 = z.string().transform((v, ctx) => { const n = toE164(v); if (!n || !/^\+[1-9]\d{7,14}$/.test(n)) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number, e.g. +15125550100' });
    return z.NEVER;
} return n; });
/** Gives `numberId` to `userId` (or nobody). A user has one number; their previous one goes back to the pool. */
async function assign(x, agencyId, numberId, userId) {
    const n = await x.query.phoneNumbers.findFirst({ where: and(eq(phoneNumbers.id, numberId), eq(phoneNumbers.agencyId, agencyId)) });
    if (!n)
        throw notFound('Number not found');
    if (userId) {
        const u = await x.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.agencyId, agencyId)) });
        if (!u)
            throw notFound('User not found');
        await x.update(phoneNumbers).set({ userId: null }).where(and(eq(phoneNumbers.userId, userId), ne(phoneNumbers.id, numberId)));
    }
    if (n.userId && n.userId !== userId)
        await x.update(users).set({ twilioNumber: null }).where(eq(users.id, n.userId));
    await x.update(phoneNumbers).set({ userId }).where(eq(phoneNumbers.id, numberId));
    if (userId)
        await x.update(users).set({ twilioNumber: n.number }).where(eq(users.id, userId));
}
/** Points a Twilio number's calls and texts at this CRM (best effort; needs a public address). */
async function connectToCrm(sid) {
    const base = cfg.publicApiUrl();
    if (!twilioRest() || !/^https:\/\//.test(base))
        return false;
    const c = twilioClient();
    const ms = cfg.twilio().messagingServiceSid;
    await c.incomingPhoneNumbers(sid).update({ voiceUrl: `${base}/webhooks/twilio/inbound`, voiceMethod: 'POST', ...(ms ? {} : { smsUrl: `${base}/webhooks/twilio/sms`, smsMethod: 'POST' }) });
    if (ms)
        await c.messaging.v1.services(ms).phoneNumbers.create({ phoneNumberSid: sid }).catch((e) => { if (e.code !== 21710 && e.code !== 21712)
            throw e; }); // already in the service
    return true;
}
const list = async (agencyId) => {
    const rows = await db.select({ n: phoneNumbers, userName: users.name }).from(phoneNumbers).leftJoin(users, eq(phoneNumbers.userId, users.id)).where(eq(phoneNumbers.agencyId, agencyId)).orderBy(phoneNumbers.createdAt);
    return rows.map(({ n, userName }) => ({ ...n, userName }));
};
numbersRouter.get('/admin/numbers', requireAdmin, ah(async (req, res) => {
    res.json({ numbers: await list(req.user.agencyId), twilio: twilioRest(), defaultCallerId: cfg.twilio().callerId || null });
}));
/** Adds a number the agency already has (e.g. ported, or already in the Twilio account). */
numbersRouter.post('/admin/numbers', requireAdmin, ah(async (req, res) => {
    const b = z.object({ number: E164, label: z.string().max(80).optional(), userId: z.string().uuid().nullable().optional() }).parse(req.body);
    if (await db.query.phoneNumbers.findFirst({ where: eq(phoneNumbers.number, b.number) }))
        throw badRequest('That number is already in the list');
    let twilioSid = null, warning;
    if (twilioRest()) {
        const found = await twilioClient().incomingPhoneNumbers.list({ phoneNumber: b.number, limit: 1 }).catch(() => []);
        twilioSid = found[0]?.sid ?? null;
        if (twilioSid)
            await connectToCrm(twilioSid).catch((e) => { warning = `Added, but its call settings could not be updated: ${e.message}`; });
        else
            warning = 'This number is not in the connected Twilio account, so calls to it won’t reach the CRM until it is ported to Twilio.';
    }
    const row = await db.transaction(async (tx) => {
        const [n] = await tx.insert(phoneNumbers).values({ agencyId: req.user.agencyId, number: b.number, label: b.label || null, twilioSid }).returning();
        if (b.userId)
            await assign(tx, req.user.agencyId, n.id, b.userId);
        return n;
    });
    res.status(201).json({ id: row.id, warning });
}));
/** Adds every number in the Twilio account that isn't in the list yet, and points them at the CRM. */
numbersRouter.post('/admin/numbers/sync', requireAdmin, ah(async (req, res) => {
    if (!twilioRest())
        throw badRequest('Connect Twilio in Settings → Integrations first.');
    const all = await twilioClient().incomingPhoneNumbers.list({ limit: 500 });
    const have = new Set((await db.select({ number: phoneNumbers.number }).from(phoneNumbers)).map((r) => r.number));
    let added = 0;
    for (const p of all) {
        if (have.has(p.phoneNumber))
            continue;
        await db.insert(phoneNumbers).values({ agencyId: req.user.agencyId, number: p.phoneNumber, label: p.friendlyName && p.friendlyName !== p.phoneNumber ? p.friendlyName.slice(0, 80) : null, twilioSid: p.sid });
        await connectToCrm(p.sid).catch(() => undefined);
        added++;
    }
    res.json({ added, total: all.length });
}));
/** Numbers available to buy (US/CA local), optionally by area code. */
numbersRouter.get('/admin/numbers/available', requireAdmin, ah(async (req, res) => {
    if (!twilioRest())
        throw badRequest('Connect Twilio in Settings → Integrations to buy numbers.');
    const q = z.object({ areaCode: z.string().regex(/^\d{3}$/).optional(), contains: z.string().regex(/^[0-9*]{2,10}$/).optional(), country: z.enum(['US', 'CA']).default('US') }).parse(req.query);
    const found = await twilioClient().availablePhoneNumbers(q.country).local.list({ ...(q.areaCode ? { areaCode: Number(q.areaCode) } : {}), ...(q.contains ? { contains: q.contains } : {}), voiceEnabled: true, smsEnabled: true, limit: 20 });
    res.json(found.map((n) => ({ number: n.phoneNumber, friendly: n.friendlyName, locality: n.locality, region: n.region })));
}));
/** Buys a number in the Twilio account (billed by Twilio), connects it to the CRM and optionally assigns it. */
numbersRouter.post('/admin/numbers/buy', requireAdmin, ah(async (req, res) => {
    if (!twilioRest())
        throw badRequest('Connect Twilio in Settings → Integrations to buy numbers.');
    const base = cfg.publicApiUrl();
    if (!/^https:\/\//.test(base))
        throw badRequest('The app needs a public https:// address before buying numbers (Settings → Integrations → App address).');
    const b = z.object({ number: E164, label: z.string().max(80).optional(), userId: z.string().uuid().nullable().optional() }).parse(req.body);
    const bought = await twilioClient().incomingPhoneNumbers.create({ phoneNumber: b.number, friendlyName: b.label || undefined, voiceUrl: `${base}/webhooks/twilio/inbound`, voiceMethod: 'POST', ...(cfg.twilio().messagingServiceSid ? {} : { smsUrl: `${base}/webhooks/twilio/sms`, smsMethod: 'POST' }) });
    let warning;
    await connectToCrm(bought.sid).catch((e) => { warning = `Bought, but it could not be added to the Messaging Service: ${e.message}`; });
    const row = await db.transaction(async (tx) => {
        const [n] = await tx.insert(phoneNumbers).values({ agencyId: req.user.agencyId, number: bought.phoneNumber, label: b.label || null, twilioSid: bought.sid }).returning();
        if (b.userId)
            await assign(tx, req.user.agencyId, n.id, b.userId);
        return n;
    });
    res.status(201).json({ id: row.id, number: row.number, warning });
}));
numbersRouter.patch('/admin/numbers/:id', requireAdmin, ah(async (req, res) => {
    const b = z.object({ label: z.string().max(80).nullable().optional(), userId: z.string().uuid().nullable().optional() }).parse(req.body);
    const id = String(req.params.id);
    await db.transaction(async (tx) => {
        if (b.label !== undefined) {
            const [n] = await tx.update(phoneNumbers).set({ label: b.label || null }).where(and(eq(phoneNumbers.id, id), eq(phoneNumbers.agencyId, req.user.agencyId))).returning();
            if (!n)
                throw notFound('Number not found');
        }
        if (b.userId !== undefined)
            await assign(tx, req.user.agencyId, id, b.userId);
    });
    res.json({ ok: true });
}));
/** Removes a number from the list. With ?release=true it is also released from Twilio (stops billing, can't be undone). */
numbersRouter.delete('/admin/numbers/:id', requireAdmin, ah(async (req, res) => {
    const n = await db.query.phoneNumbers.findFirst({ where: and(eq(phoneNumbers.id, String(req.params.id)), eq(phoneNumbers.agencyId, req.user.agencyId)) });
    if (!n)
        throw notFound('Number not found');
    if (req.query.release === 'true' && n.twilioSid) {
        if (!twilioRest())
            throw badRequest('Twilio is not connected, so the number can’t be released.');
        await twilioClient().incomingPhoneNumbers(n.twilioSid).remove();
    }
    await db.transaction(async (tx) => {
        if (n.userId)
            await tx.update(users).set({ twilioNumber: null }).where(eq(users.id, n.userId));
        await tx.delete(phoneNumbers).where(eq(phoneNumbers.id, n.id));
    });
    res.json({ ok: true });
}));
/* ---------- Dial pad ---------- */
/** What happens if this user dials `phone`: an existing lead they can call, someone else's lead (blocked), or a new number. */
numbersRouter.get('/dialpad/lookup', ah(async (req, res) => {
    const { phone } = z.object({ phone: z.string().min(3).max(40) }).parse(req.query);
    const e164 = toE164(phone);
    if (!e164)
        return res.json({ valid: false });
    const lead = await leadByPhone(e164, req.user.agencyId);
    if (!lead)
        return res.json({ valid: true, number: e164, lead: null });
    const mine = req.user.role === 'admin' || lead.agentId === req.user.id;
    if (!mine)
        return res.json({ valid: true, number: e164, lead: null, blocked: 'This number belongs to a lead assigned to another agent.' });
    res.json({ valid: true, number: e164, lead });
}));
//# sourceMappingURL=numbers.js.map