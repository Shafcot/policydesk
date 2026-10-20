// Entry file for hosts that start the app from the repository root (Hostinger Node.js web apps, etc.).
// Build first with `npm run build`. Serves the API, background worker and React app on one port.
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.CLIENT_DIST = process.env.CLIENT_DIST || require('node:path').join(__dirname, 'client', 'dist');

console.log(`Policy-desk starting: node ${process.version}, PORT=${process.env.PORT ?? '(unset)'}, DATABASE_URL ${process.env.DATABASE_URL ? 'set' : 'MISSING'}, JWT_SECRET ${process.env.JWT_SECRET ? 'set' : 'MISSING'}`);

// Some hosts don't run (or don't keep) the build step's output. If it's missing, build once before starting.
const fs = require('node:fs'), path = require('node:path');
let buildLog = '';
const built = () => fs.existsSync(path.join(__dirname, 'server', 'dist', 'start.js')) && fs.existsSync(path.join(__dirname, 'client', 'dist', 'index.html'));
if (!built()) {
  console.log('Build output not found. Running "npm run build" (takes about a minute)...');
  const r = require('node:child_process').spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 20 * 1024 * 1024 });
  buildLog = `${r.stdout || ''}\n${r.stderr || ''}\n${r.error ? r.error.message : ''}`.trim().split('\n').slice(-25).join('\n');
  console.log(buildLog);
  console.log(r.status === 0 ? 'Build finished.' : `Build failed (exit ${r.status}).`);
}

import('./server/dist/start.js').catch((e) => {
  // Don't just exit (the host would only show "503"): serve a page that says what's wrong, without secrets.
  const msg = String((e && e.message) || e).replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '[database url]').slice(0, 600);
  console.error('Policy-desk failed to start:', e);
  const hints = [];
  if (!process.env.DATABASE_URL) hints.push('DATABASE_URL is not set. Add the Neon connection string in the app\'s environment variables.');
  if (!process.env.JWT_SECRET) hints.push('JWT_SECRET is not set. Add 40+ random characters.');
  if (/ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(msg)) hints.push('The database could not be reached. Check DATABASE_URL (copy it again from Neon → Connect, pooling off).');
  if (/password authentication failed/i.test(msg)) hints.push('The database password in DATABASE_URL is wrong. Copy the connection string again from Neon.');
  if (/self[- ]signed|certificate/i.test(msg)) hints.push('SSL certificate problem. Add DATABASE_SSL=no-verify.');
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg)) hints.push('The app could not be built on the server. In the app\'s build settings set Build command to "npm run build" (Node.js 22), then redeploy and send the build log.');
  const diag = `node ${process.version} · node_modules ${fs.existsSync(path.join(__dirname, 'node_modules', 'express')) ? 'installed' : 'MISSING'} · server/dist ${fs.existsSync(path.join(__dirname, 'server', 'dist')) ? 'present' : 'missing'} · client/dist ${fs.existsSync(path.join(__dirname, 'client', 'dist')) ? 'present' : 'missing'}`;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Policy-desk: startup error</title><body style="font-family:system-ui;max-width:640px;margin:10vh auto;padding:0 16px;line-height:1.5"><h2>Policy-desk couldn't start</h2>${hints.length ? `<ul>${hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}<p><b>Error:</b></p><pre style="white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:8px">${esc(msg)}</pre><p><b>Server:</b> ${esc(diag)}</p>${buildLog ? `<p><b>Build output (last lines):</b></p><pre style="white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:8px;font-size:12px">${esc(buildLog.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '[database url]'))}</pre>` : ''}<p>Fix the environment variables in hPanel, then redeploy or restart the app.</p></body>`;
  const port = process.env.PORT && /^\d+$/.test(process.env.PORT) ? Number(process.env.PORT) : (process.env.PORT || 4000);
  require('node:http').createServer((_req, res) => { res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }).listen(port);
});
