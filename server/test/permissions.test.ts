import { and, eq, ne } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { leads, users } from '../src/db/schema.js';
import request from 'supertest';
import { ADMIN, DANIEL, MAYA, app, as } from './helpers.js';

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

describe('removing and re-inviting a user', () => {
  it('brings the same user back with a fresh invite; the old password stops working', async () => {
    const a = await as(ADMIN);
    const email = `returning${Date.now()}@example.com`;
    const first = await a.post('/api/admin/users/invite', { name: 'Returning Agent', email, role: 'agent' });
    expect(first.status).toBe(201);
    const id = first.body.user.id;
    const token1 = new URL(first.body.inviteLink).searchParams.get('token');
    expect((await request(app).post('/api/auth/accept-invite').send({ token: token1, password: 'FirstPass123' })).status).toBe(200);

    expect((await a.delete(`/api/admin/users/${id}`)).status).toBe(200);
    expect((await a.get('/api/users')).body.some((u: { id: string }) => u.id === id)).toBe(false);

    // Inviting the same email again (any case) works and reuses the same record, so history stays linked.
    const again = await a.post('/api/admin/users/invite', { name: 'Returning Agent', email: email.toUpperCase(), role: 'agent' });
    expect(again.status).toBe(201);
    expect(again.body.user.id).toBe(id);
    expect(again.body.user.active).toBe(true);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'FirstPass123' })).status).toBe(401);
    const token2 = new URL(again.body.inviteLink).searchParams.get('token');
    expect((await request(app).post('/api/auth/accept-invite').send({ token: token2, password: 'SecondPass123' })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'SecondPass123' })).status).toBe(200);
    expect((await a.get('/api/users')).body.some((u: { id: string }) => u.id === id)).toBe(true);

    // An active user's email is still refused.
    expect((await a.post('/api/admin/users/invite', { name: 'Dup', email, role: 'agent' })).status).toBe(400);
  });
});

describe('editing a user', () => {
  it('lets the Super Admin correct a sign-in email, but not to one already in use', async () => {
    const a = await as(ADMIN);
    const inv = await a.post('/api/admin/users/invite', { name: 'Typo Person', email: `typo-${Date.now()}@exmaple.com`, role: 'agent', lines: ['Auto'] });
    const id = inv.body.user.id;
    const fixed = `fixed-${Date.now()}@example.com`;
    const r = await a.patch(`/api/admin/users/${id}`, { email: ` ${fixed.toUpperCase()} ` });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(fixed);
    expect((await a.patch(`/api/admin/users/${id}`, { email: ADMIN })).status).toBe(400);
  });
});
