// Emails to team members (invites, password resets, notification copies).
// Stored first, then handed to the email provider (SendGrid, Milestone 3). Without a provider they stay "queued".
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { teamEmails } from '../db/schema.js';

type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TeamEmailProvider = (e: { to: string; subject: string; text: string }) => Promise<void>;
let provider: TeamEmailProvider | null = null;
let ready: () => boolean = () => true;
/** Called at startup. `isReady` is checked per email, so connecting SendGrid later needs no restart. */
export const setTeamEmailProvider = (p: TeamEmailProvider | null, isReady: () => boolean = () => true) => { provider = p; ready = isReady; };

export async function sendTeamEmail(x: Exec, e: { agencyId?: string | null; to: string; subject: string; body: string }) {
  const [row] = await x.insert(teamEmails).values({ agencyId: e.agencyId ?? null, to: e.to, subject: e.subject, body: e.body }).returning();
  if (!provider || !ready()) return row;
  // Deliver after the surrounding transaction; a failed send is recorded, never thrown to the caller.
  setImmediate(async () => {
    try { await provider!({ to: row.to, subject: row.subject, text: row.body }); await db.update(teamEmails).set({ status: 'sent' }).where(eq(teamEmails.id, row.id)); }
    catch (err) { await db.update(teamEmails).set({ status: 'failed', error: String(err).slice(0, 500) }).where(eq(teamEmails.id, row.id)); }
  });
  return row;
}
