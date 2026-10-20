// Entry file for hosts that start the app from the repository root (Hostinger Node.js web apps, etc.).
// Build first with `npm run build`. Serves the API, background worker and React app on one port.
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.CLIENT_DIST = process.env.CLIENT_DIST || require('node:path').join(__dirname, 'client', 'dist');
import('./server/dist/start.js').catch((e) => {
  console.error('Policy-desk failed to start:', e);
  process.exit(1);
});
