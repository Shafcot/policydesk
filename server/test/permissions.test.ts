import { and, eq, ne } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { leads, users } from '../src/db/schema.js';
import { ADMIN, DANIEL, MAYA, as } from './helpers.js';

const userId = async (email: string) => (await db.query.users.findFirst({ where: eq(users.email, email) }))!.id;

describe('permissions', () => {
  it('agents only see their own leads; admins see the whole agency', async () => {
    const maya = await userId(MAYA);
    const mine = await (await as(MAYA)).get('/api/leads');
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBeGreaterThan(0);
    expect(mine.body.every((l: { agentId: string }) => l.agentId === maya)).toBe(true);

    const all = await (await as(ADMIN)).get('/api/leads?limit=500');
    expect(all.body.length).toBeGreaterThan(mine.body.length);
  });

  it("returns 404 for another agent's lead (no existence leak)", async () => {
    const daniel = await userId(DANIEL);
    const other = await db.query.leads.findFirst({ where: eq(leads.agentId, daniel) });
    const r = await (await as(MAYA)).get(`/api/leads/${other!.id}`);
    expect(r.status).toBe(404);
  });

  it("won't let an agent log a call on someone else's lead", async () => {
    const maya = await userId(MAYA);
    const other = await db.query.leads.findFirst({ where: and(ne(leads.agentId, maya)) });
    const r = await (await as(MAYA)).post(`/api/leads/${other!.id}/calls`, { result: 'no_answer', durationSec: 10 });
    expect([403, 404]).toContain(r.status);
  });

  it('keeps admin routes away from agents', async () => {
    const a = await as(MAYA);
    expect((await a.get('/api/admin/settings')).status).toBe(403);
    expect((await a.get('/api/automations')).status).toBe(403);
    expect((await a.post('/api/admin/users/invite', { name: 'X', email: 'x@example.com', role: 'admin' })).status).toBe(403);
  });

  it('hides lead-source webhook keys from agents', async () => {
    const r = await (await as(MAYA)).get('/api/meta/lookups');
    expect(JSON.stringify(r.body)).not.toMatch(/webhookKey"\s*:\s*"[a-f0-9]/);
  });
});
