import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { leadSources, leads } from '../src/db/schema.js';
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
