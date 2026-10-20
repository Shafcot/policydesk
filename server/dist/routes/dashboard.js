import { Router } from 'express';
import { and, asc, eq, gte, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appointments, calls, customers, leads, policies, sales, users } from '../db/schema.js';
import { STAGES } from '../domain.js';
import { ah } from '../lib/http.js';
import { callsTodayByUser, getSettings } from '../services/rules.js';
import { leadScope } from '../services/scope.js';
export const dashboardRouter = Router();
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };
const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const dayEnd = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
dashboardRouter.get('/', ah(async (req, res) => {
    const u = req.user, admin = u.role === 'admin', agencyId = u.agencyId;
    const st = await getSettings(agencyId);
    const since30 = new Date(Date.now() - 30 * 864e5);
    const scope = leadScope(u);
    const saleScope = admin ? eq(sales.agencyId, agencyId) : and(eq(sales.agencyId, agencyId), eq(sales.agentId, u.id));
    const [stageRows, newLeads, contacted, quotedCalls, salesMonth, allLeads, wonLeads] = await Promise.all([
        db.select({ stage: leads.stage, n: sql `count(*)::int` }).from(leads).where(scope).groupBy(leads.stage),
        db.select({ n: sql `count(*)::int` }).from(leads).where(and(scope, gte(leads.createdAt, since30))),
        db.select({ n: sql `count(*)::int` }).from(leads).where(and(scope, gte(leads.lastContactAt, since30))),
        db.select({ n: sql `count(distinct ${calls.leadId})::int` }).from(calls).innerJoin(leads, eq(calls.leadId, leads.id)).where(and(scope, eq(calls.result, 'quoted'), gte(calls.startedAt, since30))),
        db.select({ agentId: sales.agentId, n: sql `count(*)::int`, total: sql `coalesce(sum(${sales.premium}),0)::float` }).from(sales).where(and(saleScope, gte(sales.soldAt, monthStart()))).groupBy(sales.agentId),
        db.select({ n: sql `count(*)::int` }).from(leads).where(scope),
        db.select({ n: sql `count(*)::int` }).from(leads).where(and(scope, eq(leads.stage, 'won'))),
    ]);
    const teamMonth = admin ? salesMonth : await db.select({ total: sql `coalesce(sum(${sales.premium}),0)::float` }).from(sales).where(and(eq(sales.agencyId, agencyId), gte(sales.soldAt, monthStart())));
    const teamRevenue = teamMonth.reduce((a, r) => a + Number(r.total), 0);
    const byStage = Object.fromEntries(STAGES.map((s) => [s, stageRows.find((r) => r.stage === s)?.n ?? 0]));
    const revenue = salesMonth.reduce((a, r) => a + Number(r.total), 0);
    const policiesSold = salesMonth.reduce((a, r) => a + r.n, 0);
    const team = await db.query.users.findMany({ where: and(eq(users.agencyId, agencyId), eq(users.role, 'agent'), eq(users.active, true)), orderBy: asc(users.name) });
    const today = await callsTodayByUser(agencyId);
    const leaderboard = team.map((a) => {
        const r = salesMonth.find((s) => s.agentId === a.id);
        return { id: a.id, name: a.name, premium: Number(r?.total ?? 0), sold: r?.n ?? 0, status: a.status, callsToday: today.get(a.id) ?? 0, maxCalls: a.maxCallsPerDay };
    }).sort((x, y) => y.premium - x.premium);
    const apptWhere = admin
        ? and(gte(appointments.startsAt, dayStart()), lt(appointments.startsAt, dayEnd()), eq(leads.agencyId, agencyId))
        : and(gte(appointments.startsAt, dayStart()), lt(appointments.startsAt, dayEnd()), eq(appointments.userId, u.id));
    const todayAppts = await db.select({ a: appointments, firstName: leads.firstName, lastName: leads.lastName, line: leads.line, phone: leads.phone, agentName: users.name })
        .from(appointments).innerJoin(leads, eq(appointments.leadId, leads.id)).innerJoin(users, eq(appointments.userId, users.id))
        .where(apptWhere).orderBy(asc(appointments.startsAt));
    const renewWindow = new Date(Date.now() + (admin ? 30 : 60) * 864e5);
    const renewals = await db.select({ p: policies, customerName: customers.name }).from(policies).innerJoin(customers, eq(policies.customerId, customers.id))
        .where(and(eq(customers.agencyId, agencyId), gt(policies.renewalDate, new Date()), lt(policies.renewalDate, renewWindow), ...(admin ? [] : [eq(policies.agentId, u.id)])))
        .orderBy(asc(policies.renewalDate)).limit(8);
    const unassigned = admin
        ? await db.select({ id: leads.id, firstName: leads.firstName, lastName: leads.lastName, source: leads.source, line: leads.line, createdAt: leads.createdAt })
            .from(leads).where(and(eq(leads.agencyId, agencyId), isNull(leads.agentId), inArray(leads.stage, ['new']))).orderBy(asc(leads.createdAt)).limit(20)
        : [];
    res.json({
        kpis: { newLeads: newLeads[0].n, contacted: contacted[0].n, quoted: quotedCalls[0].n, won: policiesSold, revenue, conversion: allLeads[0].n ? Math.round(wonLeads[0].n / allLeads[0].n * 100) : 0 },
        byStage,
        target: admin || st.teamTargetVisible ? { team: st.teamTarget, achieved: teamRevenue } : null,
        myTarget: admin ? null : { target: u.monthlyTarget, achieved: leaderboard.find((l) => l.id === u.id)?.premium ?? 0, sold: leaderboard.find((l) => l.id === u.id)?.sold ?? 0 },
        leaderboard: admin ? leaderboard : null,
        today: todayAppts.map((r) => ({ ...r.a, leadName: `${r.firstName} ${r.lastName}`, line: r.line, phone: r.phone, agentName: r.agentName })),
        renewals: renewals.map((r) => ({ ...r.p, customerName: r.customerName })),
        unassigned,
        callsToday: today.get(u.id) ?? 0,
    });
}));
//# sourceMappingURL=dashboard.js.map