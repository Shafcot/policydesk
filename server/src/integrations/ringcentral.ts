// RingCentral: browser calling (WebPhone over SIP/WebRTC), texting, call history and recordings for numbers
// that live on RingCentral. Each user connects their own RingCentral line (OAuth authorization code), so the
// browser phone registers as their extension and calls show their RingCentral number.
//
// Docs: OAuth (restapi/oauth/authorize + token), client-info/sip-provision, extension phone-number,
// extension sms, extension call-log (withRecording), subscription (WebHook delivery), media content URIs.
import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { callRecordings, phoneNumbers, ringcentralConnections, users } from '../db/schema.js';
import { cfg, enabled } from './settings.js';
import { decrypt, encrypt } from './store.js';
import { toE164 } from './phone.js';

type Conn = typeof ringcentralConnections.$inferSelect;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let fetcher: FetchLike = (url, init) => fetch(url, init);
/** Tests only: replace HTTP calls to RingCentral with a fake. */
export const setRingCentralFetchForTests = (f: FetchLike | null) => { fetcher = f ?? ((url, init) => fetch(url, init)); };

export class RingCentralError extends Error {
  constructor(message: string, readonly status = 0, readonly code = '') { super(message); }
}

const server = () => cfg.ringcentral().server;
const basic = () => { const r = cfg.ringcentral(); return `Basic ${Buffer.from(`${r.clientId}:${r.clientSecret}`).toString('base64')}`; };
export const redirectUri = () => `${cfg.publicApiUrl()}/api/ringcentral/callback`;
export const webhookUrl = (userId: string) => `${cfg.publicApiUrl()}/webhooks/ringcentral?u=${userId}`;
/** Token RingCentral echoes on every webhook delivery for this user, so we know the event is genuine. */
export const verificationToken = (userId: string) => createHmac('sha256', env.JWT_SECRET).update(`rc-webhook:${userId}`).digest('hex').slice(0, 32);

/* ---------------- sign-in (OAuth) ---------------- */

/** Signed, 15-minute `state` so the callback knows which user is connecting (and can't be forged). */
export function signState(userId: string) {
  const exp = Math.floor(Date.now() / 1000) + 900;
  const sig = createHmac('sha256', env.JWT_SECRET).update(`rc-state:${userId}:${exp}`).digest('base64url');
  return `${userId}.${exp}.${sig}`;
}
export function readState(state: string): string | null {
  const [userId, exp, sig] = String(state).split('.');
  if (!userId || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  const want = createHmac('sha256', env.JWT_SECRET).update(`rc-state:${userId}:${exp}`).digest('base64url');
  return want === sig ? userId : null;
}

export function authorizeUrl(userId: string) {
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.ringcentral().clientId, redirect_uri: redirectUri(), state: signState(userId) });
  return `${server()}/restapi/oauth/authorize?${q}`;
}

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; refresh_token_expires_in: number; owner_id: string };

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const r = await fetcher(`${server()}/restapi/oauth/token`, { method: 'POST', headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString() });
  const j = await r.json().catch(() => ({})) as Partial<TokenResponse> & { error_description?: string; message?: string; error?: string };
  if (!r.ok || !j.access_token) throw new RingCentralError(j.error_description || j.message || `RingCentral sign-in failed (${r.status})`, r.status, j.error ?? '');
  return j as TokenResponse;
}

const expiries = (t: TokenResponse) => ({
  accessExpiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000),
  refreshExpiresAt: new Date(Date.now() + (t.refresh_token_expires_in - 60) * 1000),
});

