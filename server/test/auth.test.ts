import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ADMIN, MAYA, PASSWORD, app, as } from './helpers.js';

describe('auth', () => {
  it('reports health', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: MAYA, password: 'nope-nope' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('bad_credentials');
  });

  it('signs in and returns the user without the password hash', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: ADMIN.toUpperCase(), password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.user.role).toBe('admin');
    expect(JSON.stringify(r.body)).not.toContain('passwordHash');
  });

  it('blocks the API without a token', async () => {
    expect((await request(app).get('/api/leads')).status).toBe(401);
    expect((await request(app).get('/api/leads').set('authorization', 'Bearer forged.token.here')).status).toBe(401);
  });

  it('returns the signed-in user', async () => {
    const r = await (await as(MAYA)).get('/api/auth/me');
    expect(r.status).toBe(200);
    expect(r.body.email ?? r.body.user?.email).toBe(MAYA);
  });

  it('does not reveal whether an email exists on forgot-password', async () => {
    const a = await request(app).post('/api/auth/forgot').send({ email: MAYA });
    const b = await request(app).post('/api/auth/forgot').send({ email: 'nobody@example.com' });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});
