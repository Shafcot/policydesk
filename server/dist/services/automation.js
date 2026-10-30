// Automation engine (SOW 4): triggers enrol leads into flows; the worker walks each run's steps.
// A run waits by setting nextRunAt; stop conditions (reply, booking, won/lost, opt-out) end it early.
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { automationRuns, automations, leads, messages, tasks, templates, users } from '../db/schema.js';
import { STAGE_LABELS, UNIT_MS } from '../domain.js';
import { nextBusinessTime, isBusinessTime } from './hours.js';
import { contactFor, fill, queueMessage, varsFor } from './messaging.js';
import { getSettings, notify, pickAgent, setStage } from './rules.js';
import { emitLead } from './realtime.js';
import { enabled } from '../integrations/settings.js';
import { aiSpeedToLead } from '../integrations/providers.js';
/** Enrols the lead/customer into every active automation listening for this trigger. */
export async function fire(x, trigger, ctx) {
    const list = await x.query.automations.findMany({ where: and(eq(automations.agencyId, ctx.agencyId), eq(automations.trigger, trigger), eq(automations.active, true)) });
    const started = [];
    for (const a of list) {
        const cfg = a.triggerConfig;
        if (trigger === 'stage_change' && cfg.stages?.length && (!ctx.stage || !cfg.stages.includes(ctx.stage)))
            continue;
        if (trigger === 'call_result' && cfg.results?.length && (!ctx.result || !cfg.results.includes(ctx.result)))
            continue;
        if (trigger === 'renewal_date' && cfg.daysBefore?.length && (ctx.daysBefore === undefined || !cfg.daysBefore.includes(ctx.daysBefore)))
            continue;
        // Never enrol the same contact twice in a flow that is still running.
        const dup = await x.query.automationRuns.findFirst({ where: and(eq(automationRuns.automationId, a.id), eq(automationRuns.status, 'active'), ctx.leadId ? eq(automationRuns.leadId, ctx.leadId) : ctx.policyId ? eq(automationRuns.policyId, ctx.policyId) : eq(automationRuns.customerId, ctx.customerId ?? '')) });
        if (dup)
            continue;
        await x.insert(automationRuns).values({ automationId: a.id, leadId: ctx.leadId ?? null, customerId: ctx.customerId ?? null, policyId: ctx.policyId ?? null, nextRunAt: new Date(), log: [{ at: new Date().toISOString(), text: `Started by trigger: ${trigger.replace('_', ' ')}` }] });
        started.push(a.name);
    }
    if (ctx.leadId && started.length)
        await x.update(leads).set({ automation: started.at(-1) }).where(eq(leads.id, ctx.leadId));
    return started;
}
const FLAG = { reply: 'stopOnReply', booking: 'stopOnBooking', won_lost: 'stopOnWonLost', opt_out: null, manual: null };
/** Stops a lead's active runs whose automation is set to stop on this event (opt-out and manual stop all). */
export async function stopRuns(x, leadId, reason) {
    const active = await x.select({ run: automationRuns, a: automations }).from(automationRuns)
        .innerJoin(automations, eq(automationRuns.automationId, automations.id))
        .where(and(eq(automationRuns.leadId, leadId), eq(automationRuns.status, 'active')));
    const flag = FLAG[reason];
    const toStop = active.filter((r) => !flag || r.a[flag]);
    if (toStop.length) {
        await x.update(automationRuns).set({ status: 'stopped', stopReason: reason, updatedAt: new Date() }).where(inArray(automationRuns.id, toStop.map((r) => r.run.id)));
    }
    const remaining = active.filter((r) => !toStop.includes(r));
    await x.update(leads).set({ automation: remaining.at(-1)?.a.name ?? null }).where(eq(leads.id, leadId));
    return toStop.length;
}
const sendsMessage = (s) => s.type === 'action' && ['send_sms', 'send_email', 'send_booking_link', 'send_review_request', 'ai_reply'].includes(s.action);
async function evaluate(x, run, c) {
    const lead = run.leadId ? await x.query.leads.findFirst({ where: eq(leads.id, run.leadId) }) : null;
    switch (c) {
        case 'no_agent_available': {
            if (!lead)
                return false;
            if (!lead.agentId)
                return true;
            const a = await x.query.users.findFirst({ where: eq(users.id, lead.agentId) });
            return !a || a.status !== 'available';
        }
        case 'not_replied': {
            if (!run.leadId)
                return true;
            const reply = await x.query.messages.findFirst({ where: and(eq(messages.leadId, run.leadId), eq(messages.direction, 'in'), gt(messages.createdAt, run.createdAt)) });
            return !reply;
        }
        case 'is_commercial': return lead?.type === 'commercial';
        case 'is_personal': return lead?.type === 'personal';
    }
}
const DEFAULT_TEXT = {
    send_sms: { channel: 'sms', body: 'Hi {first}, this is {agent} from {agency}. Do you have a minute to talk about your {line} quote?' },
    send_email: { channel: 'email', subject: 'Your {line} quote', body: 'Hi {first},\n\nI wanted to follow up on your {line} quote. Reply here or book a time: {booking}\n\n{agent}\n{agency}' },
    send_booking_link: { channel: 'sms', body: 'Hi {first}, pick a time that works for you here: {booking}' },
    send_review_request: { channel: 'sms', body: 'Thanks for choosing {agency}, {first}! Would you leave us a quick review? Google: {google} · Facebook: {facebook} · Yelp: {yelp}' },
    ai_reply: { channel: 'sms', body: 'Hi {first}, thanks for reaching out to {agency}! A few quick questions so we can quote you fast: 1) What’s your ZIP? 2) Who insures you now? 3) When does your policy renew? Or grab a time here: {booking}' },
};
/** Runs one action step. Returns a short log line. */
async function act(x, run, a, s) {
    const r = run.leadId ? { kind: 'lead', id: run.leadId } : run.customerId ? { kind: 'customer', id: run.customerId } : null;
    if (!r)
        return 'No contact on this run';
    const contact = await contactFor(x, r);
    if (!contact)
        return 'Contact no longer exists';
    const lead = run.leadId ? await x.query.leads.findFirst({ where: eq(leads.id, run.leadId) }) : null;
    switch (s.action) {
        case 'send_sms':
        case 'send_email':
        case 'send_booking_link':
        case 'send_review_request':
        case 'ai_reply': {
            const tpl = s.templateId ? await x.query.templates.findFirst({ where: eq(templates.id, s.templateId) }) : null;
            const def = DEFAULT_TEXT[s.action];
            const channel = tpl?.channel ?? def.channel;
            const v = await varsFor(x, contact);
            let body = fill(tpl?.body ?? def.body, v);
            if (s.action === 'ai_reply' && !tpl && enabled.ai()) {
                // Personalised first reply with the agency's screening questions; falls back to the template text on any error.
                const st = await getSettings(contact.agencyId, x);
                body = (await aiSpeedToLead({ first: contact.first, agency: v.agency, line: contact.line, questions: st.screeningQuestions, booking: v.booking }).catch(() => '')) || body;
            }
            const m = await queueMessage(x, r, { channel, body, subject: fill(tpl?.subject ?? def.subject ?? '', v), automated: true });
            return m ? `Queued ${channel.toUpperCase()}: ${tpl?.name ?? s.action.replace(/_/g, ' ')}` : `Skipped ${channel.toUpperCase()} (opted out or no ${channel === 'sms' ? 'phone' : 'email'})`;
        }
        case 'create_task': {
            const title = s.text?.trim() || `${a.name}: follow up with ${contact.name}`;
            await x.insert(tasks).values({ agencyId: contact.agencyId, userId: contact.agentId, leadId: run.leadId, customerId: run.customerId, title });
            await notify(x, { agencyId: contact.agencyId, userId: contact.agentId, kind: 'task', text: `New task: ${title}`, leadId: run.leadId });
            return `Task created for ${contact.agentId ? 'the agent' : 'admins'}`;
        }
        case 'change_stage': {
            if (!lead || !s.stage)
                return 'Skipped stage change (no lead or stage)';
            await setStage(x, lead, s.stage, { id: null, name: 'Automation' }, a.name);
            return `Stage → ${STAGE_LABELS[s.stage]}`;
        }
        case 'assign_agent': {
            if (!lead)
                return 'Skipped assign (no lead)';
            if (lead.agentId)
                return 'Already assigned';
            const agent = await pickAgent(lead, x);
            if (!agent)
                return 'No agent available to assign';
            await x.update(leads).set({ agentId: agent.id }).where(eq(leads.id, lead.id));
            await notify(x, { agencyId: lead.agencyId, userId: agent.id, kind: 'lead', text: `New lead assigned to ${agent.name}: ${contact.name}`, leadId: lead.id });
            return `Assigned to ${agent.name}`;
        }
        case 'alert_team': {
            const text = s.text?.trim() || `${a.name}: ${contact.name} needs attention`;
            if (contact.agentId)
                await notify(x, { agencyId: contact.agencyId, userId: contact.agentId, kind: 'warn', text, leadId: run.leadId });
            await notify(x, { agencyId: contact.agencyId, userId: null, kind: 'warn', text, leadId: run.leadId });
            return 'Alerted agent and admins';
        }
    }
}
/** Walks one run forward until it waits, finishes, or is blocked by business hours. */
export async function advanceRun(runId) {
    await db.transaction(async (tx) => {
        const run = await tx.query.automationRuns.findFirst({ where: eq(automationRuns.id, runId) });
        if (!run || run.status !== 'active' || run.nextRunAt > new Date())
            return;
        const a = await tx.query.automations.findFirst({ where: eq(automations.id, run.automationId) });
        if (!a)
            return;
        const log = [...run.log];
        const stamp = (text) => log.push({ at: new Date().toISOString(), text });
        if (!a.active) { // paused: check back in an hour
            await tx.update(automationRuns).set({ nextRunAt: new Date(Date.now() + 36e5), updatedAt: new Date() }).where(eq(automationRuns.id, run.id));
            return;
        }
        const st = await getSettings(a.agencyId, tx);
        let i = run.stepIndex;
        let next = null;
        let status = 'active';
        let stopReason = null;
        while (i < a.steps.length) {
            const s = a.steps[i];
            if (s.type === 'wait') {
                next = new Date(Date.now() + Math.max(0, s.amount) * UNIT_MS[s.unit]);
                i++;
                break;
            }
            if (s.type === 'condition') {
                if (!(await evaluate(tx, run, s.condition))) {
                    status = 'completed';
                    stopReason = `condition not met: ${s.condition.replace(/_/g, ' ')}`;
                    stamp(`Stopped: ${stopReason}`);
                    break;
                }
                stamp(`Condition met: ${s.condition.replace(/_/g, ' ')}`);
                i++;
                continue;
            }
            if (a.businessHoursOnly && sendsMessage(s) && !isBusinessTime(new Date(), st)) {
                next = nextBusinessTime(new Date(), st);
                stamp('Waiting for business hours');
                break;
            }
            stamp(await act(tx, { ...run, stepIndex: i }, a, s));
            i++;
        }
        if (status === 'active' && i >= a.steps.length && !next) {
            status = 'completed';
            stamp('Finished');
        }
        await tx.update(automationRuns).set({ stepIndex: i, status, stopReason, nextRunAt: next ?? new Date(), log: log.slice(-50), updatedAt: new Date() }).where(eq(automationRuns.id, run.id));
        if (status !== 'active' && run.leadId) {
            const still = await tx.select({ name: automations.name }).from(automationRuns).innerJoin(automations, eq(automationRuns.automationId, automations.id))
                .where(and(eq(automationRuns.leadId, run.leadId), eq(automationRuns.status, 'active'))).orderBy(desc(automationRuns.createdAt)).limit(1);
            await tx.update(leads).set({ automation: still[0]?.name ?? null }).where(eq(leads.id, run.leadId));
        }
    });
    const run = await db.query.automationRuns.findFirst({ where: eq(automationRuns.id, runId) });
    if (run?.leadId) {
        const l = await db.query.leads.findFirst({ where: eq(leads.id, run.leadId) });
        if (l)
            emitLead(l.agencyId, l.agentId, 'lead:changed', { id: l.id });
    }
}
/** Processes every run that is due. Called by the worker every few seconds. */
export async function processDueRuns(limit = 100) {
    const due = await db.select({ id: automationRuns.id }).from(automationRuns)
        .where(and(eq(automationRuns.status, 'active'), sql `${automationRuns.nextRunAt} <= now()`)).orderBy(automationRuns.nextRunAt).limit(limit);
    for (const r of due) {
        try {
            await advanceRun(r.id);
        }
        catch (e) {
            console.error('automation run failed', r.id, e);
        }
    }
    return due.length;
}
/** The nine ready-made automations from the SOW, created inactive-safe for a new agency. */
export async function installDefaultAutomations(x, agencyId) {
    const tpl = await x.query.templates.findMany({ where: eq(templates.agencyId, agencyId) });
    const t = (name) => tpl.find((x) => x.name === name)?.id ?? null;
    const flows = [
        { name: 'Welcome email + SMS', trigger: 'new_lead', steps: [{ type: 'wait', amount: 1, unit: 'minutes' }, { type: 'action', action: 'send_sms', templateId: t('Welcome') }, { type: 'action', action: 'send_email', templateId: t('Welcome email') }] },
        { name: 'Speed-to-lead', trigger: 'new_lead', steps: [{ type: 'condition', condition: 'no_agent_available' }, { type: 'action', action: 'ai_reply' }, { type: 'action', action: 'send_booking_link', templateId: t('Booking link') }] },
        { name: 'New-lead drip', trigger: 'new_lead', steps: [{ type: 'wait', amount: 1, unit: 'days' }, { type: 'action', action: 'send_sms', templateId: t('Missed you') }, { type: 'wait', amount: 1, unit: 'days' }, { type: 'action', action: 'send_sms', templateId: t('Quote ready') }, { type: 'wait', amount: 1, unit: 'weeks' }, { type: 'action', action: 'send_email', templateId: t('Quote follow-up') }, { type: 'wait', amount: 1, unit: 'months' }, { type: 'action', action: 'send_email', templateId: t('Quote follow-up') }] },
        { name: 'Missed appointment', trigger: 'missed_appointment', stopOnBooking: true, steps: [{ type: 'action', action: 'send_sms', templateId: t('Rebook missed appointment') }, { type: 'action', action: 'alert_team', text: 'Missed appointment — lead asked to rebook' }] },
        { name: '5-month re-quote', trigger: 'stage_change', triggerConfig: { stages: ['requote'] }, stopOnWonLost: false, steps: [{ type: 'action', action: 'send_sms', templateId: t('Quote ready') }, { type: 'action', action: 'create_task', text: 'Re-quote this lead' }] },
        { name: 'Renewal reminder (customer)', trigger: 'renewal_date', triggerConfig: { daysBefore: [60, 30] }, stopOnWonLost: false, steps: [{ type: 'action', action: 'send_email', templateId: t('Renewal review') }] },
        { name: 'Renewal review (agent)', trigger: 'renewal_date', triggerConfig: { daysBefore: [60, 30] }, stopOnWonLost: false, businessHoursOnly: false, steps: [{ type: 'action', action: 'create_task', text: 'Annual policy review before renewal' }] },
        { name: 'Review request', trigger: 'policy_won', stopOnWonLost: false, steps: [{ type: 'wait', amount: 1, unit: 'days' }, { type: 'action', action: 'send_review_request', templateId: t('Review request') }] },
        { name: 'Quote follow-up', trigger: 'call_result', triggerConfig: { results: ['quoted'] }, steps: [{ type: 'wait', amount: 2, unit: 'days' }, { type: 'condition', condition: 'not_replied' }, { type: 'action', action: 'send_email', templateId: t('Quote follow-up') }] },
    ];
    await x.insert(automations).values(flows.map((f) => ({ active: f.name !== 'Quote follow-up', ...f, agencyId })));
}
//# sourceMappingURL=automation.js.map