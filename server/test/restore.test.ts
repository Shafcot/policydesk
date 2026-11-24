// Restore endpoint: off without RESTORE_KEY, needs the exact key, refuses a database that already has data.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './helpers.js';

describe('restore', () => {
  it('is hidden without RESTORE_KEY and locked to the key and an empty install', async () => {
    delete process.env.RESTORE_KEY;
    expect((await request(app).post('/api/restore/begin')).status).toBe(404);
    process.env.RESTORE_KEY = 'k'.repeat(32);
    expect((await request(app).post('/api/restore/begin').set('x-restore-key', 'x'.repeat(32))).status).toBe(403);
    const r = await request(app).post('/api/restore/begin').set('x-restore-key', 'k'.repeat(32));
    expect(r.status).toBe(400); // the test database already has the demo agency
    expect(r.body.error).toMatch(/empty/);
    delete process.env.RESTORE_KEY;
  });
});
