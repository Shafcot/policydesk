// Standalone background worker: `npm run worker` (use with RUN_WORKER=false on the API when scaling out).
import { startWorker } from './services/jobs.js';
import { enabled } from './integrations/settings.js';
import { sendEmail } from './integrations/providers.js';
import { setTeamEmailProvider } from './services/mailer.js';

setTeamEmailProvider((e) => sendEmail(e).then(() => undefined), enabled.email);

startWorker();
console.log('Policy-desk worker started');
