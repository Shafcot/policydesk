// Bad leads (client request): bad number, unreachable, Do Not Solicit, Do Not Call — marking, blocking, filter and report.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { automationRuns, automations, leads, users } from '../src/db/schema.js';
import { fire } from '../src/services/automation.js';
import { isDeadNumber } from '../src/services/badleads.js';
import { ADMIN, MAYA, as, freshPhone } from './helpers.js';

const user = async (email: string) => (await db.query.users.findFirst({ where: eq(users.email, email) }))!;
async function newLead(source = 'BadVendor') {
  const u = await user(MAYA);
  const [l] = await db.insert(leads).values({ agencyId: u.agencyId, firstName: 'Bad', lastName: 'Lead', phone: freshPhone(), line: 'Auto', type: 'personal', source, agentId: u.id }).returning();
  return l;
}
const get = async (id: string) => (await db.query.leads.findFirst({ where: eq(leads.id, id) }))!;

describe('bad leads', () => {
  it('agent marks DNC: opted out, calling blocked, out of the queue, no automations; only admin clears it', async () => {
    const lead = await newLead();
    const maya = await as(MAYA);
    const r = await maya.patch(`/api/leads/${lead.id}`, { badReason: 'dnc' });
    expect(r.status).toBe(200);
    const l = await get(lead.id);
    expect(l.badReason).toBe('dnc');
    expect(l.optOut).toBe(true);
    expect(l.badById).toBe((await user(MAYA)).id);
    expect((await maya.post(`/api/leads/${lead.id}/lock`)).status).toBe(403);
    const q = await maya.get('/api/leads/queue/mine');
    expect(q.body.some((x: { lead: { id: string } }) => x.lead.id === lead.id)).toBe(false);
    const a = await db.query.automations.findFirst({ where: eq(automations.trigger, 'new_lead') });
    if (a) {
      await fire(db, 'new_lead', { agencyId: l.agencyId, leadId: l.id });
      expect(await db.query.automationRuns.findFirst({ where: eq(automationRuns.leadId, l.id) })).toBeUndefined();
    }
    expect((await maya.patch(`/api/leads/${lead.id}`, { badReason: null })).status).toBe(403);
    expect((await (await as(ADMIN)).patch(`/api/leads/${lead.id}`, { badReason: null })).status).toBe(200);
    expect((await get(lead.id)).badReason).toBeNull();
  });

  it('flags Unreachable after the maximum unanswered attempts', async () => {
    const lead = await newLead();
    await db.update(leads).set({ attempts: 7 }).where(eq(leads.id, lead.id));
    const r = await (await as(MAYA)).post(`/api/leads/${lead.id}/calls`, { result: 'no_answer' });
    expect(r.status).toBe(201);
    const l = await get(lead.id);
    expect(l.badReason).toBe('unreachable');
    expect(l.badById).toBeNull();
    expect(l.optOut).toBe(false);
  });

  it('recognises carrier "number not in service" failures only', () => {
    expect(isDeadNumber({ SipResponseCode: '404' })).toBe(true);
    expect(isDeadNumber({ ErrorCode: '21211' })).toBe(true);
    expect(isDeadNumber({ SipResponseCode: '486' })).toBe(false); // busy
  });

  it('filters the leads list and reports by reason, vendor and agent (admin only)', async () => {
    const admin = await as(ADMIN);
    const a = await newLead('VendorX'), b = await newLead('VendorX'), c = await newLead('VendorX');
    await admin.post('/api/leads/bulk', { ids: [a.id, b.id], badReason: 'bad_number' });
    await admin.patch(`/api/leads/${c.id}`, { badReason: 'dns' });
    const list = await admin.get('/api/leads?bad=bad_number&source=VendorX');
    expect(list.body.map((x: { id: string }) => x.id).sort()).toEqual([a.id, b.id].sort());
    const hidden = await admin.get('/api/leads?bad=none&source=VendorX');
    expect(hidden.body).toHaveLength(0);
    const rep = await admin.get('/api/admin/bad-leads?days=30');
    expect(rep.status).toBe(200);
    expect(rep.body.counts.bad_number).toBeGreaterThanOrEqual(2);
    const vx = rep.body.bySource.find((s: { source: string }) => s.source === 'VendorX');
    expect(vx).toMatchObject({ bad: 3, leads: 3, counts: { bad_number: 2, dns: 1 } });
    expect(rep.body.byAgent.some((g: { agentName: string }) => g.agentName)).toBe(true);
    expect(rep.body.leads.find((x: { id: string }) => x.id === c.id).markedBy).toBeTruthy();
    expect((await (await as(MAYA)).get('/api/admin/bad-leads')).status).toBe(403);
  });
});
