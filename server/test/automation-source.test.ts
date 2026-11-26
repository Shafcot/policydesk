// New-lead automations can be limited to leads from chosen sources (e.g. a welcome email only for Meta ad leads).
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { automationRuns, leads, users } from '../src/db/schema.js';
import { insertReturning } from '../src/db/helpers.js';
import { fire } from '../src/services/automation.js';
import { ADMIN, as, freshPhone } from './helpers.js';

describe('new-lead source filter', () => {
  it('starts the flow only for leads from the chosen source', async () => {
    const a = await as(ADMIN);
    const r = await a.post('/api/automations', { name: 'Meta welcome', active: true, trigger: 'new_lead', triggerConfig: { sources: ['Facebook Ads'] },
      steps: [{ type: 'action', action: 'create_task', text: 'Welcome' }], stopOnReply: false, stopOnBooking: false, stopOnWonLost: false, businessHoursOnly: false });
    expect(r.status).toBeLessThan(300);
    const id = r.body.id;
    const u = (await db.query.users.findFirst({ where: eq(users.email, ADMIN) }))!;
    const mk = async (source: string) => (await insertReturning(db, leads, { agencyId: u.agencyId, firstName: 'Src', lastName: source, phone: freshPhone(), line: 'Auto', type: 'personal', source }))[0];
    const fb = await mk('facebook ads');
    const other = await mk('Referral');
    expect(await fire(db, 'new_lead', { agencyId: u.agencyId, leadId: fb.id })).toContain('Meta welcome');
    expect(await fire(db, 'new_lead', { agencyId: u.agencyId, leadId: other.id })).not.toContain('Meta welcome');
    const runs = await db.select().from(automationRuns).where(and(eq(automationRuns.automationId, id)));
    expect(runs.map((x) => x.leadId)).toEqual([fb.id]);
    expect((await a.get('/api/automations')).body.find((x: { id: string }) => x.id === id).triggerConfig.sources).toEqual(['Facebook Ads']);
  });
});
