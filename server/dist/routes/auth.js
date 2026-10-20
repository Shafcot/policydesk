import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agencies, users } from '../db/schema.js';
import { checkPassword, hashPassword, signToken } from '../lib/auth.js';
import { ah, badRequest, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../config.js';
import { sendTeamEmail } from '../services/mailer.js';
import { and, gt } from 'drizzle-orm';
export const authRouter = Router();
export const publicUser = (u) => {
    const { passwordHash: _p, inviteToken: _i, resetToken: _r, resetExpiresAt: _e, ...rest } = u;
    return rest;
};
/** Slows down password guessing: 10 attempts per 15 minutes per IP + email. */
const loginLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.', code: 'rate_limited' },
});
const resetLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Try again later.', code: 'rate_limited' } });
authRouter.post('/login', loginLimiter, ah(async (req, res) => {
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
    if (!user)
        throw badRequest('This invitation link is invalid or was already used');
    const [u] = await db.update(users).set({ passwordHash: await hashPassword(password), inviteToken: null })
        .where(eq(users.id, user.id)).returning();
    res.json({ token: signToken({ sub: u.id, agencyId: u.agencyId, role: u.role }), user: publicUser(u) });
}));
authRouter.get('/me', requireAuth, ah(async (req, res) => {
    const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, req.user.agencyId) });
    res.json({
        user: publicUser(req.user),
        agency: agency && { id: agency.id, name: agency.name, brandName: agency.brandName, brandColor: agency.brandColor, logoUrl: agency.logoUrl },
    });
}));
/** Forgot password: emails a reset link valid for 1 hour. Always answers the same way so emails can't be probed. */
authRouter.post('/forgot', resetLimiter, ah(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase().trim()) });
    if (user && user.active)
        await issueReset(user.id);
    res.json({ ok: true });
}));
export async function issueReset(userId) {
    const token = randomBytes(24).toString('hex');
    const [u] = await db.update(users).set({ resetToken: token, resetExpiresAt: new Date(Date.now() + 3600e3) }).where(eq(users.id, userId)).returning();
    const link = `${env.CLIENT_ORIGIN}/reset-password?token=${token}`;
    await sendTeamEmail(db, { agencyId: u.agencyId, to: u.email, subject: 'Reset your Policy-desk CRM password', body: `Hi ${u.name.split(' ')[0]},\n\nUse this link to set a new password (valid for 1 hour):\n${link}\n\nIf you didn't ask for this, you can ignore this email.` });
    return link;
}
authRouter.post('/reset', resetLimiter, ah(async (req, res) => {
    const { token, password } = z.object({ token: z.string().min(10), password: z.string().min(8) }).parse(req.body);
    const user = await db.query.users.findFirst({ where: and(eq(users.resetToken, token), gt(users.resetExpiresAt, new Date())) });
    if (!user || !user.active)
        throw badRequest('This reset link is invalid or has expired');
    const [u] = await db.update(users).set({ passwordHash: await hashPassword(password), resetToken: null, resetExpiresAt: null }).where(eq(users.id, user.id)).returning();
    res.json({ token: signToken({ sub: u.id, agencyId: u.agencyId, role: u.role }), user: publicUser(u) });
}));
//# sourceMappingURL=auth.js.map