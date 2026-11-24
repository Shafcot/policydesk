import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { leadSources, leads, notes } from '../src/db/schema.js';
import { ADMIN, app, as, freshPhone } from './helpers.js';

describe('lead intake', () => {
  it('creates a lead manually and starts the new-lead automations', async () => {
    const a = await as(ADMIN);
    const r = await a.post('/api/leads', { firstName: 'Test', lastName: 'Manual', phone: freshPhone(), email: 'manual@example.com', line: 'Auto', source: 'Referral' });
    expect(r.status).toBe(201);
    const runs = await a.get(`/api/leads/${r.body.id}/runs`);
    expect(runs.status).toBe(200);
    expect(runs.body.some((x: { status: string }) => x.status === 'active' || x.status === 'waiting')).toBe(true);
  });

  it('validates input', async () => {
    const r = await (await as(ADMIN)).post('/api/leads', { firstName: '', lastName: 'X', phone: '1', line: 'Spaceship', source: 'x' });
    expect(r.status).toBe(400);
  });

  it('accepts vendor/website leads on the per-source webhook and ignores duplicates', async () => {
    const src = await db.query.leadSources.findFirst({ where: eq(leadSources.name, 'Website') }) ?? await db.query.leadSources.findFirst();
    const phone = freshPhone();
    const body = { first_name: 'Web', last_name: 'Form', phone, email: 'web@example.com', insurance_type: 'Home' };
    const first = await request(app).post(`/webhooks/leads/${src!.webhookKey}`).send(body);
    expect(first.status).toBe(201);
    const again = await request(app).post(`/webhooks/leads/${src!.webhookKey}`).type('form').send(body);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    const saved = await db.select().from(leads).where(eq(leads.phone, phone));
    expect(saved).toHaveLength(1);
    expect(saved[0].line).toBe('Home');
  });

  it('rejects unknown webhook keys and unsigned provider webhooks', async () => {
    expect((await request(app).post('/webhooks/leads/not-a-real-key').send({ phone: '5125550000' })).status).toBe(404);
    expect((await request(app).post('/webhooks/google-ads').send({ google_key: 'x' })).status).toBe(403);
    expect((await request(app).post('/webhooks/facebook').send({ entry: [] })).status).toBe(403);
    expect((await request(app).post('/webhooks/sendgrid/inbound?key=wrong').field('to', 'x')).status).toBe(403);
  });

  it('imports a spreadsheet and skips phone numbers already in the CRM', async () => {
    const a = await as(ADMIN);
    const existing = await db.query.leads.findFirst();
    const phone = freshPhone();
    const r = await a.post('/api/leads/import', {
      rows: [
        { firstName: 'Imp', lastName: 'One', phone, line: 'Auto', source: 'Import' },
        { firstName: 'Imp', lastName: 'Dup', phone: existing!.phone, line: 'Auto', source: 'Import' },
      ],
      defaultSource: 'Import',
    });
    expect(r.status).toBeLessThan(300);
    expect(r.body.imported).toBe(1);
    expect(r.body.duplicates).toBe(1);
  });
});

describe('import bridge', () => {
  it('serves the bridge page without opener isolation, and bulk import keeps notes, stages and dates', async () => {
    const page = await request(app).get('/import-bridge');
    expect(page.status).toBe(200);
    expect(page.headers['cross-origin-opener-policy']).toBeUndefined();
    expect(page.text).toContain('/import-bridge.js');
    const a = await as(ADMIN);
    const p1 = freshPhone(), p2 = freshPhone();
    const rows = Array.from({ length: 620 }, (_, i) => ({ firstName: `Bulk${i}`, lastName: 'Row', phone: i === 619 ? p1 : freshPhone(), stage: i % 2 ? 'Quoted' : 'new', createdAt: '2024-03-05T10:00:00-06:00', notes: `Old CRM #${i}` }));
    rows.push({ firstName: 'Dup', lastName: 'Row', phone: p1, stage: 'new', createdAt: '2024-03-05T10:00:00-06:00', notes: '' });
    rows.push({ firstName: '', lastName: 'NoName', phone: p2, stage: 'new', createdAt: '', notes: '' });
    const r = await a.post('/api/leads/import', { rows, defaultSource: 'AgencyZoom', autoAssign: false });
    expect(r.body).toMatchObject({ imported: 620, duplicates: 1 });
    expect(r.body.skipped).toHaveLength(1);
    const l0 = await db.query.leads.findFirst({ where: eq(leads.phone, p1) });
    const l = l0 && { ...l0, notes: await db.select().from(notes).where(eq(notes.leadId, l0.id)) };
    expect(l?.stage).toBe('quoted');
    expect(l?.createdAt.toISOString()).toBe('2024-03-05T16:00:00.000Z');
    expect(l?.notes?.[0]?.body).toContain('Old CRM #619');
  });
});

describe('migration extras', () => {
  it('imports leads without a phone when allowed (deduped by email), blocks calling them, and adds history by phone', async () => {
    const a = await as(ADMIN);
    const em = `nophone-${Date.now()}@example.com`;
    const r = await a.post('/api/leads/import', { allowNoPhone: true, autoAssign: false, defaultSource: 'AgencyZoom', rows: [
      { firstName: 'Email', lastName: 'Only', email: em },
      { firstName: 'Email', lastName: 'Again', email: em.toUpperCase() },
      { firstName: 'Nothing', lastName: 'Else' },
    ] });
    expect(r.body).toMatchObject({ imported: 2, duplicates: 1 });
    const l = await db.query.leads.findFirst({ where: eq(leads.email, em) });
    expect(l?.phone).toBe('');
    expect((await a.post(`/api/leads/${l!.id}/lock`)).status).toBe(400);
    const strict = await a.post('/api/leads/import', { defaultSource: 'X', rows: [{ firstName: 'No', lastName: 'Phone', email: 'x@example.com' }] });
    expect(strict.body.imported).toBe(0);

    const phone = freshPhone();
    await a.post('/api/leads/import', { autoAssign: false, defaultSource: 'AgencyZoom', rows: [{ firstName: 'Has', lastName: 'History', phone }] });
    const n = await a.post('/api/leads/notes/bulk', { items: [{ phone, body: 'AgencyZoom history: called twice' }, { phone: '(000) 000-0000', body: 'nobody' }] });
    expect(n.body).toEqual({ added: 1, unmatched: 1 });
    const w0 = await db.query.leads.findFirst({ where: eq(leads.phone, phone) });
    const withNotes = w0 && { ...w0, notes: await db.select().from(notes).where(eq(notes.leadId, w0.id)) };
    expect(withNotes?.notes.some((x) => x.body.includes('called twice'))).toBe(true);
  });
});
