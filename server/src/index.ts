import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config.js';
import { enabled, integrationStatus } from './integrations/settings.js';
import { sendEmail } from './integrations/providers.js';
import { startWorker } from './services/jobs.js';
import { startSelfUpdate } from './services/selfupdate.js';
import { setTeamEmailProvider } from './services/mailer.js';
import { attachRealtime } from './services/realtime.js';
import { sleeping } from './services/activity.js';
import { loadIntegrationSettings } from './integrations/store.js';

// Keys saved in Settings → Integrations; refreshed every minute in case another server instance changed them.
await loadIntegrationSettings();
setInterval(() => { if (sleeping()) return; loadIntegrationSettings().catch((e) => console.error('loading integration settings failed', e)); }, 60_000).unref();

setTeamEmailProvider((e) => sendEmail(e).then(() => undefined), enabled.email);
console.log('Integrations:', Object.entries(integrationStatus()).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' '));

const server = createServer(createApp());
attachRealtime(server);
server.listen(/^\d+$/.test(env.PORT) ? Number(env.PORT) : env.PORT, () => console.log(`Bliss API listening on :${env.PORT}`));
// The background worker runs inside the API process unless RUN_WORKER=false (then run `npm run worker` separately).
if (process.env.RUN_WORKER !== 'false') startWorker();
// Uploading ~/bliss-erp-update.zip on the server deploys it (see DEPLOY.md).
if (env.NODE_ENV === 'production' && process.env.SELF_UPDATE !== 'false') startSelfUpdate();
