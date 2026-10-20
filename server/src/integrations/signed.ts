// Short-lived signed links for media the browser loads directly (audio tags can't send auth headers).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';

const sig = (payload: string) => createHmac('sha256', env.JWT_SECRET).update(payload).digest('base64url');

export function signPath(path: string, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${path}?exp=${exp}&sig=${sig(`${path}:${exp}`)}`;
}
export function verifyPath(path: string, exp: string, s: string) {
  if (!exp || !s || Number(exp) < Date.now() / 1000) return false;
  const a = Buffer.from(sig(`${path}:${exp}`)), b = Buffer.from(s);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Unsubscribe token for a lead or customer (stable, no expiry). */
export const unsubToken = (kind: 'lead' | 'customer', id: string) => `${kind[0]}.${id}.${sig(`unsub:${kind}:${id}`).slice(0, 22)}`;
export function readUnsubToken(t: string): { kind: 'lead' | 'customer'; id: string } | null {
  const [k, id, s] = t.split('.');
  const kind = k === 'l' ? 'lead' : k === 'c' ? 'customer' : null;
  if (!kind || !id || !s) return null;
  return unsubToken(kind, id) === t ? { kind, id } : null;
}
