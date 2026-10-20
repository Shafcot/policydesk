import request from 'supertest';
import { createApp } from '../src/app.js';

export const app = createApp();
export const PASSWORD = 'Policydesk123!';

const tokens = new Map<string, string>();
/** Signs in once per user per test file (the login route is rate limited). */
export async function login(email: string) {
  if (!tokens.has(email)) {
    const r = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
    tokens.set(email, r.body.token);
  }
  return tokens.get(email)!;
}

/** Request helper with a signed-in user. */
export async function as(email: string) {
  const token = await login(email);
  const auth = (t: request.Test) => t.set('authorization', `Bearer ${token}`);
  return {
    get: (u: string) => auth(request(app).get(u)),
    post: (u: string, body?: object) => auth(request(app).post(u)).send(body ?? {}),
    patch: (u: string, body?: object) => auth(request(app).patch(u)).send(body ?? {}),
    put: (u: string, body?: object) => auth(request(app).put(u)).send(body ?? {}),
    delete: (u: string) => auth(request(app).delete(u)),
  };
}

export const ADMIN = 'admin@policydesk.test';
export const MAYA = 'maya@policydesk.test';
export const DANIEL = 'daniel@policydesk.test';

/** A phone number no seeded lead uses (seed numbers are 555-01xx). */
export const freshPhone = () => `(415) ${String(200 + Math.floor(Math.random() * 700))}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
