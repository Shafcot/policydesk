// Book of business: customers, policies, renewals, import, sales ledger, targets, reports.
import { Router } from 'express';
import { and, asc, desc, eq, gt, gte, ilike, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agencies, calls, customers, leads, leadSources, policies, sales, users } from '../db/schema.js';
import { LINES, lineType, NOT_REACHED } from '../domain.js';
import { ah, notFound } from '../lib/http.js';
import { requireAdmin } from '../middleware/auth.js';
import { getSettings } from '../services/rules.js';
export const bookRouter = Router();
const custScope = (r) => r.user.role === 'admin'
    ? eq(customers.agencyId, r.user.agencyId)
    : and(eq(customers.agencyId, r.user.agencyId), eq(customers.agentId, r.user.id));
const saleScope = (r) => r.user.role === 'admin'
    ? eq(sales.agencyId, r.user.agencyId)
    : and(eq(sales.agencyId, r.user.agencyId), eq(sales.agentId, r.user.id));
/* ---------- customers & policies ---------- */
bookRouter.get('/customers', ah(async (req, res) => {
    const { q } = z.object({ q: z.string().optional() }).parse(req.query);
    const where = [custScope(req)];
    if (q)
        where.push(or(ilike(customers.name, `%${q}%`), ilike(customers.phone, `%${q}%`), ilike(customers.company, `%${q}%`)));
    const rows = await db.select({
        c: customers, agentName: users.name,
        policyCount: sql `(select count(*)::int from policies p where p.customer_id = ${customers.id})`,
        premium: sql `(select coalesce(sum(p.premium),0)::float from policies p where p.customer_id = ${customers.id})`,
    }).from(customers).leftJoin(users, eq(customers.agentId, users.id)).where(and(...where)).orderBy(desc(customers.createdAt)).limit(500);
    res.json(rows.map((r) => ({ ...r.c, agentName: r.agentName, policyCount: r.policyCount, premium: Number(r.premium) })));
}));
bookRouter.get('/customers/:id', ah(async (req, res) => {
    const c = await db.query.customers.findFirst({ where: and(eq(customers.id, String(req.params.id)), custScope(req)), with: { policies: true } });
    if (!c)
        throw notFound('Customer not found');
    const agent = c.agentId ? await db.query.users.findFirst({ where: eq(users.id, c.agentId) }) : null;
    let history = null;
    if (c.leadId) {
        const [h] = await db.select({
            calls: sql `(select count(*)::int from calls where lead_id = ${c.leadId})`,
            messages: sql `(select count(*)::int from messages where lead_id = ${c.leadId})`,
            notes: sql `(select count(*)::int from notes where lead_id = ${c.leadId})`,
        }).from(agencies).limit(1);
        history = h;
    }
    res.json({ ...c, agentName: agent?.name ?? null, history });
}));
const PolicyIn = z.object({ carrier: z.string().min(1), line: z.enum(LINES), premium: z.number().positive(), policyNumber: z.string().min(1), effectiveDate: z.string().date() });
bookRouter.post('/customers/:id/policies', ah(async (req, res) => {
    const c = await db.query.customers.findFirst({ where: and(eq(customers.id, String(req.params.id)), custScope(req)) });
    if (!c)
        throw notFound('Customer not found');
    const b = PolicyIn.parse(req.body);
    const eff = new Date(`${b.effectiveDate}T12:00:00`);
    const ren = new Date(eff);
    ren.setFullYear(ren.getFullYear() + 1);
    const p = await db.transaction(async (tx) => {
        const [p] = await tx.insert(policies).values({ customerId: c.id, agentId: c.agentId, policyNumber: b.policyNumber, carrier: b.carrier, line: b.line, premium: b.premium, effectiveDate: eff, renewalDate: ren }).returning();
        await tx.insert(sales).values({ agencyId: c.agencyId, customerId: c.id, policyId: p.id, agentId: c.agentId, carrier: b.carrier, line: b.line, source: c.source, premium: b.premium, soldAt: new Date() });
        return p;
    });
    res.status(201).json(p);
}));
bookRouter.get('/policies', ah(async (req, res) => {
    const { renewWithinDays } = z.object({ renewWithinDays: z.coerce.number().int().min(1).max(365).optional() }).parse(req.query);
    const where = [custScope(req)];
    if (renewWithinDays)
        where.push(gt(policies.renewalDate, new Date()), lt(policies.renewalDate, new Date(Date.now() + renewWithinDays * 864e5)));
    const rows = await db.select({ p: policies, customerName: customers.name, agentName: users.name })
        .from(policies).innerJoin(customers, eq(policies.customerId, customers.id)).leftJoin(users, eq(policies.agentId, users.id))
        .where(and(...where)).orderBy(asc(policies.renewalDate)).limit(1000);
    res.json(rows.map((r) => ({ ...r.p, customerName: r.customerName, agentName: r.agentName })));
}));
/** Spreadsheet import (rows parsed in the browser). Matches agents by email; unmatched rows go to the importing user. */
bookRouter.post('/customers/import', requireAdmin, ah(async (req, res) => {
    const Row = z.object({
        name: z.string().min(1), phone: z.string().optional(), email: z.string().optional(), type: z.string().optional(),
        carrier: z.string().optional(), line: z.string().optional(), premium: z.coerce.number().optional(),
        effective_date: z.string().optional(), policy_number: z.string().optional(), agent_email: z.string().optional(),
    });
    const { rows } = z.object({ rows: z.array(Row).min(1).max(5000) }).parse(req.body);
    const team = await db.query.users.findMany({ where: eq(users.agencyId, req.user.agencyId) });
    let imported = 0;
    const skipped = [];
    await db.transaction(async (tx) => {
        for (const [i, r] of rows.entries()) {
            const line = LINES.find((l) => l.toLowerCase() === (r.line ?? '').toLowerCase());
            const agent = team.find((u) => u.email.toLowerCase() === (r.agent_email ?? '').toLowerCase());
            const [c] = await tx.insert(customers).values({
                agencyId: req.user.agencyId, agentId: agent?.id ?? null, name: r.name.trim(), phone: r.phone || null, email: r.email || null,
                type: r.type?.toLowerCase() === 'commercial' || (line && lineType(line) === 'commercial') ? 'commercial' : 'personal', source: 'Spreadsheet import', imported: true,
            }).returning();
            imported++;
            if (line && r.premium && r.premium > 0) {
                const eff = r.effective_date && !Number.isNaN(Date.parse(r.effective_date)) ? new Date(r.effective_date) : new Date();
                const ren = new Date(eff);
                ren.setFullYear(ren.getFullYear() + 1);
                while (ren < new Date())
                    ren.setFullYear(ren.getFullYear() + 1);
                await tx.insert(policies).values({ customerId: c.id, agentId: c.agentId, policyNumber: r.policy_number || `IMP-${i + 1}`, carrier: r.carrier || 'Unknown', line, premium: r.premium, effectiveDate: eff, renewalDate: ren });
            }
            else if (r.line || r.premium)
                skipped.push({ row: i + 2, reason: 'Customer imported without a policy (line or premium missing/invalid)' });
        }
    });
    res.json({ imported, skipped });
}));
/* ---------- sales ledger ---------- */
bookRouter.get('/sales', ah(async (req, res) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), agent: z.string().uuid().optional() }).parse(req.query);
    const where = [saleScope(req)];
    if (q.month) {
        const [y, m] = q.month.split('-').map(Number);
        where.push(gte(sales.soldAt, new Date(y, m - 1, 1)), lt(sales.soldAt, new Date(y, m, 1)));
    }
    if (q.agent && req.user.role === 'admin')
        where.push(eq(sales.agentId, q.agent));
    const rows = await db.select({ s: sales, customerName: customers.name, policyNumber: policies.policyNumber, agentName: users.name })
        .from(sales).innerJoin(customers, eq(sales.customerId, customers.id)).innerJoin(policies, eq(sales.policyId, policies.id)).leftJoin(users, eq(sales.agentId, users.id))
        .where(and(...where)).orderBy(desc(sales.soldAt)).limit(2000);
    res.json(rows.map((r) => ({ ...r.s, customerName: r.customerName, policyNumber: r.policyNumber, agentName: r.agentName })));
}));
/* ---------- targets ---------- */
bookRouter.get('/targets', ah(async (req, res) => {
    const st = await getSettings(req.user.agencyId);
    const d = new Date();
    const from = new Date(d.getFullYear(), d.getMonth(), 1);
    const rows = await db.select({ agentId: sales.agentId, total: sql `coalesce(sum(${sales.premium}),0)::float`, n: sql `count(*)::int` })
        .from(sales).where(and(eq(sales.agencyId, req.user.agencyId), gte(sales.soldAt, from))).groupBy(sales.agentId);
    const team = await db.query.users.findMany({ where: and(eq(users.agencyId, req.user.agencyId), eq(users.role, 'agent'), eq(users.active, true)), orderBy: asc(users.name) });
    const agents = team.filter((u) => req.user.role === 'admin' || u.id === req.user.id).map((u) => {
        const r = rows.find((x) => x.agentId === u.id);
        return { id: u.id, name: u.name, target: u.monthlyTarget, achieved: Number(r?.total ?? 0), sold: r?.n ?? 0 };
    });
    const teamAchieved = rows.reduce((a, r) => a + Number(r.total), 0);
    res.json({ team: req.user.role === 'admin' || st.teamTargetVisible ? { target: st.teamTarget, achieved: teamAchieved } : null, teamTargetVisible: st.teamTargetVisible, agents });
}));
/* ---------- reports ---------- */
bookRouter.get('/reports', ah(async (req, res) => {
    const { months, agent } = z.object({ months: z.coerce.number().int().min(1).max(24).default(6), agent: z.string().uuid().optional() }).parse(req.query);
    const admin = req.user.role === 'admin';
    const agentId = admin ? agent : req.user.id;
    const d = new Date();
    const from = new Date(d.getFullYear(), d.getMonth() - months + 1, 1);
    const sWhere = and(eq(sales.agencyId, req.user.agencyId), gte(sales.soldAt, from), ...(agentId ? [eq(sales.agentId, agentId)] : []));
    const lWhere = and(eq(leads.agencyId, req.user.agencyId), gte(leads.createdAt, from), ...(agentId ? [eq(leads.agentId, agentId)] : []));
    const [byAgent, bySource, byCarrier, byMonth, leadsBySource, perfCalls, leadsByAgent, sources] = await Promise.all([
        db.select({ agentId: sales.agentId, total: sql `sum(${sales.premium})::float`, n: sql `count(*)::int`,
            personal: sql `coalesce(sum(${sales.premium}) filter (where ${sales.line} in ('Auto','Home','Renters','Life','Umbrella')),0)::float`,
        }).from(sales).where(sWhere).groupBy(sales.agentId),
        db.select({ key: sales.source, total: sql `sum(${sales.premium})::float`, n: sql `count(*)::int` }).from(sales).where(sWhere).groupBy(sales.source),
        db.select({ key: sales.carrier, total: sql `sum(${sales.premium})::float`, n: sql `count(*)::int` }).from(sales).where(sWhere).groupBy(sales.carrier),
        db.select({ key: sql `to_char(date_trunc('month', ${sales.soldAt}), 'YYYY-MM')`, total: sql `sum(${sales.premium})::float` }).from(sales).where(sWhere).groupBy(sql `1`),
        db.select({ key: leads.source, n: sql `count(*)::int`, won: sql `count(*) filter (where ${leads.stage} = 'won')::int` }).from(leads).where(lWhere).groupBy(leads.source),
        db.select({ userId: calls.userId, n: sql `count(*)::int`,
            contacts: sql `count(*) filter (where ${calls.result} not in (${sql.join(NOT_REACHED.map((r) => sql `${r}`), sql `, `)}))::int`,
            quotes: sql `count(*) filter (where ${calls.result} = 'quoted')::int`,
        }).from(calls).innerJoin(leads, eq(calls.leadId, leads.id)).where(and(eq(leads.agencyId, req.user.agencyId), gte(calls.startedAt, from), ...(agentId ? [eq(calls.userId, agentId)] : []))).groupBy(calls.userId),
        db.select({ agentId: leads.agentId, n: sql `count(*)::int`, won: sql `count(*) filter (where ${leads.stage} = 'won')::int` }).from(leads).where(lWhere).groupBy(leads.agentId),
        db.select().from(leadSources).where(eq(leadSources.agencyId, req.user.agencyId)),
    ]);
    const team = await db.query.users.findMany({ where: and(eq(users.agencyId, req.user.agencyId), eq(users.role, 'agent')), orderBy: asc(users.name) });
    const scopedTeam = agentId ? team.filter((u) => u.id === agentId) : team;
    const monthsList = Array.from({ length: months }, (_, i) => { const x = new Date(from.getFullYear(), from.getMonth() + i, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; });
    res.json({
        from: from.toISOString(),
        production: monthsList.map((m) => ({ month: m, premium: Number(byMonth.find((r) => r.key === m)?.total ?? 0) })),
        bySource: bySource.map((r) => ({ name: r.key ?? 'Unknown', premium: Number(r.total), sold: r.n })).sort((a, b) => b.premium - a.premium),
        byCarrier: byCarrier.map((r) => ({ name: r.key, premium: Number(r.total), sold: r.n })).sort((a, b) => b.premium - a.premium),
        roi: sources.map((s) => {
            const l = leadsBySource.find((x) => x.key === s.name);
            const rev = Number(bySource.find((x) => x.key === s.name)?.total ?? 0);
            const leadsN = l?.n ?? 0;
            const cost = leadsN * s.costPerLead;
            return { name: s.name, vendor: s.isVendor, leads: leadsN, costPerLead: s.costPerLead, cost, won: l?.won ?? 0, conversion: leadsN ? Math.round(((l?.won ?? 0) / leadsN) * 100) : 0, revenue: rev, roi: cost ? Math.round(((rev - cost) / cost) * 100) : null };
        }),
        agents: scopedTeam.map((u) => {
            const s = byAgent.find((x) => x.agentId === u.id);
            const c = perfCalls.find((x) => x.userId === u.id);
            const l = leadsByAgent.find((x) => x.agentId === u.id);
            const premium = Number(s?.total ?? 0), personal = Number(s?.personal ?? 0);
            return { id: u.id, name: u.name, premium, sold: s?.n ?? 0, personal, commercial: premium - personal, calls: c?.n ?? 0, contacts: c?.contacts ?? 0, quotes: c?.quotes ?? 0, leads: l?.n ?? 0, conversion: l?.n ? Math.round((l.won / l.n) * 100) : 0 };
        }),
    });
}));
//# sourceMappingURL=book.js.map