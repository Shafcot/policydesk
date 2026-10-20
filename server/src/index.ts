import { createServer } from 'node:http';
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
import { attachRealtime } from './services/realtime.js';
import { webhooks } from './integrations/webhooks.js';
import { integrationsRouter, mediaRouter } from './routes/integrations.js';
import { enabled, integrationStatus } from './integrations/settings.js';
import { sendEmail } from './integrations/providers.js';
import { setTeamEmailProvider } from './services/mailer.js';
import { startWorker } from './services/jobs.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // correct client IPs for rate limiting behind a load balancer
app.use(helmet());
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
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));
app.use(errorHandler);

if (enabled.email()) setTeamEmailProvider((e) => sendEmail(e).then(() => undefined));
console.log('Integrations:', Object.entries(integrationStatus()).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' '));

const server = createServer(app);
attachRealtime(server);
server.listen(env.PORT, () => console.log(`Policy-desk API listening on :${env.PORT}`));
// The background worker runs inside the API process unless RUN_WORKER=false (then run `npm run worker` separately).
if (process.env.RUN_WORKER !== 'false') startWorker();
