// Client demo-call feedback: AI texting, follow-up cadence, re-contact, form fields, targets and call activity.
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { agencies, appointments, automations, leads, leadSources, messages, notes, users } from '../src/db/schema.js';
import { DEFAULT_SETTINGS } from '../src/domain.js';
import { aiChat, aiConverse } from '../src/services/aichat.js';
import { upgradeAgencyDefaults } from '../src/db/defaults.js';
import { ADMIN, DANIEL, MAYA, app, as, freshPhone } from './helpers.js';

const user = async (email: string) => (await db.query.users.findFirst({ where: eq(users.email, email) }))!;
async function setSettings(patch: Record<string, unknown>) {
  const a = (await db.select().from(agencies))[0];
  await db.update(agencies).set({ settings: { ...DEFAULT_SETTINGS, ...a.settings, ...patch } as never }).where(eq(agencies.id, a.id));
}
async function newLead(email = MAYA) {
  const u = await user(email);
  const [l] = await db.insert(leads).values({ agencyId: u.agencyId, firstName: 'Ai', lastName: 'Tester', phone: freshPhone(), email: 'ai@example.com', line: 'Auto', type: 'personal', source: 'Referral', agentId: u.id }).returning();
  await db.insert(messages).values({ leadId: l.id, channel: 'sms', direction: 'in', body: 'Yes I still need a quote', status: 'received' });
  return l;
}

const realComplete = aiChat.complete;
beforeAll(async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  await setSettings({ aiConversations: true, aiMaxTurns: 3 });
  // Maya works every day 08:00–17:00 so there are always free slots.
  await db.update(users).set({ daysOff: [], hoursStart: '00:00', hoursEnd: '23:30' }).where(eq(users.email, MAYA));
});
afterAll(() => { aiChat.complete = realComplete; delete process.env.OPENAI_API_KEY; });

describe('two-way AI texting', () => {
  it('replies with free times, then books the time the lead picks', async () => {
    const lead = await newLead();
    let offered = '';
    aiChat.complete = async (args) => {
      offered = String((args.messages[0] as { content: string }).content);
      return { choices: [{ message: { content: 'Great! Would Tue at 10am work for a quick call?' } }] };
    };
    const first = await aiConverse(lead.id, 'sms');
    expect(first.action).toBe('replied');
    expect(offered).toMatch(/\[\d{4}-\d{2}-\d{2}T/); // real free slots are in the prompt
    const slot = offered.match(/\[(\d{4}-[^\]]+)\]/)![1];
    aiChat.complete = async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: '1', function: { name: 'book_appointment', arguments: JSON.stringify({ slot }) } }] } }] });
    const second = await aiConverse(lead.id, 'sms');
    expect(second.action).toBe('booked');
    const appt = await db.query.appointments.findFirst({ where: eq(appointments.leadId, lead.id) });
    expect(appt?.startsAt.toISOString()).toBe(slot);
    expect((await db.query.leads.findFirst({ where: eq(leads.id, lead.id) }))!.aiStatus).toBe('booked');
    const out = await db.select().from(messages).where(and(eq(messages.leadId, lead.id), eq(messages.direction, 'out')));
    expect(out.map((m) => m.body).join(' ')).toContain('You\'re booked');
    // once booked, the AI stays out of it
    expect((await aiConverse(lead.id, 'sms')).action).toBe('skipped');
  });

  it('hands off to the agent when asked for a person', async () => {
    const lead = await newLead();
    aiChat.complete = async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: '1', function: { name: 'hand_off', arguments: '{"reason":"wants a price"}' } }] } }] });
    expect((await aiConverse(lead.id, 'sms')).action).toBe('handoff');
    expect((await db.query.leads.findFirst({ where: eq(leads.id, lead.id) }))!.aiStatus).toBe('handoff');
  });

  it('stays quiet once an agent replies by hand, and when switched off', async () => {
    const lead = await newLead();
    aiChat.complete = async () => ({ choices: [{ message: { content: 'hello' } }] });
    await (await as(MAYA)).post(`/api/leads/${lead.id}/messages`, { channel: 'sms', body: 'Hi, it’s Maya. Calling you in 5.' });
    expect((await aiConverse(lead.id, 'sms')).action).toBe('skipped');
    const other = await newLead();
    await setSettings({ aiConversations: false });
    expect((await aiConverse(other.id, 'sms')).action).toBe('skipped');
    await setSettings({ aiConversations: true });
  });

  it('hands over after the maximum number of AI replies', async () => {
    const lead = await newLead();
    aiChat.complete = async () => ({ choices: [{ message: { content: 'Which day suits you?' } }] });
    for (let i = 0; i < 3; i++) await aiConverse(lead.id, 'sms');
    expect((await db.query.leads.findFirst({ where: eq(leads.id, lead.id) }))!.aiStatus).toBe('handoff');
    expect((await aiConverse(lead.id, 'sms')).action).toBe('skipped');
  });
});

