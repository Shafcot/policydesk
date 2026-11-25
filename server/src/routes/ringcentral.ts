// RingCentral for signed-in users: connect / disconnect their RingCentral line, the browser phone's SIP settings,
// and (Super Admin) importing the account's numbers. The OAuth callback is public and mounted separately.
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { phoneNumbers, ringcentralConnections, users } from '../db/schema.js';
import { ah, badRequest } from '../lib/http.js';
import { requireAdmin, type AuthedRequest } from '../middleware/auth.js';
import { enabled } from '../integrations/settings.js';
import { authorizeUrl, completeSignIn, connection, disconnect, importOwnNumbers, lineFor, myNumbers, readState, redirectUri, RingCentralError, sipProvision } from '../integrations/ringcentral.js';

export const ringcentralRouter = Router();
const notReady = () => badRequest('RingCentral isn’t set up yet. The Super Admin adds the RingCentral app keys in Settings → Integrations.');

/** What the user's browser phone should use, and whether their RingCentral line is connected. */
ringcentralRouter.get('/ringcentral/status', ah<AuthedRequest>(async (req, res) => {
  const on = enabled.ringcentral();
  const c = on ? await connection(req.user.id) : null;
  const line = await lineFor(req.user.id);
  const lapsed = !!c && c.refreshExpiresAt.getTime() < Date.now();
  res.json({
    enabled: on, connected: !!c && !lapsed, lapsed, extensionNumber: c?.extensionNumber ?? null,
    line: line ? { number: line.number, provider: line.provider } : null,
    /** The browser phone runs on RingCentral when the user's number is a RingCentral number and their line is connected. */
    useRingCentral: on && !!c && !lapsed && line?.provider === 'ringcentral',
    ...(req.user.role === 'admin' ? { redirectUri: on ? redirectUri() : null } : {}),
  });
}));

/** Starts the sign-in: the browser opens this RingCentral page in a popup. */
ringcentralRouter.post('/ringcentral/connect', ah<AuthedRequest>(async (req, res) => {
  if (!enabled.ringcentral()) throw notReady();
  res.json({ url: authorizeUrl(req.user.id) });
}));

ringcentralRouter.delete('/ringcentral/connection', ah<AuthedRequest>(async (req, res) => {
  await disconnect(req.user.id);
  res.json({ ok: true });
}));

/** SIP settings for the RingCentral browser phone (only for the signed-in user's own line). */
ringcentralRouter.post('/ringcentral/sip', ah<AuthedRequest>(async (req, res) => {
  if (!enabled.ringcentral()) throw notReady();
  try { res.json({ sipInfo: await sipProvision(req.user.id) }); }
  catch (e) { throw badRequest(e instanceof Error ? e.message : 'RingCentral phone settings unavailable'); }
}));

/** The user's RingCentral numbers (refreshes the agency's list with them). */
ringcentralRouter.get('/ringcentral/numbers', ah<AuthedRequest>(async (req, res) => {
  if (!enabled.ringcentral()) throw notReady();
  try { res.json({ numbers: await myNumbers(req.user.id) }); }
  catch (e) { throw badRequest(e instanceof Error ? e.message : 'Could not read your RingCentral numbers'); }
}));

/** Super Admin: who has connected RingCentral, and re-reads every connected user's numbers. */
ringcentralRouter.get('/admin/ringcentral/connections', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  const rows = await db.select({ c: ringcentralConnections, name: users.name }).from(ringcentralConnections).innerJoin(users, eq(ringcentralConnections.userId, users.id)).where(eq(ringcentralConnections.agencyId, req.user.agencyId));
  res.json(rows.map(({ c, name }) => ({ userId: c.userId, name, extensionNumber: c.extensionNumber, lapsed: c.refreshExpiresAt.getTime() < Date.now(), connectedAt: c.createdAt })));
}));
ringcentralRouter.post('/admin/numbers/sync-ringcentral', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  if (!enabled.ringcentral()) throw notReady();
  const conns = await db.select().from(ringcentralConnections).where(eq(ringcentralConnections.agencyId, req.user.agencyId));
  if (!conns.length) throw badRequest('Nobody has connected RingCentral yet. Each user connects their line from their profile; their numbers are added automatically.');
  let added = 0; const failed: string[] = [];
  for (const c of conns) {
    try { added += await importOwnNumbers(c.userId); }
    catch (e) { failed.push(e instanceof RingCentralError ? e.message : String(e)); }
  }
  const total = (await db.select().from(phoneNumbers).where(eq(phoneNumbers.provider, 'ringcentral'))).length;
  res.json({ added, total, failed: failed.length });
}));

/** OAuth redirect (public): RingCentral sends the user back here; we save the line and close the popup. */
export const ringcentralCallback = Router();
ringcentralCallback.get('/api/ringcentral/callback', ah(async (req, res) => {
  const nonce = randomBytes(16).toString('base64');
  // This small page closes its own popup, so it allows exactly its one inline script.
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`);
  const page = (ok: boolean, msg: string) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RingCentral</title><body style="font-family:system-ui;max-width:460px;margin:15vh auto;padding:0 16px;color:#0F2347"><h2>${ok ? 'RingCentral connected' : 'RingCentral wasn’t connected'}</h2><p>${msg.replace(/[<>&]/g, '')}</p><p>You can close this window.</p><script nonce="${nonce}">try{window.opener&&window.opener.postMessage({type:'ringcentral-connected',ok:${ok}},location.origin)}catch(e){}setTimeout(function(){window.close()},${ok ? 1200 : 6000})</script></body>`);
  const userId = readState(String(req.query.state ?? ''));
  if (req.query.error) return page(false, String(req.query.error_description ?? req.query.error));
  if (!userId || !req.query.code) return page(false, 'This sign-in link expired. Start again from your profile.');
  try {
    const r = await completeSignIn(userId, String(req.query.code));
    page(true, `Your RingCentral line${r.extensionNumber ? ` (extension ${r.extensionNumber})` : ''} is connected to Bliss ERP.${r.numbersAdded ? ` ${r.numbersAdded} number${r.numbersAdded === 1 ? '' : 's'} added.` : ''}`);
  } catch (e) { page(false, e instanceof Error ? e.message : 'Something went wrong'); }
}));
