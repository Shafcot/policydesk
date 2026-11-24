// One-time data transfer (moving the agency to a new server/database).
// GET /api/admin/transfer/tables          → tables in insert order with row counts
// GET /api/admin/transfer/:table?page=N   → up to 1,000 rows of that table, oldest first
// Super Admin only. Saved provider keys, push tokens and pending team emails are not exported.
import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asc, count, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { db } from '../db/client.js';
import * as s from '../db/schema.js';
import { ah, badRequest } from '../lib/http.js';
import { requireAdmin } from '../middleware/auth.js';
/** Insert order: parents before children. */
export const TRANSFER_TABLES = {
    agencies: s.agencies, users: s.users, lead_sources: s.leadSources, leads: s.leads, customers: s.customers, policies: s.policies,
    sales: s.sales, calls: s.calls, notes: s.notes, messages: s.messages, appointments: s.appointments, notifications: s.notifications,
    favorites: s.favorites, templates: s.templates, call_recordings: s.callRecordings, phone_numbers: s.phoneNumbers, live_calls: s.liveCalls,
    voicemails: s.voicemails, speed_dial_contacts: s.speedDialContacts, automations: s.automations, automation_runs: s.automationRuns,
    tasks: s.tasks, campaigns: s.campaigns,
};
const PAGE = 1000;
export const transferRouter = Router();
transferRouter.get('/admin/transfer/tables', requireAdmin, ah(async (_req, res) => {
    const out = [];
    for (const [name, t] of Object.entries(TRANSFER_TABLES))
        out.push({ name, rows: Number((await db.select({ n: count() }).from(t))[0].n), pageSize: PAGE });
    res.json(out);
}));
transferRouter.get('/admin/transfer/:table', requireAdmin, ah(async (req, res) => {
    const t = TRANSFER_TABLES[String(req.params.table)];
    if (!t)
        throw badRequest('Unknown table');
    const page = Math.max(0, Number(req.query.page ?? 0) | 0);
    const cfg = getTableConfig(t);
    // Stable order: the primary key (single or composite).
    const keyCols = cfg.columns.filter((c) => c.primary).length ? cfg.columns.filter((c) => c.primary) : cfg.primaryKeys[0]?.columns ?? [cfg.columns[0]];
    const rows = await db.select().from(t).orderBy(...keyCols.map((c) => asc(c))).limit(PAGE).offset(page * PAGE);
    res.json({ rows, more: rows.length === PAGE });
}));
/**
 * Restore (the receiving side of a transfer). Only works when RESTORE_KEY is set in the environment, every request
 * carries it in `x-restore-key`, and — for `begin` — the database has no agency yet (a fresh install).
 * Remove RESTORE_KEY once the transfer is done.
 *   POST /api/restore/begin             → checks the install is empty
 *   POST /api/restore/:table { rows }   → inserts rows exported by GET /api/admin/transfer/:table (same ids)
 */
export const restoreRouter = Router();
restoreRouter.use((req, res, next) => {
    const key = process.env.RESTORE_KEY;
    if (!key || key.length < 24)
        return res.status(404).json({ error: 'Not found', code: 'not_found' });
    const given = String(req.headers['x-restore-key'] ?? '');
    const a = Buffer.from(given), b = Buffer.from(key);
    if (a.length !== b.length || !timingSafeEqual(a, b))
        return res.status(403).json({ error: 'Wrong restore key', code: 'forbidden' });
    next();
});
restoreRouter.post('/begin', ah(async (_req, res) => {
    const n = Number((await db.select({ n: count() }).from(s.agencies))[0].n);
    if (n > 0)
        throw badRequest('This install already has data. Restore only works into an empty database.');
    res.json({ ok: true, tables: Object.keys(TRANSFER_TABLES) });
}));
restoreRouter.post('/:table', ah(async (req, res) => {
    const t = TRANSFER_TABLES[String(req.params.table)];
    if (!t)
        throw badRequest('Unknown table');
    const rows = z.array(z.record(z.unknown())).max(2000).parse(req.body?.rows);
    const cols = getTableColumns(t);
    // Exported JSON turns dates into ISO strings; datetime columns need Date objects back.
    const dateKeys = Object.entries(cols).filter(([, c]) => c.columnType === 'MySqlDateTime').map(([k]) => k);
    const known = new Set(Object.keys(cols));
    const clean = rows.map((r) => {
        const o = {};
        for (const [k, v] of Object.entries(r))
            if (known.has(k))
                o[k] = dateKeys.includes(k) && typeof v === 'string' ? new Date(v) : v;
        return o;
    });
    for (let i = 0; i < clean.length; i += 250)
        await db.insert(t).values(clean.slice(i, i + 250));
    res.json({ inserted: clean.length });
}));
//# sourceMappingURL=transfer.js.map