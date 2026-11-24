// One-time data transfer (moving the agency to a new server/database).
// GET /api/admin/transfer/tables          → tables in insert order with row counts
// GET /api/admin/transfer/:table?page=N   → up to 1,000 rows of that table, oldest first
// Super Admin only. Saved provider keys, push tokens and pending team emails are not exported.
import { Router } from 'express';
import { asc, count } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import * as s from '../db/schema.js';
import { ah, badRequest } from '../lib/http.js';
import { requireAdmin, type AuthedRequest } from '../middleware/auth.js';

/** Insert order: parents before children. */
export const TRANSFER_TABLES: Record<string, PgTable> = {
  agencies: s.agencies, users: s.users, lead_sources: s.leadSources, leads: s.leads, customers: s.customers, policies: s.policies,
  sales: s.sales, calls: s.calls, notes: s.notes, messages: s.messages, appointments: s.appointments, notifications: s.notifications,
  favorites: s.favorites, templates: s.templates, call_recordings: s.callRecordings, phone_numbers: s.phoneNumbers, live_calls: s.liveCalls,
  voicemails: s.voicemails, speed_dial_contacts: s.speedDialContacts, automations: s.automations, automation_runs: s.automationRuns,
  tasks: s.tasks, campaigns: s.campaigns,
};
const PAGE = 1000;

export const transferRouter = Router();

transferRouter.get('/admin/transfer/tables', requireAdmin, ah<AuthedRequest>(async (_req, res) => {
  const out = [];
  for (const [name, t] of Object.entries(TRANSFER_TABLES)) out.push({ name, rows: Number((await db.select({ n: count() }).from(t))[0].n), pageSize: PAGE });
  res.json(out);
}));

transferRouter.get('/admin/transfer/:table', requireAdmin, ah<AuthedRequest>(async (req, res) => {
  const t = TRANSFER_TABLES[String(req.params.table)];
  if (!t) throw badRequest('Unknown table');
  const page = Math.max(0, Number(req.query.page ?? 0) | 0);
  const cfg = getTableConfig(t);
  // Stable order: the primary key (single or composite).
  const keyCols = cfg.columns.filter((c) => c.primary).length ? cfg.columns.filter((c) => c.primary) : cfg.primaryKeys[0]?.columns ?? [cfg.columns[0]];
  const rows = await db.select().from(t).orderBy(...keyCols.map((c) => asc(c))).limit(PAGE).offset(page * PAGE);
  res.json({ rows, more: rows.length === PAGE });
}));
