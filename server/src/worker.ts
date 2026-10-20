// Standalone background worker: `npm run worker` (use with RUN_WORKER=false on the API when scaling out).
import { startWorker } from './services/jobs.js';

startWorker();
console.log('Policy-desk worker started');