describe('follow-up cadence', () => {
  it('new agencies get the cadence and re-contact flows; existing ones are upgraded once', async () => {
    const a = (await db.select().from(agencies))[0];
    const cadence = await db.query.automations.findFirst({ where: and(eq(automations.agencyId, a.id), eq(automations.name, 'New-lead follow-up cadence')) });
    expect(cadence?.trigger).toBe('new_lead');
    const steps = cadence!.steps;
    // day 1: +1h text, +1h email; every message is guarded by "not reached yet"
    expect(steps[0]).toEqual({ type: 'wait', amount: 1, unit: 'hours' });
    expect(steps[1]).toEqual({ type: 'condition', condition: 'not_reached' });
    expect(steps[2]).toMatchObject({ type: 'action', action: 'send_sms' });
    expect(steps.filter((s) => s.type === 'wait' && s.unit === 'months').length).toBeGreaterThanOrEqual(6);
    expect(steps.filter((s) => s.type === 'action').every((s) => s.type === 'action' && s.templateId)).toBe(true);
    const recontact = await db.query.automations.findFirst({ where: and(eq(automations.agencyId, a.id), eq(automations.trigger, 'inactive')) });
    expect(recontact?.triggerConfig.days).toBe(45);
    // the upgrade is a no-op when the flows exist
    const before = (await db.select().from(automations)).length;
    await upgradeAgencyDefaults();
    expect((await db.select().from(automations)).length).toBe(before);
  });

  it('enrols a new lead in the cadence', async () => {
    const r = await (await as(ADMIN)).post('/api/leads', { firstName: 'Cad', lastName: 'Ence', phone: freshPhone(), line: 'Home', source: 'Referral' });
    const runs = (await (await as(ADMIN)).get(`/api/leads/${r.body.id}/runs`)).body;
    expect(runs.map((x: { name: string }) => x.name)).toContain('New-lead follow-up cadence');
  });
});

describe('lead form fields', () => {
  it('fills custom fields from extra form questions and keeps the rest as a note', async () => {
    const src = (await db.select().from(leadSources))[0];
    const phone = freshPhone();
    const r = await request(app).post(`/webhooks/leads/${src.webhookKey}`).send({ full_name: 'Form Filler', phone, insurance_type: 'Auto', date_of_birth: '1985-04-02', 'Current Carrier': 'Geico', how_many_vehicles: '2' });
    expect(r.status).toBe(201);
    const lead = (await db.select().from(leads).where(eq(leads.phone, phone)))[0];
    expect(lead.custom).toMatchObject({ dob: '1985-04-02', carrier: 'Geico' });
    const n = await db.select().from(notes).where(eq(notes.leadId, lead.id));
    expect(n.map((x) => x.body).join('\n')).toContain('how many vehicles: 2');
  });
});

