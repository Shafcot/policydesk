import { eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { customers, leads, notes } from '../src/db/schema.js';
import { ADMIN, MAYA, as, freshPhone } from './helpers.js';

describe('deleting leads', () => {
  it('lets the Super Admin delete leads with their history', async () => {
    const a = await as(ADMIN);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await a.post('/api/leads', { firstName: 'Del', lastName: `Me${i}`, phone: freshPhone(), line: 'Auto', source: 'Referral' })).body.id);
    await a.post(`/api/leads/${ids[0]}/notes`, { body: 'a note' });
    const r = await a.post('/api/leads/delete', { ids });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(2);
    expect(await db.select().from(leads).where(eq(leads.id, ids[0]))).toHaveLength(0);
    expect(await db.select().from(notes).where(eq(notes.leadId, ids[0]))).toHaveLength(0);
    expect((await a.get(`/api/leads/${ids[0]}`)).status).toBe(404);
  });

  it('keeps the customer and policies when a won lead is deleted', async () => {
    const cust = await db.query.customers.findFirst({ where: isNotNull(customers.leadId) });
    const r = await (await as(ADMIN)).post('/api/leads/delete', { ids: [cust!.leadId!] });
    expect(r.body.deleted).toBe(1);
    const after = await db.query.customers.findFirst({ where: eq(customers.id, cust!.id) });
    expect(after).toBeTruthy();
    expect(after!.leadId).toBeNull();
  });

  it('does not let agents delete leads', async () => {
    const mine = (await (await as(MAYA)).get('/api/leads')).body[0];
    expect((await (await as(MAYA)).post('/api/leads/delete', { ids: [mine.id] })).status).toBe(403);
    expect(await db.select().from(leads).where(eq(leads.id, mine.id))).toHaveLength(1);
  });
});
