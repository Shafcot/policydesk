// Emails to team members (invites, password resets, notification copies).
// Stored first, then handed to the email provider (SendGrid, Milestone 3). Without a provider they stay "queued".
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { teamEmails } from '../db/schema.js';
let provider = null;
/** Called at startup by the SendGrid integration when it is configured. */
export const setTeamEmailProvider = (p) => { provider = p; };
export async function sendTeamEmail(x, e) {
    const [row] = await x.insert(teamEmails).values({ agencyId: e.agencyId ?? null, to: e.to, subject: e.subject, body: e.body }).returning();
    if (!provider)
        return row;
    // Deliver after the surrounding transaction; a failed send is recorded, never thrown to the caller.
    setImmediate(async () => {
        try {
            await provider({ to: row.to, subject: row.subject, text: row.body });
            await db.update(teamEmails).set({ status: 'sent' }).where(eq(teamEmails.id, row.id));
        }
        catch (err) {
            await db.update(teamEmails).set({ status: 'failed', error: String(err).slice(0, 500) }).where(eq(teamEmails.id, row.id));
        }
    });
    return row;
}
//# sourceMappingURL=mailer.js.map