describe('targets and activity', () => {
  it('shows the target month, team target to agents, and time on calls', async () => {
    await setSettings({ targetStartDay: 20, agentTargetsVisible: false });
    const m = await as(MAYA);
    const d = (await m.get('/api/dashboard')).body;
    expect(d.target).toBeTruthy(); // agents always see the team target
    expect(d.period.label).toMatch(/^[A-Z][a-z]{2} 20 – [A-Z][a-z]{2} 19$/);
    expect(d.myActivity).toMatchObject({ talkToday: expect.any(Number), talkWeek: expect.any(Number), talkMonth: expect.any(Number) });
    const admin = (await (await as(ADMIN)).get('/api/dashboard')).body;
    expect(admin.activity.length).toBeGreaterThan(0);
    expect(admin.activity[0]).toHaveProperty('leadsToday');
    // other agents' targets are hidden from agents unless switched on
    const mine = (await m.get('/api/targets')).body;
    expect(mine.agents.map((a: { name: string }) => a.name)).toEqual([(await user(MAYA)).name]);
    await setSettings({ agentTargetsVisible: true });
    expect((await m.get('/api/targets')).body.agents.length).toBeGreaterThan(1);
    await setSettings({ targetStartDay: 1, agentTargetsVisible: false });
    void DANIEL;
  });

  it('saves the new settings and validates the phone menu', async () => {
    const a = await as(ADMIN);
    const maya = await user(MAYA);
    const ok = await a.patch('/api/admin/settings', { settings: {
      targetStartDay: 20, carriers: ['Progressive', 'Travelers', 'Progressive'],
      callScripts: { '*': { opening: 'Hi {first}', objections: [{ q: 'Too pricey', a: 'Let’s look at discounts' }] }, Home: { opening: 'Home script', objections: [] } },
      phoneMenu: { enabled: true, mainNumber: '(512) 555-0100', greeting: 'Hi', options: [{ digit: '1', label: 'Sales', userIds: [maya.id] }], defaultUserIds: [], afterHoursMessage: 'Closed' },
    } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.carriers).toEqual(['Progressive', 'Travelers']);
    expect(ok.body.settings.phoneMenu.mainNumber).toBe('+15125550100');
    const pub = (await (await as(MAYA)).get('/api/settings/public')).body;
    expect(pub.callScripts.Home.opening).toBe('Home script');
    expect(pub.carriers).toEqual(['Progressive', 'Travelers']);
    const bad = await a.patch('/api/admin/settings', { settings: { phoneMenu: { enabled: true, mainNumber: '', greeting: '', options: [{ digit: '1', label: 'A', userIds: [] }, { digit: '1', label: 'B', userIds: [] }], defaultUserIds: [], afterHoursMessage: '' } } });
    expect(bad.status).toBe(400);
    await a.patch('/api/admin/settings', { settings: { targetStartDay: 1, carriers: [], phoneMenu: DEFAULT_SETTINGS.phoneMenu } });
  });
});

describe('Outlook calendar sync', () => {
  it('writes appointments to the user’s Outlook calendar and blocks Outlook busy times', async () => {
    const { syncOutlook } = await import('../src/integrations/outlook.js');
    const { freeSlots } = await import('../src/services/booking.js');
    process.env.MS_TENANT_ID = 'tenant'; process.env.MS_CLIENT_ID = 'client'; process.env.MS_CLIENT_SECRET = 'secret';
    const calls: { url: string; method: string; body?: string }[] = [];
    const realFetch = globalThis.fetch;
    const maya = await user(MAYA);
    const slots = await freeSlots(maya, 'America/Chicago', 3);
    const blocked = slots[0].slots[0];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined });
      if (String(url).includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      if (String(url).includes('/calendarView')) return new Response(JSON.stringify({ value: [{ start: { dateTime: blocked.replace('Z', '') }, end: { dateTime: new Date(new Date(blocked).getTime() + 30 * 60_000).toISOString().replace('Z', '') }, showAs: 'busy', isCancelled: false }] }), { status: 200 });
      if (String(url).endsWith('/events') && init?.method === 'POST') return new Response(JSON.stringify({ id: 'EVT1' }), { status: 201 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const after = await freeSlots(maya, 'America/Chicago', 3);
      expect(after.flatMap((d) => d.slots)).not.toContain(blocked);
      const lead = await newLead();
      const [appt] = await db.insert(appointments).values({ leadId: lead.id, userId: maya.id, startsAt: new Date(Date.now() + 2 * 864e5), durationMin: 30, type: 'Discovery call' }).returning();
      await syncOutlook(1000);
      const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/events') && JSON.parse(c.body!).subject.includes('Ai Tester') && c.url.includes(encodeURIComponent(maya.email)));
      expect(create).toBeTruthy();
      expect((await db.query.appointments.findFirst({ where: eq(appointments.id, appt.id) }))!.outlookEventId).toBe('EVT1');
      // cancelling deletes the Outlook event
      await db.update(appointments).set({ status: 'cancelled', updatedAt: new Date(Date.now() + 1000) }).where(eq(appointments.id, appt.id));
      await syncOutlook(1000);
      expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/events/EVT1'))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.MS_TENANT_ID; delete process.env.MS_CLIENT_ID; delete process.env.MS_CLIENT_SECRET;
    }
  });
});
