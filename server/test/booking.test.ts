import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, freshPhone } from './helpers.js';

describe('public booking page', () => {
  it('lists free slots, books one, and refuses to double-book it', async () => {
    const page = await request(app).get('/api/public/book/maya');
    expect(page.status).toBe(200);
    expect(page.body.agency).toBeTruthy();
    const day = page.body.days.find((d: { slots: string[] }) => d.slots.length);
    expect(day).toBeTruthy();
    const slot = day.slots[0];
    const booking = { firstName: 'Book', lastName: 'Test', phone: freshPhone(), email: '', line: 'Auto', slot };
    const first = await request(app).post('/api/public/book/maya').send(booking);
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/public/book/maya').send({ ...booking, phone: freshPhone() });
    expect(second.status).toBe(400);
    const after = await request(app).get('/api/public/book/maya');
    expect(after.body.days.flatMap((d: { slots: string[] }) => d.slots)).not.toContain(slot);
  });

  it('returns 404 for an unknown booking link', async () => {
    expect((await request(app).get('/api/public/book/no-such-agent')).status).toBe(404);
  });
});
