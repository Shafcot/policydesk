import { Server } from 'socket.io';
import { eq } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { verifyToken } from '../lib/auth.js';
let io = null;
export function attachRealtime(server) {
    io = new Server(server, { cors: { origin: env.CLIENT_ORIGIN }, path: '/socket.io' });
    io.use(async (socket, next) => {
        try {
            const p = verifyToken(String(socket.handshake.auth?.token ?? ''));
            const u = await db.query.users.findFirst({ where: eq(users.id, p.sub) });
            if (!u || !u.active)
                return next(new Error('unauthenticated'));
            socket.data.user = { id: u.id, agencyId: u.agencyId, role: u.role };
            next();
        }
        catch {
            next(new Error('unauthenticated'));
        }
    });
    io.on('connection', (socket) => {
        const u = socket.data.user;
        socket.join(`user:${u.id}`);
        if (u.role === 'admin')
            socket.join(`admins:${u.agencyId}`);
    });
}
/** Sends to one user, or to the agency's admins when userId is null. */
export function emit(agencyId, userId, event, payload = {}) {
    if (!io)
        return;
    io.to(userId ? `user:${userId}` : `admins:${agencyId}`).emit(event, payload);
}
/** Sends to a lead's owner and to admins (e.g. lead changed). */
export function emitLead(agencyId, agentId, event, payload = {}) {
    if (!io)
        return;
    const rooms = [`admins:${agencyId}`, ...(agentId ? [`user:${agentId}`] : [])];
    io.to(rooms).emit(event, payload);
}
//# sourceMappingURL=realtime.js.map