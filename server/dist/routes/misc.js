import { Router } from 'express';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { customers, leadSources, notifications, policies, sales } from '../db/schema.js';
import { CARRIERS, LINES } from '../domain.js';
import { ah, badRequest } from '../lib/http.js';
import { requireAdmin } from '../middleware/auth.js';
import { notify, runAutoMoves, setStage } from '../services/rules.js';
import { fire } from '../services/automation.js';
import { getVisibleLead } from '../services/scope.js';
export const notificationsRouter = Router();
const mine = (r) => and(eq(notifications.agencyId, r.user.agencyId), r.user.role === 'admin' ? or(isNull(notifications.userId), eq(notifications.userId, r.user.id)) : eq(notifications.userId, r.user.id));
notificationsRouter.get('/', ah(async (req, res) => {
    res.json(await db.select().from(notifications).where(mine(req)).orderBy(desc(notifications.createdAt)).limit(30));
}));
notificationsRouter.post('/read-all', ah(async (req, res) => {
    await db.update(notifications).set({ readAt: new Date() }).where(and(mine(req), isNull(notifications.readAt)));
    res.json({ ok: true });
}));
export const wonRouter = Router();
/** Won → create customer + policy + sale, queue a review request (SOW 6). */
wonRouter.post('/:id/won', ah(async (req, res) => {
    const lead = await getVisibleLead(req.user, String(req.params.id));
    const body = z.object({
        carrier: z.string().min(1).max(80),
        line: z.enum(LINES),
        premium: z.number().positive(),
        policyNumber: z.string().min(1).max(60),
        effectiveDate: z.string().date(),
    }).parse(req.body);
    if (lead.stage === 'won')
        throw badRequest('This lead is already won');
    const effective = new Date(`${body.effectiveDate}T12:00:00`);
    const renewal = new Date(effective);
    renewal.setFullYear(renewal.getFullYear() + 1);
    const result = await db.transaction(async (tx) => {
        let cust = await tx.query.customers.findFirst({ where: eq(customers.leadId, lead.id) });
        if (!cust) {
            [cust] = await tx.insert(customers).values({
                agencyId: lead.agencyId, leadId: lead.id, agentId: lead.agentId ?? req.user.id, name: `${lead.firstName} ${lead.lastName}`,
                company: lead.company, phone: lead.phone, email: lead.email, type: lead.type, dob: lead.custom.dob ?? null, source: lead.source,
            }).returning();
        }
        const [policy] = await tx.insert(policies).values({
            customerId: cust.id, agentId: cust.agentId, policyNumber: body.policyNumber, carrier: body.carrier, line: body.line,
            premium: body.premium, effectiveDate: effective, renewalDate: renewal,
        }).returning();
        await tx.insert(sales).values({
            agencyId: lead.agencyId, customerId: cust.id, policyId: policy.id, agentId: cust.agentId, carrier: body.carrier,
            line: body.line, source: lead.source, premium: body.premium, soldAt: new Date(),
        });
        await setStage(tx, lead, 'won', { id: req.user.id, name: req.user.name }, 'policy created');
        await fire(tx, 'policy_won', { agencyId: lead.agencyId, leadId: lead.id, customerId: cust.id, policyId: policy.id });
        await notify(tx, { agencyId: lead.agencyId, userId: null, kind: 'sale', text: `Sale: ${cust.name} · ${body.line} · $${body.premium.toLocaleString('en-US')}`, leadId: lead.id });
        return { customer: cust, policy };
    });
    res.status(201).json(result);
}));
export const metaRouter = Router();
metaRouter.get('/lookups', ah(async (req, res) => {
    const sources = await db.select().from(leadSources).where(eq(leadSources.agencyId, req.user.agencyId));
    // Webhook keys are secrets: only admins see them.
    res.json({ sources: sources.map((x) => (req.user.role === 'admin' ? x : { ...x, webhookKey: null })), carriers: CARRIERS, lines: LINES });
}));
metaRouter.post('/auto-moves', requireAdmin, ah(async (req, res) => {
    res.json({ moved: await runAutoMoves(req.user.agencyId) });
}));
//# sourceMappingURL=misc.js.map