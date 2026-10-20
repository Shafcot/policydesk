import { relations } from 'drizzle-orm';
import {
  customType, boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid, varchar,
} from 'drizzle-orm/pg-core';
import { AGENT_STATUSES, CALL_RESULTS, DEFAULT_SETTINGS, ROLES, STAGES, type AgencySettings } from '../domain.js';

export const roleEnum = pgEnum('role', ROLES);
export const agentStatusEnum = pgEnum('agent_status', AGENT_STATUSES);
export const stageEnum = pgEnum('stage', STAGES);
export const callResultEnum = pgEnum('call_result', CALL_RESULTS);
export const leadTypeEnum = pgEnum('lead_type', ['personal', 'commercial']);
export const channelEnum = pgEnum('channel', ['sms', 'email']);
export const directionEnum = pgEnum('direction', ['in', 'out']);
export const apptStatusEnum = pgEnum('appointment_status', ['scheduled', 'done', 'noshow', 'cancelled']);

/** Money stored as numeric(12,2), exposed to TypeScript as a number. */
const money = customType<{ data: number; driverData: string }>({
  dataType: () => 'numeric(12, 2)',
  fromDriver: (v) => Number(v),
  toDriver: (v) => String(v),
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => ts('created_at').notNull().defaultNow();

/** One row per agency (white-label tenant). */
export const agencies = pgTable('agencies', {
  id: id(),
  name: varchar('name', { length: 160 }).notNull(),
  brandName: varchar('brand_name', { length: 80 }).notNull().default('Policy-desk CRM'),
  brandColor: varchar('brand_color', { length: 16 }),
  logoUrl: text('logo_url'),
  settings: jsonb('settings').$type<AgencySettings>().notNull().default(DEFAULT_SETTINGS),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  email: varchar('email', { length: 200 }).notNull().unique(),
  phone: varchar('phone', { length: 40 }),
  passwordHash: text('password_hash'),
  role: roleEnum('role').notNull().default('agent'),
  status: agentStatusEnum('status').notNull().default('offline'),
  lines: text('lines').array().notNull().default([]),
  hoursStart: varchar('hours_start', { length: 5 }).notNull().default('08:00'),
  hoursEnd: varchar('hours_end', { length: 5 }).notNull().default('17:00'),
  daysOff: text('days_off').array().notNull().default(['Sat', 'Sun']),
  minCallsPerDay: integer('min_calls_per_day').notNull().default(50),
  maxCallsPerDay: integer('max_calls_per_day').notNull().default(100),
  monthlyTarget: money('monthly_target').notNull().default(0),
  inviteToken: varchar('invite_token', { length: 80 }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('users_agency_idx').on(t.agencyId)]);

export const leadSources = pgTable('lead_sources', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  costPerLead: money('cost_per_lead').notNull().default(0),
  isVendor: boolean('is_vendor').notNull().default(false),
});

export const leads = pgTable('leads', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  firstName: varchar('first_name', { length: 80 }).notNull(),
  lastName: varchar('last_name', { length: 80 }).notNull(),
  company: varchar('company', { length: 160 }),
  phone: varchar('phone', { length: 40 }).notNull(),
  email: varchar('email', { length: 200 }),
  stage: stageEnum('stage').notNull().default('new'),
  stageChangedAt: ts('stage_changed_at').notNull().defaultNow(),
  source: varchar('source', { length: 80 }).notNull(),
  agentId: uuid('agent_id').references(() => users.id, { onDelete: 'set null' }),
  line: varchar('line', { length: 40 }).notNull(),
  type: leadTypeEnum('type').notNull().default('personal'),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: ts('last_attempt_at'),
  lastContactAt: ts('last_contact_at'),
  lastCallById: uuid('last_call_by_id').references(() => users.id, { onDelete: 'set null' }),
  followUpAt: ts('follow_up_at'),
  callbackRequested: boolean('callback_requested').notNull().default(false),
  quotePremium: money('quote_premium'),
  optOut: boolean('opt_out').notNull().default(false),
  automation: varchar('automation', { length: 120 }),
  /** Live-call lock: set while a user is on a call with this lead. */
  lockedById: uuid('locked_by_id').references(() => users.id, { onDelete: 'set null' }),
  custom: jsonb('custom').$type<Record<string, string>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  index('leads_agency_stage_idx').on(t.agencyId, t.stage),
  index('leads_agent_idx').on(t.agentId),
  index('leads_phone_idx').on(t.phone),
  index('leads_created_idx').on(t.createdAt),
]);

export const calls = pgTable('calls', {
  id: id(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  startedAt: ts('started_at').notNull().defaultNow(),
  durationSec: integer('duration_sec').notNull().default(0),
  result: callResultEnum('result').notNull(),
  recordingUrl: text('recording_url'),
  transcript: jsonb('transcript').$type<{ speaker: string; text: string }[]>(),
  summary: text('summary'),
  notes: text('notes'),
}, (t) => [index('calls_lead_idx').on(t.leadId), index('calls_user_started_idx').on(t.userId, t.startedAt)]);

export const notes = pgTable('notes', {
  id: id(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  createdAt: createdAt(),
}, (t) => [index('notes_lead_idx').on(t.leadId)]);

export const messages = pgTable('messages', {
  id: id(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  channel: channelEnum('channel').notNull(),
  direction: directionEnum('direction').notNull(),
  subject: varchar('subject', { length: 240 }),
  body: text('body').notNull(),
  automated: boolean('automated').notNull().default(false),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('messages_lead_idx').on(t.leadId)]);

export const appointments = pgTable('appointments', {
  id: id(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  startsAt: ts('starts_at').notNull(),
  durationMin: integer('duration_min').notNull().default(30),
  type: varchar('type', { length: 40 }).notNull(),
  status: apptStatusEnum('status').notNull().default('scheduled'),
  createdAt: createdAt(),
}, (t) => [index('appointments_user_starts_idx').on(t.userId, t.startsAt)]);

export const customers = pgTable('customers', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').references(() => users.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 160 }).notNull(),
  company: varchar('company', { length: 160 }),
  phone: varchar('phone', { length: 40 }),
  email: varchar('email', { length: 200 }),
  type: leadTypeEnum('type').notNull().default('personal'),
  dob: varchar('dob', { length: 10 }),
  source: varchar('source', { length: 80 }),
  imported: boolean('imported').notNull().default(false),
  createdAt: createdAt(),
});

export const policies = pgTable('policies', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').references(() => users.id, { onDelete: 'set null' }),
  policyNumber: varchar('policy_number', { length: 60 }).notNull(),
  carrier: varchar('carrier', { length: 80 }).notNull(),
  line: varchar('line', { length: 40 }).notNull(),
  premium: money('premium').notNull(),
  effectiveDate: ts('effective_date').notNull(),
  renewalDate: ts('renewal_date').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
}, (t) => [index('policies_renewal_idx').on(t.renewalDate)]);

export const sales = pgTable('sales', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  policyId: uuid('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').references(() => users.id, { onDelete: 'set null' }),
  carrier: varchar('carrier', { length: 80 }).notNull(),
  line: varchar('line', { length: 40 }).notNull(),
  source: varchar('source', { length: 80 }),
  premium: money('premium').notNull(),
  soldAt: ts('sold_at').notNull().defaultNow(),
}, (t) => [index('sales_agency_sold_idx').on(t.agencyId, t.soldAt)]);

export const notifications = pgTable('notifications', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  /** null = goes to admins. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 30 }).notNull(),
  text: text('text').notNull(),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('notifications_user_idx').on(t.agencyId, t.userId, t.createdAt)]);

export const leadsRelations = relations(leads, ({ one, many }) => ({
  agent: one(users, { fields: [leads.agentId], references: [users.id] }),
  calls: many(calls),
  notes: many(notes),
  messages: many(messages),
  appointments: many(appointments),
}));
export const callsRelations = relations(calls, ({ one }) => ({
  lead: one(leads, { fields: [calls.leadId], references: [leads.id] }),
  user: one(users, { fields: [calls.userId], references: [users.id] }),
}));
export const notesRelations = relations(notes, ({ one }) => ({
  lead: one(leads, { fields: [notes.leadId], references: [leads.id] }),
  user: one(users, { fields: [notes.userId], references: [users.id] }),
}));
export const messagesRelations = relations(messages, ({ one }) => ({
  lead: one(leads, { fields: [messages.leadId], references: [leads.id] }),
}));
export const appointmentsRelations = relations(appointments, ({ one }) => ({
  lead: one(leads, { fields: [appointments.leadId], references: [leads.id] }),
  user: one(users, { fields: [appointments.userId], references: [users.id] }),
}));
export const customersRelations = relations(customers, ({ many }) => ({ policies: many(policies) }));
export const policiesRelations = relations(policies, ({ one }) => ({
  customer: one(customers, { fields: [policies.customerId], references: [customers.id] }),
}));

export type User = typeof users.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Agency = typeof agencies.$inferSelect;
