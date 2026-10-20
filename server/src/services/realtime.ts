// Live updates over Socket.IO. Each socket joins its user room, and admins also join the agency admin room.
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { eq } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { verifyToken } from '../lib/auth.js';

let io: Server | null = null;

export function attachRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.CLIENT_ORIGIN }, path: '/socket.io' });
  io.use(async (socket, next) => {
    try {
      const p = verifyToken(String(socket.handshake.auth?.token ?? ''));
      const u = await db.query.users.findFirst({ where: eq(users.id, p.sub) });
      if (!u || !u.active) return next(new Error('unauthenticated'));
      socket.data.user = { id: u.id, agencyId: u.agencyId, role: u.role };
      next();
    } catch { next(new Error('unauthenticated')); }
  });
  io.on('connection', (socket) => {
    const u = socket.data.user as { id: string; agencyId: string; role: string };
    socket.join(`user:${u.id}`);
    if (u.role === 'admin') socket.join(`admins:${u.agencyId}`);
  });
}

/** Sends to one user, or to the agency's admins when userId is null. */
export function emit(agencyId: string, userId: string | null, event: string, payload: unknown = {}) {
  if (!io) return;
  io.to(userId ? `user:${userId}` : `admins:${agencyId}`).emit(event, payload);
}
/** Sends to a lead's owner and to admins (e.g. lead changed). */
export function emitLead(agencyId: string, agentId: string | null, event: string, payload: unknown = {}) {
  if (!io) return;
  const rooms = [`admins:${agencyId}`, ...(agentId ? [`user:${agentId}`] : [])];
  io.to(rooms).emit(event, payload);
}
