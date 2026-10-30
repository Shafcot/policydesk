import { relations } from 'drizzle-orm';
import {
  customType, boolean, index, primaryKey, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar,
} from 'drizzle-orm/pg-core';
import { AGENT_STATUSES, CALL_RESULTS, DEFAULT_SETTINGS, ROLES, STAGES, TRIGGERS, type AgencySettings, type Step, type TriggerConfig } from '../domain.js';

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
  resetToken: varchar('reset_token', { length: 80 }),
  resetExpiresAt: ts('reset_expires_at'),
  /** Public booking page slug: /book/<slug>. */
  bookingSlug: varchar('booking_slug', { length: 60 }).unique(),
  /** Email copies of notifications (SOW 5: bell + email). */
  notifyByEmail: boolean('notify_by_email').notNull().default(true),
  /** Agent's Twilio number (E.164). Used as caller ID and to route inbound calls. */
  twilioNumber: varchar('twilio_number', { length: 20 }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('users_agency_idx').on(t.agencyId)]);

export const leadSources = pgTable('lead_sources', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  costPerLead: money('cost_per_lead').notNull().default(0),
  isVendor: boolean('is_vendor').notNull().default(false),
  /** Secret part of this source's webhook URL (/webhooks/leads/<key>) for vendors and website forms. */
  webhookKey: varchar('webhook_key', { length: 48 }).unique(),
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
  /** Twilio CallSid of the agent's call leg, used to attach the recording. */
  twilioSid: varchar('twilio_sid', { length: 64 }),
  transcriptStatus: varchar('transcript_status', { length: 20 }),
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
  /** A message belongs to a lead, or to a customer with no lead (e.g. imported customers' renewal reminders). */
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  channel: channelEnum('channel').notNull(),
  direction: directionEnum('direction').notNull(),
  subject: varchar('subject', { length: 240 }),
  body: text('body').notNull(),
  automated: boolean('automated').notNull().default(false),
  /** queued = waiting for the SMS/email provider (connected in Milestone 3). */
  status: varchar('status', { length: 20 }).notNull().default('sent'),
  providerId: varchar('provider_id', { length: 80 }),
  error: text('error'),
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
  remindedAt: ts('reminded_at'),
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

/** Speed-dial favorites per user. */
export const favorites = pgTable('favorites', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.leadId] })]);

/** Saved SMS / email templates. Variables: {first} {agent} {agency} {line} {booking}. */
export const templates = pgTable('templates', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  channel: channelEnum('channel').notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  subject: varchar('subject', { length: 240 }),
  body: text('body').notNull(),
  createdAt: createdAt(),
});

/** Emails to the team (invites, password resets, notification copies). Lead/customer messages live in `messages`. */
export const teamEmails = pgTable('team_emails', {
  id: id(),
  agencyId: uuid('agency_id').references(() => agencies.id, { onDelete: 'cascade' }),
  to: varchar('to', { length: 200 }).notNull(),
  subject: varchar('subject', { length: 240 }).notNull(),
  body: text('body').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  error: text('error'),
  createdAt: createdAt(),
});

/** Recordings reported by Twilio before or after the agent logs the call; matched on CallSid. */
export const callRecordings = pgTable('call_recordings', {
  callSid: varchar('call_sid', { length: 64 }).primaryKey(),
  recordingSid: varchar('recording_sid', { length: 64 }).notNull(),
  url: text('url').notNull(),
  durationSec: integer('duration_sec').notNull().default(0),
  createdAt: createdAt(),
});

/** Provider API keys entered in Settings → Integrations (encrypted). Environment variables are the fallback. */
export const integrationSettings = pgTable('integration_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The agency's phone numbers. Each can be assigned to one user (their caller ID and inbound line). */
export const phoneNumbers = pgTable('phone_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  number: varchar('number', { length: 20 }).notNull().unique(),
  label: varchar('label', { length: 80 }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  twilioSid: varchar('twilio_sid', { length: 64 }),
  createdAt: createdAt(),
}, (t) => [index('phone_numbers_user_idx').on(t.userId)]);

/** Browser push (Firebase Cloud Messaging) registrations. */
export const deviceTokens = pgTable('device_tokens', {
  token: text('token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
});

export const triggerEnum = pgEnum('automation_trigger', TRIGGERS);
export const runStatusEnum = pgEnum('run_status', ['active', 'completed', 'stopped']);
export const campaignKindEnum = pgEnum('campaign_kind', ['broadcast', 'birthday', 'holiday']);

export const automations = pgTable('automations', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  active: boolean('active').notNull().default(false),
  trigger: triggerEnum('trigger').notNull(),
  triggerConfig: jsonb('trigger_config').$type<TriggerConfig>().notNull().default({}),
  steps: jsonb('steps').$type<Step[]>().notNull().default([]),
  stopOnReply: boolean('stop_on_reply').notNull().default(true),
  stopOnBooking: boolean('stop_on_booking').notNull().default(true),
  stopOnWonLost: boolean('stop_on_won_lost').notNull().default(true),
  businessHoursOnly: boolean('business_hours_only').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** One lead (or customer) going through one automation. The worker advances runs whose nextRunAt has passed. */
export const automationRuns = pgTable('automation_runs', {
  id: id(),
  automationId: uuid('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  policyId: uuid('policy_id').references(() => policies.id, { onDelete: 'cascade' }),
  stepIndex: integer('step_index').notNull().default(0),
  status: runStatusEnum('status').notNull().default('active'),
  nextRunAt: ts('next_run_at').notNull().defaultNow(),
  stopReason: varchar('stop_reason', { length: 120 }),
  log: jsonb('log').$type<{ at: string; text: string }[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [index('runs_due_idx').on(t.status, t.nextRunAt), index('runs_lead_idx').on(t.leadId)]);

export const tasks = pgTable('tasks', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  dueAt: ts('due_at').notNull().defaultNow(),
  doneAt: ts('done_at'),
  createdAt: createdAt(),
}, (t) => [index('tasks_user_idx').on(t.userId, t.doneAt)]);

export const campaigns = pgTable('campaigns', {
  id: id(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  kind: campaignKindEnum('kind').notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  channel: channelEnum('channel').notNull().default('sms'),
  subject: varchar('subject', { length: 240 }),
  body: text('body').notNull(),
  active: boolean('active').notNull().default(true),
  /** holiday: 'MM-DD'. */
  holidayDate: varchar('holiday_date', { length: 5 }),
  /** broadcast: filters chosen when composing. */
  audience: jsonb('audience').$type<{ stage?: string; line?: string; type?: string; includeCustomers?: boolean }>(),
  scheduledFor: ts('scheduled_for'),
  sentAt: ts('sent_at'),
  recipients: integer('recipients').notNull().default(0),
  excluded: integer('excluded').notNull().default(0),
  createdAt: createdAt(),
});

/** Records that a daily job ran for an agency on a given local date, so it runs once per day. */
export const jobRuns = pgTable('job_runs', {
  job: varchar('job', { length: 40 }).notNull(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  day: varchar('day', { length: 10 }).notNull(),
  ranAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.job, t.agencyId, t.day] })]);

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
export type Automation = typeof automations.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Agency = typeof agencies.$inferSelect;
