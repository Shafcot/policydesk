import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agencies, users } from '../db/schema.js';
import { checkPassword, hashPassword, signToken } from '../lib/auth.js';
import { ah, badRequest, HttpError } from '../lib/http.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';

export const authRouter = Router();

export const publicUser = (u: typeof users.$inferSelect) => {
  const { passwordHash: _p, inviteToken: _i, ...rest } = u;
  return rest;
};

authRouter.post('/login', ah(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase().trim()) });
  if (!user || !user.passwordHash || !user.active || !(await checkPassword(password, user.passwordHash))) {
    throw new HttpError(401, 'Email or password is incorrect', 'bad_credentials');
  }
  res.json({ token: signToken({ sub: user.id, agencyId: user.agencyId, role: user.role }), user: publicUser(user) });
}));

/** Accept an invitation: set a password using the token emailed by the admin. */
authRouter.post('/accept-invite', ah(async (req, res) => {
  const { token, password } = z.object({ token: z.string().min(10), password: z.string().min(8) }).parse(req.body);
  const user = await db.query.users.findFirst({ where: eq(users.inviteToken, token) });
  if (!user) throw badRequest('This invitation link is invalid or was already used');
  const [u] = await db.update(users).set({ passwordHash: await hashPassword(password), inviteToken: null })
    .where(eq(users.id, user.id)).returning();
  res.json({ token: signToken({ sub: u.id, agencyId: u.agencyId, role: u.role }), user: publicUser(u) });
}));

authRouter.get('/me', requireAuth, ah<AuthedRequest>(async (req, res) => {
  const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, req.user.agencyId) });
  res.json({
    user: publicUser(req.user),
    agency: agency && { id: agency.id, name: agency.name, brandName: agency.brandName, brandColor: agency.brandColor, logoUrl: agency.logoUrl },
  });
}));
