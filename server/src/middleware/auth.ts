import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, type User } from '../db/schema.js';
import { verifyToken } from '../lib/auth.js';
import { forbidden, HttpError } from '../lib/http.js';

export type AuthedRequest = Request & { user: User };

/** Requires a valid bearer token; loads the user fresh so role changes and removals apply immediately. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'Please sign in', 'unauthenticated');
    let payload;
    try { payload = verifyToken(token); } catch { throw new HttpError(401, 'Your session expired. Sign in again.', 'unauthenticated'); }
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });
    if (!user || !user.active) throw new HttpError(401, 'This account is no longer active', 'unauthenticated');
    (req as AuthedRequest).user = user;
    next();
  } catch (e) { next(e); }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if ((req as AuthedRequest).user?.role !== 'admin') return next(forbidden('Only the Super Admin can do this'));
  next();
}

export const isAdmin = (u: User) => u.role === 'admin';