/** Finishes the sign-in: exchanges the code, saves the connection, adds the user's RingCentral numbers and subscribes to their texts. */
export async function completeSignIn(userId: string, code: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.active) throw new RingCentralError('This Bliss ERP user can’t connect RingCentral');
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const ext = await rawGet<{ id: number | string; extensionNumber?: string; account?: { id: number | string } }>(t.access_token, '/restapi/v1.0/account/~/extension/~');
  const row = {
    agencyId: user.agencyId, accountId: String(ext.account?.id ?? ''), extensionId: String(ext.id), extensionNumber: ext.extensionNumber ?? null,
    accessToken: encrypt(t.access_token), refreshToken: encrypt(t.refresh_token), ...expiries(t), updatedAt: new Date(),
  };
  // One RingCentral extension belongs to one Bliss ERP user.
  const other = await db.query.ringcentralConnections.findFirst({ where: eq(ringcentralConnections.extensionId, row.extensionId) });
  if (other && other.userId !== userId) throw new RingCentralError('That RingCentral line is already connected to another Bliss ERP user. Disconnect it there first.');
  await db.insert(ringcentralConnections).values({ userId, ...row }).onDuplicateKeyUpdate({ set: { ...row, subscriptionId: null, subscriptionExpiresAt: null } });
  const added = await importOwnNumbers(userId).catch((e) => { console.warn('RingCentral number import failed', e); return 0; });
  await ensureSubscription(userId).catch((e) => console.warn('RingCentral text subscription failed', e));
  return { extensionNumber: row.extensionNumber, numbersAdded: added };
}

