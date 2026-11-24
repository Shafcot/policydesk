// Two-way AI texting (client feedback): when a lead texts or emails back, the AI keeps the conversation going
// and books them into their agent's calendar. It hands over to the agent when the lead asks for a person,
// wants a quote it can't give, after a set number of AI messages, or as soon as an agent replies by hand.
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, leads, messages, users } from '../db/schema.js';
import { cfg, enabled } from '../integrations/settings.js';
import { openai } from '../integrations/providers.js';
import { bookLead, freeSlots } from './booking.js';
import { queueMessage } from './messaging.js';
import { emitLead } from './realtime.js';
import { getSettings, notify } from './rules.js';
/** The model call; tests replace it. */
export const aiChat = { complete: async (args) => (await openai().chat.completions.create({ ...args, stream: false })) };
const TOOLS = [
    { type: 'function', function: { name: 'book_appointment', description: 'Book the lead into one of the offered free slots once they have clearly agreed to a specific time.', parameters: { type: 'object', properties: { slot: { type: 'string', description: 'The exact ISO time of one offered slot' } }, required: ['slot'] } } },
    { type: 'function', function: { name: 'hand_off', description: 'Pass the conversation to the human agent: the lead asks for a person, asks for prices/coverage advice, is upset, or the conversation is going nowhere.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
];
/** Whether the AI should answer this lead now. */
async function shouldReply(lead) {
    if (!enabled.ai() || lead.optOut || ['won', 'lost'].includes(lead.stage))
        return false;
    if (lead.aiStatus && lead.aiStatus !== 'active')
        return false; // booked, handed off or stopped
    const st = await getSettings(lead.agencyId);
    if (!st.aiConversations || lead.aiTurns >= st.aiMaxTurns)
        return false;
    // An agent replied by hand in the last 3 days → they own the conversation.
    const human = await db.query.messages.findFirst({ where: and(eq(messages.leadId, lead.id), eq(messages.direction, 'out'), isNotNull(messages.userId), gt(messages.createdAt, new Date(Date.now() - 3 * 864e5))) });
    return !human;
}
const fmt = (iso, tz) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz });
/** Answers the lead's latest message on the same channel. Returns what it did (for tests and the activity log). */
export async function aiConverse(leadId, channel) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    if (!lead || !(await shouldReply(lead)))
        return { action: 'skipped' };
    const st = await getSettings(lead.agencyId);
    const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, lead.agencyId) });
    const agent = (lead.agentId ? await db.query.users.findFirst({ where: eq(users.id, lead.agentId) }) : undefined)
        ?? (await db.query.users.findFirst({ where: and(eq(users.agencyId, lead.agencyId), eq(users.role, 'admin')) }));
    if (!agent)
        return { action: 'skipped' };
    const days = await freeSlots(agent, st.timezone, 7);
    // Offer a spread of times: up to 3 per day over the next days, 12 in total.
    const offer = days.flatMap((d) => [d.slots[0], d.slots[Math.floor(d.slots.length / 2)], d.slots.at(-1)].filter((v, i, a) => v && a.indexOf(v) === i)).slice(0, 12);
    const history = (await db.select().from(messages).where(eq(messages.leadId, lead.id)).orderBy(desc(messages.createdAt)).limit(16)).reverse();
    const system = [
        `You are the scheduling assistant for ${agency?.name ?? 'an insurance agency'}, texting on behalf of agent ${agent.name.split(' ')[0]}.`,
        `The lead, ${lead.firstName}, asked about ${lead.line} insurance. Your goal: answer briefly and friendly, ask at most one of these screening questions if still unknown (${st.screeningQuestions.join(' | ')}), and book a 30-minute call with ${agent.name.split(' ')[0]}.`,
        `Never quote prices, coverage or eligibility. Never invent times. Offer only these free times (agency time zone ${st.timezone}): ${offer.map((s) => `${fmt(s, st.timezone)} [${s}]`).join('; ') || 'none available'}.`,
        'When the lead clearly picks one of those times, call book_appointment with its exact ISO value. If they want a person, prices, or are upset, call hand_off.',
        channel === 'sms' ? 'Reply as one SMS under 300 characters. No emojis.' : 'Reply as a short plain-text email body (no subject, no signature beyond the agent first name).',
    ].join('\n');
    const convo = history.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body.slice(0, 1500) }));
    const r = await aiChat.complete({ model: cfg.openai().chatModel, temperature: 0.3, max_tokens: 300, tools: TOOLS, messages: [{ role: 'system', content: system }, ...convo] });
    const msg = r.choices[0]?.message;
    const call = msg?.tool_calls?.[0];
    const send = async (body) => { await queueMessage(db, { kind: 'lead', id: lead.id }, { channel, body, subject: channel === 'email' ? `Re: your ${lead.line} quote` : null, automated: true }); emitLead(lead.agencyId, lead.agentId, 'message:new', { leadId: lead.id }); };
    if (call?.function.name === 'book_appointment') {
        const slot = String(JSON.parse(call.function.arguments || '{}').slot ?? '');
        if (offer.includes(slot) && (await freeSlots(agent, st.timezone, 7)).some((d) => d.slots.includes(slot))) {
            const { when } = await db.transaction((tx) => bookLead(tx, { lead, agent, slot: new Date(slot), tz: st.timezone, via: 'by AI text conversation' }));
            await db.update(leads).set({ aiStatus: 'booked', aiTurns: lead.aiTurns + 1 }).where(eq(leads.id, lead.id));
            const text = `You're booked! ${agent.name.split(' ')[0]} from ${agency?.name ?? 'our agency'} will call you ${when}. Reply here if you need to change it.`;
            await send(text);
            return { action: 'booked', text };
        }
        // The time was taken meanwhile: fall through to a normal reply asking to pick again.
    }
    if (call?.function.name === 'hand_off') {
        const reason = String(JSON.parse(call.function.arguments || '{}').reason ?? 'needs a person');
        await db.update(leads).set({ aiStatus: 'handoff', aiTurns: lead.aiTurns + 1 }).where(eq(leads.id, lead.id));
        const text = `Thanks ${lead.firstName}! ${agent.name.split(' ')[0]} will get back to you personally very soon.`;
        await send(text);
        await notify(db, { agencyId: lead.agencyId, userId: agent.id, kind: 'reply', text: `AI handed ${lead.firstName} ${lead.lastName} to you: ${reason}`, leadId: lead.id });
        return { action: 'handoff', text };
    }
    const text = (msg?.content ?? '').trim() || (offer.length ? `Thanks ${lead.firstName}! Would ${fmt(offer[0], st.timezone)} work for a quick call with ${agent.name.split(' ')[0]}?` : '');
    if (!text)
        return { action: 'skipped' };
    const turns = lead.aiTurns + 1;
    await db.update(leads).set({ aiStatus: turns >= st.aiMaxTurns ? 'handoff' : 'active', aiTurns: turns }).where(eq(leads.id, lead.id));
    await send(text);
    if (turns >= st.aiMaxTurns)
        await notify(db, { agencyId: lead.agencyId, userId: agent.id, kind: 'reply', text: `${lead.firstName} ${lead.lastName} is still texting after ${turns} AI replies. Please take over.`, leadId: lead.id });
    return { action: 'replied', text };
}
//# sourceMappingURL=aichat.js.map