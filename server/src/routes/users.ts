import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { AGENT_STATUSES } from '../domain.js';
import { ah } from '../lib/http.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { callsTodayByUser } from '../services/rules.js';
import { publicUser } from './auth.js';

export const usersRouter = Router();

/** Team list. Agents get names only (needed to show lead owners); admins get full records + today's call counts. */
usersRouter.get('/', ah<AuthedRequest>(async (req, res) => {
  const list = await db.query.users.findMany({ where: and(eq(users.agencyId, req.user.agencyId), eq(users.active, true)), orderBy: asc(users.name) });
  if (req.user.role !== 'admin') {
    return res.json(list.map((u) => ({ id: u.id, name: u.name, role: u.role, status: u.status })));
  }
  const today = await callsTodayByUser(req.user.agencyId);
  res.json(list.map((u) => ({ ...publicUser(u), invited: !!u.inviteToken, callsToday: today.get(u.id) ?? 0 })));
}));

usersRouter.patch('/me/status', ah<AuthedRequest>(async (req, res) => {
  const { status } = z.object({ status: z.enum(AGENT_STATUSES) }).parse(req.body);
  const [u] = await db.update(users).set({ status }).where(eq(users.id, req.user.id)).returning();
  res.json(publicUser(u));
}));