export async function disconnect(userId: string) {
  const c = await connection(userId);
  if (!c) return;
  const token = decrypt(c.accessToken);
  if (c.subscriptionId && token) await fetcher(`${server()}/restapi/v1.0/subscription/${c.subscriptionId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  const refresh = decrypt(c.refreshToken);
  if (refresh) await fetcher(`${server()}/restapi/oauth/revoke`, { method: 'POST', headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }).toString() }).catch(() => undefined);
  await db.delete(ringcentralConnections).where(eq(ringcentralConnections.userId, userId));
}

export const connection = (userId: string) => db.query.ringcentralConnections.findFirst({ where: eq(ringcentralConnections.userId, userId) });

/** A valid access token for the user, refreshed when it's about to expire. Null when not connected (or the sign-in lapsed). */
export async function accessToken(userId: string): Promise<string | null> {
  const c = await connection(userId);
  if (!c) return null;
  if (c.accessExpiresAt.getTime() > Date.now()) return decrypt(c.accessToken);
  const refresh = decrypt(c.refreshToken);
  if (!refresh || c.refreshExpiresAt.getTime() < Date.now()) return null;
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
    await db.update(ringcentralConnections).set({ accessToken: encrypt(t.access_token), refreshToken: encrypt(t.refresh_token), ...expiries(t), updatedAt: new Date() }).where(eq(ringcentralConnections.userId, userId));
    return t.access_token;
  } catch (e) {
    // invalid_grant = the user's sign-in was revoked or expired: they need to connect again.
    if (e instanceof RingCentralError && /invalid_grant/i.test(e.code + e.message)) await db.update(ringcentralConnections).set({ refreshExpiresAt: new Date(0) }).where(eq(ringcentralConnections.userId, userId));
    throw e;
  }
}

/* ---------------- REST helpers ---------------- */

async function rawGet<T>(token: string, path: string): Promise<T> {
  const r = await fetcher(`${server()}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const j = await r.json().catch(() => ({})) as T & { message?: string; errorCode?: string };
  if (!r.ok) throw new RingCentralError(j.message || `RingCentral request failed (${r.status})`, r.status, j.errorCode ?? '');
  return j;
}

/** Calls the RingCentral API as `userId`. */
export async function rc<T>(userId: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await accessToken(userId);
  if (!token) throw new RingCentralError('RingCentral isn’t connected for this user. Connect it from your profile.');
  if (!init.method || init.method === 'GET') return rawGet<T>(token, path);
  const r = await fetcher(`${server()}${path}`, { method: init.method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const j = await r.json().catch(() => ({})) as T & { message?: string; errorCode?: string };
  if (!r.ok) throw new RingCentralError(j.message || `RingCentral request failed (${r.status})`, r.status, j.errorCode ?? '');
  return j;
}

/** SIP registration details for the user's browser phone (RingCentral WebPhone). */
export async function sipProvision(userId: string) {
  const r = await rc<{ sipInfo?: unknown[] }>(userId, '/restapi/v1.0/client-info/sip-provision', { method: 'POST', body: { sipInfo: [{ transport: 'WSS' }] } });
  if (!r.sipInfo?.[0]) throw new RingCentralError('RingCentral didn’t return phone settings for this line. Check the app has the VoIP Calling permission.');
  return r.sipInfo[0];
}

type RcNumber = { phoneNumber: string; features?: string[]; usageType?: string; type?: string; extension?: { id?: number | string } };

/** The user's own RingCentral numbers, with what each can do. */
export async function myNumbers(userId: string) {
  const r = await rc<{ records: RcNumber[] }>(userId, '/restapi/v1.0/account/~/extension/~/phone-number?perPage=100');
  return r.records.map((n) => ({ number: toE164(n.phoneNumber) ?? n.phoneNumber, callerId: !!n.features?.includes('CallerId'), sms: !!n.features?.includes('SmsSender'), usageType: n.usageType ?? null }));
}

/** Adds the user's direct numbers to the agency's list as RingCentral numbers, and gives them one if they have none. */
export async function importOwnNumbers(userId: string) {
  const c = await connection(userId);
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!c || !user) return 0;
  const mine = (await myNumbers(userId)).filter((n) => n.callerId && /^\+\d{8,15}$/.test(n.number) && (n.usageType === 'DirectNumber' || n.usageType === null));
  let added = 0;
  for (const n of mine) {
    const existing = await db.query.phoneNumbers.findFirst({ where: eq(phoneNumbers.number, n.number) });
    if (existing && existing.agencyId !== user.agencyId) continue;
    if (existing) await db.update(phoneNumbers).set({ provider: 'ringcentral', rcExtensionId: c.extensionId }).where(eq(phoneNumbers.id, existing.id));
    else { await db.insert(phoneNumbers).values({ agencyId: user.agencyId, number: n.number, label: 'RingCentral', provider: 'ringcentral', rcExtensionId: c.extensionId }); added++; }
  }
  // No number yet → use their first RingCentral number, so calls show it and texts come from it.
  if (!user.twilioNumber && mine[0]) {
    const n = await db.query.phoneNumbers.findFirst({ where: and(eq(phoneNumbers.number, mine[0].number), eq(phoneNumbers.agencyId, user.agencyId)) });
    if (n && !n.userId) {
      await db.update(phoneNumbers).set({ userId }).where(eq(phoneNumbers.id, n.id));
      await db.update(users).set({ twilioNumber: n.number }).where(eq(users.id, userId));
    }
  }
  return added;
}

/** The number a user calls and texts from, and who carries it. */
export async function lineFor(userId: string | null | undefined) {
  if (!userId) return null;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.twilioNumber) return null;
  const n = await db.query.phoneNumbers.findFirst({ where: eq(phoneNumbers.number, user.twilioNumber) });
  return { number: user.twilioNumber, provider: (n?.provider === 'ringcentral' ? 'ringcentral' : 'twilio') as 'twilio' | 'ringcentral' };
}

/** Sends a text from the user's RingCentral number. */
export async function sendRcSms(userId: string, from: string, to: string, text: string) {
  const r = await rc<{ id: number | string; messageStatus?: string }>(userId, '/restapi/v1.0/account/~/extension/~/sms', { method: 'POST', body: { from: { phoneNumber: from }, to: [{ phoneNumber: to }], text } });
  return { id: `rc:${r.id}`, status: r.messageStatus ?? 'Queued' };
}

/* ---------------- incoming texts (webhook subscription) ---------------- */

const SUBSCRIPTION_SECONDS = 7 * 24 * 3600;

/** Creates or renews the user's webhook subscription for incoming texts. */
export async function ensureSubscription(userId: string) {
  const c = await connection(userId);
  if (!c || !enabled.ringcentral()) return;
  if (c.subscriptionId && c.subscriptionExpiresAt && c.subscriptionExpiresAt.getTime() > Date.now() + 2 * 24 * 3600_000) return;
  const body = { eventFilters: ['/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS'], deliveryMode: { transportType: 'WebHook', address: webhookUrl(userId), verificationToken: verificationToken(userId) }, expiresIn: SUBSCRIPTION_SECONDS };
  let sub: { id: string; expirationTime?: string } | null = null;
  if (c.subscriptionId) sub = await rc<{ id: string; expirationTime?: string }>(userId, `/restapi/v1.0/subscription/${c.subscriptionId}`, { method: 'PUT', body }).catch(() => null);
  sub ??= await rc<{ id: string; expirationTime?: string }>(userId, '/restapi/v1.0/subscription', { method: 'POST', body });
  await db.update(ringcentralConnections).set({ subscriptionId: sub.id, subscriptionExpiresAt: sub.expirationTime ? new Date(sub.expirationTime) : new Date(Date.now() + SUBSCRIPTION_SECONDS * 1000) }).where(eq(ringcentralConnections.userId, userId));
}

/* ---------------- recordings ---------------- */

/** Stored recording URLs look like rc:<userId>|<contentUri> so we know whose sign-in can download them. */
export const recordingRef = (userId: string, contentUri: string) => `rc:${userId}|${contentUri}`;
export const isRcRecording = (url: string) => url.startsWith('rc:');

export async function fetchRcRecording(ref: string): Promise<Response> {
  const [userId, uri] = ref.slice(3).split('|');
  const token = await accessToken(userId);
  if (!token || !uri) return new Response(null, { status: 404 });
  return fetcher(uri, { headers: { authorization: `Bearer ${token}` } });
}

type LogRecord = { telephonySessionId?: string; duration?: number; recording?: { id: number | string; contentUri: string } };

/**
 * Reads the user's recent RingCentral call history and stores each recording under its call
 * (calls logged from the browser phone carry the RingCentral session id), then transcribes it.
 */
export async function syncCallLog(userId: string, attach: (callSid: string) => Promise<void>) {
  const from = new Date(Date.now() - 3 * 3600_000).toISOString();
  const r = await rc<{ records: LogRecord[] }>(userId, `/restapi/v1.0/account/~/extension/~/call-log?withRecording=true&perPage=100&dateFrom=${encodeURIComponent(from)}`);
  let stored = 0;
  for (const rec of r.records ?? []) {
    if (!rec.telephonySessionId || !rec.recording?.contentUri) continue;
    const callSid = `rc:${rec.telephonySessionId}`;
    await db.insert(callRecordings).values({ callSid, recordingSid: `rc:${rec.recording.id}`, url: recordingRef(userId, rec.recording.contentUri), durationSec: rec.duration ?? 0 }).onDuplicateKeyUpdate({ set: { callSid: sql`call_sid` } });
    await attach(callSid);
    stored++;
  }
  await db.update(ringcentralConnections).set({ callLogSyncedAt: new Date() }).where(eq(ringcentralConnections.userId, userId));
  return stored;
}

/** Worker: every few minutes, pick up new recordings and keep each user's text subscription alive. */
export async function ringcentralHousekeeping(attach: (callSid: string) => Promise<void>) {
  if (!enabled.ringcentral()) return;
  const all = await db.select().from(ringcentralConnections);
  for (const c of all as Conn[]) {
    if (c.refreshExpiresAt.getTime() < Date.now()) continue; // sign-in lapsed; they need to reconnect
    try {
      await ensureSubscription(c.userId);
      if (!c.callLogSyncedAt || c.callLogSyncedAt.getTime() < Date.now() - 5 * 60_000) await syncCallLog(c.userId, attach);
    } catch (e) { console.warn(`RingCentral housekeeping failed for ${c.userId}:`, e instanceof Error ? e.message : e); }
  }
}

/** Settings → Integrations "Test": checks the app keys with RingCentral (a dummy code is refused differently for good and bad keys). */
export async function testRingCentralKeys() {
  const r = cfg.ringcentral();
  if (!r.clientId || !r.clientSecret) throw new RingCentralError('Fill in the Client ID and Client secret first.');
  if (!/^https:\/\//.test(cfg.publicApiUrl())) throw new RingCentralError('The app needs a public https:// address first (App address above).');
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: 'bliss-erp-key-check', redirect_uri: redirectUri() });
    return 'Keys accepted.';
  } catch (e) {
    const code = e instanceof RingCentralError ? `${e.code} ${e.message}` : String(e);
    if (/invalid_client|unauthorized_client|OAU-1/i.test(code) && !/invalid_grant/i.test(code)) throw new RingCentralError(`RingCentral refused the keys: ${e instanceof Error ? e.message : code}`);
    if (/invalid_grant|OAU-2/i.test(code)) return `Keys accepted by RingCentral (${r.server.includes('devtest') ? 'test environment' : 'live'}). Add this redirect address to the RingCentral app: ${redirectUri()}. Users can now connect their RingCentral line from their profile.`;
    throw e;
  }
}
