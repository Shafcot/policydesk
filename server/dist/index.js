import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config.js';
import { enabled, integrationStatus } from './integrations/settings.js';
import { sendEmail } from './integrations/providers.js';
import { startWorker } from './services/jobs.js';
import { setTeamEmailProvider } from './services/mailer.js';
import { attachRealtime } from './services/realtime.js';
if (enabled.email())
    setTeamEmailProvider((e) => sendEmail(e).then(() => undefined));
console.log('Integrations:', Object.entries(integrationStatus()).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' '));
const server = createServer(createApp());
attachRealtime(server);
server.listen(/^\d+$/.test(env.PORT) ? Number(env.PORT) : env.PORT, () => console.log(`Policy-desk API listening on :${env.PORT}`));
// The background worker runs inside the API process unless RUN_WORKER=false (then run `npm run worker` separately).
if (process.env.RUN_WORKER !== 'false')
    startWorker();
//# sourceMappingURL=index.js.map