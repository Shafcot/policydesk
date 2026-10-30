// Builds the Express app (no listening, no worker) so tests and the server share it.
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config.js';
import { pool } from './db/client.js';
import { errorHandler } from './lib/http.js';
import { requireAuth } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { leadsRouter } from './routes/leads.js';
import { metaRouter, notificationsRouter, wonRouter } from './routes/misc.js';
import { usersRouter } from './routes/users.js';
import { workRouter } from './routes/work.js';
import { bookRouter } from './routes/book.js';
import { adminRouter } from './routes/admin.js';
import { growthRouter } from './routes/growth.js';
import { publicRouter } from './routes/public.js';
import { webhooks } from './integrations/webhooks.js';
import { integrationsRouter, mediaRouter } from './routes/integrations.js';
import { numbersRouter } from './routes/numbers.js';
export function createApp() {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1); // correct client IPs for rate limiting behind a load balancer
    // The CSP allows what the React app needs when served from here: Google Fonts, Twilio Voice, Firebase push, Socket.IO.
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
                'img-src': ["'self'", 'data:', 'blob:'],
                'media-src': ["'self'", 'blob:', 'https://sdk.twilio.com', 'https://media.twiliocdn.com'],
                'connect-src': ["'self'", 'wss:', 'https://*.twilio.com', 'wss://*.twilio.com', 'https://*.googleapis.com', 'https://*.firebaseio.com'],
                'worker-src': ["'self'", 'blob:'],
                'script-src': ["'self'", 'https://www.gstatic.com'], // Firebase service worker importScripts
            },
        },
    }));
    app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
    // Webhooks parse their own bodies (Twilio form posts, Facebook needs the raw body for its signature).
    app.use('/webhooks', webhooks);
    app.use(mediaRouter);
    app.use(express.json({ limit: '5mb' }));
    app.get('/api/health', async (_req, res) => {
        await pool.query('select 1');
        res.json({ ok: true });
    });
    app.use('/api/auth', authRouter);
    app.use('/api/public', publicRouter);
    // Everything below requires a signed-in user; permissions are checked per route on the server.
    app.use('/api', requireAuth);
    app.use('/api', workRouter);
    app.use('/api/users', usersRouter);
    app.use('/api/leads', leadsRouter);
    app.use('/api/leads', wonRouter);
    app.use('/api/dashboard', dashboardRouter);
    app.use('/api/notifications', notificationsRouter);
    app.use('/api/meta', metaRouter);
    app.use('/api', bookRouter);
    app.use('/api/admin', adminRouter);
    app.use('/api', growthRouter);
    app.use('/api', integrationsRouter);
    app.use('/api', numbersRouter);
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));
    // Production: serve the built React app from the same origin (set CLIENT_DIST, e.g. ../client/dist).
    const dist = process.env.CLIENT_DIST ? path.resolve(process.env.CLIENT_DIST) : '';
    if (dist && existsSync(path.join(dist, 'index.html'))) {
        app.use(express.static(dist, { index: false, maxAge: '1h' }));
        app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    }
    app.use(errorHandler);
    return app;
}
//# sourceMappingURL=app.js.map