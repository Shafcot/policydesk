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
import { sleeping, touch } from './services/activity.js';
import { callsRouter } from './routes/calls.js';
export function createApp() {
    const app = express();
    app.disable('x-powered-by');
    // Idle mode: every real request counts as activity (health checks don't, so uptime pings can't keep the database awake).
    app.use((req, _res, next) => { if (req.path !== '/api/health')
        touch(); next(); });
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
        if (sleeping())
            return res.json({ ok: true, database: 'sleeping' }); // don't wake a paused database for a ping
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
    app.use('/api', callsRouter);
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));
    // Import bridge (data migrations): the old CRM's page opens this window and posts leads to it. It must keep
    // its link to the window that opened it, so it skips the usual "same-origin" opener isolation. The page itself
    // asks the admin to allow the sending website and uses the admin's own sign-in (see client/public/import-bridge.js).
    app.get('/import-bridge', (_req, res) => {
        res.removeHeader('Cross-Origin-Opener-Policy');
        res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bliss · Import bridge</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#EEF5FD;color:#0F2347;margin:0;padding:32px 16px}main{max-width:560px;margin:auto;background:#fff;border:1px solid #D6E2F1;border-radius:14px;padding:24px}h1{font-size:20px;margin:0 0 6px}#ask{border:1px solid #2B7BF2;border-radius:10px;padding:14px;margin:14px 0;background:#E3EFFE}button{font:inherit;border-radius:999px;padding:8px 16px;border:1px solid #2470E6;margin-right:8px;cursor:pointer}#allow{background:#2B7BF2;color:#fff}#deny{background:#fff;color:#0F2347;border-color:#D6E2F1}small{color:#53678A}</style></head>
<body><main><h1>Import leads into Bliss</h1><p id="who"></p>
<div id="ask" hidden><b>Allow <span id="origin"></span> to send leads into Bliss?</b><p><small>Only allow a website you are migrating from yourself. Leads are added to this agency; nothing is deleted or sent anywhere.</small></p><button id="allow">Allow</button><button id="deny">Not now</button></div>
<p id="stats"></p><p><small>Keep this tab open until the import finishes.</small></p></main><script src="/import-bridge.js"></script></body></html>`);
    });
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