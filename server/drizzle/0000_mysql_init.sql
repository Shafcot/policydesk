CREATE TABLE `agencies` (
	`id` varchar(36) NOT NULL,
	`name` varchar(160) NOT NULL,
	`brand_name` varchar(80) NOT NULL DEFAULT 'Bliss',
	`brand_color` varchar(16),
	`logo_url` text,
	`settings` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `agencies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `appointments` (
	`id` varchar(36) NOT NULL,
	`lead_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`starts_at` datetime(3) NOT NULL,
	`duration_min` int NOT NULL DEFAULT 30,
	`type` varchar(40) NOT NULL,
	`status` enum('scheduled','done','noshow','cancelled') NOT NULL DEFAULT 'scheduled',
	`reminded_at` datetime(3),
	`outlook_event_id` varchar(400),
	`outlook_synced_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `appointments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` varchar(36) NOT NULL,
	`automation_id` varchar(36) NOT NULL,
	`lead_id` varchar(36),
	`customer_id` varchar(36),
	`policy_id` varchar(36),
	`step_index` int NOT NULL DEFAULT 0,
	`status` enum('active','completed','stopped') NOT NULL DEFAULT 'active',
	`next_run_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`stop_reason` varchar(120),
	`log` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `automations` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`active` boolean NOT NULL DEFAULT false,
	`trigger` enum('new_lead','stage_change','call_result','missed_appointment','policy_won','renewal_date','birthday','inactive') NOT NULL,
	`trigger_config` json NOT NULL,
	`steps` json NOT NULL,
	`stop_on_reply` boolean NOT NULL DEFAULT true,
	`stop_on_booking` boolean NOT NULL DEFAULT true,
	`stop_on_won_lost` boolean NOT NULL DEFAULT true,
	`business_hours_only` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `call_recordings` (
	`call_sid` varchar(64) NOT NULL,
	`recording_sid` varchar(64) NOT NULL,
	`url` text NOT NULL,
	`duration_sec` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `call_recordings_call_sid` PRIMARY KEY(`call_sid`)
);
--> statement-breakpoint
CREATE TABLE `calls` (
	`id` varchar(36) NOT NULL,
	`lead_id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`duration_sec` int NOT NULL DEFAULT 0,
	`result` enum('no_answer','voicemail','sent_text','call_back','needs_quote','quoted','sold','lost') NOT NULL,
	`recording_url` text,
	`transcript` json,
	`summary` text,
	`notes` text,
	`twilio_sid` varchar(64),
	`transcript_status` varchar(20),
	CONSTRAINT `calls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`kind` enum('broadcast','birthday','holiday') NOT NULL,
	`name` varchar(120) NOT NULL,
	`channel` enum('sms','email') NOT NULL DEFAULT 'sms',
	`subject` varchar(240),
	`body` text NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`holiday_date` varchar(5),
	`audience` json,
	`scheduled_for` datetime(3),
	`sent_at` datetime(3),
	`recipients` int NOT NULL DEFAULT 0,
	`excluded` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`lead_id` varchar(36),
	`agent_id` varchar(36),
	`name` varchar(160) NOT NULL,
	`company` varchar(160),
	`phone` varchar(40),
	`email` varchar(200),
	`type` enum('personal','commercial') NOT NULL DEFAULT 'personal',
	`dob` varchar(10),
	`source` varchar(80),
	`imported` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `device_tokens` (
	`token` varchar(255) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `device_tokens_token` PRIMARY KEY(`token`)
);
--> statement-breakpoint
CREATE TABLE `favorites` (
	`user_id` varchar(36) NOT NULL,
	`lead_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `favorites_user_id_lead_id_pk` PRIMARY KEY(`user_id`,`lead_id`)
);
--> statement-breakpoint
CREATE TABLE `integration_settings` (
	`key` varchar(64) NOT NULL,
	`value` text NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `integration_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`job` varchar(40) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`day` varchar(10) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `job_runs_job_agency_id_day_pk` PRIMARY KEY(`job`,`agency_id`,`day`)
);
--> statement-breakpoint
CREATE TABLE `lead_sources` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`name` varchar(80) NOT NULL,
	`cost_per_lead` decimal(12, 2) NOT NULL DEFAULT 0,
	`is_vendor` boolean NOT NULL DEFAULT false,
	`webhook_key` varchar(48),
	CONSTRAINT `lead_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `lead_sources_webhook_key_unique` UNIQUE(`webhook_key`)
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`first_name` varchar(80) NOT NULL,
	`last_name` varchar(80) NOT NULL,
	`company` varchar(160),
	`phone` varchar(40) NOT NULL,
	`email` varchar(200),
	`stage` enum('new','attempted','followup','ready','quoted','won','lost','requote','recycled') NOT NULL DEFAULT 'new',
	`stage_changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`source` varchar(80) NOT NULL,
	`agent_id` varchar(36),
	`line` varchar(40) NOT NULL,
	`type` enum('personal','commercial') NOT NULL DEFAULT 'personal',
	`attempts` int NOT NULL DEFAULT 0,
	`last_attempt_at` datetime(3),
	`last_contact_at` datetime(3),
	`last_call_by_id` varchar(36),
	`follow_up_at` datetime(3),
	`callback_requested` boolean NOT NULL DEFAULT false,
	`quote_premium` decimal(12, 2),
	`opt_out` boolean NOT NULL DEFAULT false,
	`automation` varchar(120),
	`locked_by_id` varchar(36),
	`ai_status` varchar(12),
	`ai_turns` int NOT NULL DEFAULT 0,
	`bad_reason` varchar(16),
	`bad_at` datetime(3),
	`bad_by_id` varchar(36),
	`custom` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `leads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `live_calls` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`direction` varchar(3) NOT NULL,
	`status` varchar(12) NOT NULL DEFAULT 'ringing',
	`agent_id` varchar(36),
	`agent_call_sid` varchar(64),
	`log_call_sid` varchar(64),
	`customer_call_sid` varchar(64),
	`customer_number` varchar(20) NOT NULL,
	`lead_id` varchar(36),
	`conference_sid` varchar(64),
	`transfer` json,
	`answered_at` datetime(3),
	`ended_at` datetime(3),
	`end_reason` varchar(40),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `live_calls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` varchar(36) NOT NULL,
	`lead_id` varchar(36),
	`customer_id` varchar(36),
	`user_id` varchar(36),
	`channel` enum('sms','email') NOT NULL,
	`direction` enum('in','out') NOT NULL,
	`subject` varchar(240),
	`body` text NOT NULL,
	`automated` boolean NOT NULL DEFAULT false,
	`status` varchar(20) NOT NULL DEFAULT 'sent',
	`provider_id` varchar(80),
	`error` text,
	`read_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` varchar(36) NOT NULL,
	`lead_id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`body` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`kind` varchar(30) NOT NULL,
	`text` text NOT NULL,
	`lead_id` varchar(36),
	`read_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `phone_numbers` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`number` varchar(20) NOT NULL,
	`label` varchar(80),
	`user_id` varchar(36),
	`twilio_sid` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `phone_numbers_id` PRIMARY KEY(`id`),
	CONSTRAINT `phone_numbers_number_unique` UNIQUE(`number`)
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` varchar(36) NOT NULL,
	`customer_id` varchar(36) NOT NULL,
	`agent_id` varchar(36),
	`policy_number` varchar(60) NOT NULL,
	`carrier` varchar(80) NOT NULL,
	`line` varchar(40) NOT NULL,
	`premium` decimal(12, 2) NOT NULL,
	`effective_date` datetime(3) NOT NULL,
	`renewal_date` datetime(3) NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'active',
	CONSTRAINT `policies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`customer_id` varchar(36) NOT NULL,
	`policy_id` varchar(36) NOT NULL,
	`agent_id` varchar(36),
	`carrier` varchar(80) NOT NULL,
	`line` varchar(40) NOT NULL,
	`source` varchar(80),
	`premium` decimal(12, 2) NOT NULL,
	`sold_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sales_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `speed_dial_contacts` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`name` varchar(120) NOT NULL,
	`phone` varchar(20) NOT NULL,
	`note` varchar(200),
	`shared` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `speed_dial_contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`lead_id` varchar(36),
	`customer_id` varchar(36),
	`title` text NOT NULL,
	`due_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`done_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `team_emails` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36),
	`to` varchar(200) NOT NULL,
	`subject` varchar(240) NOT NULL,
	`body` text NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'queued',
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `team_emails_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`channel` enum('sms','email') NOT NULL,
	`name` varchar(80) NOT NULL,
	`subject` varchar(240),
	`body` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`email` varchar(200) NOT NULL,
	`phone` varchar(40),
	`password_hash` text,
	`role` enum('admin','agent') NOT NULL DEFAULT 'agent',
	`status` enum('available','oncall','offline') NOT NULL DEFAULT 'offline',
	`lines` json NOT NULL,
	`hours_start` varchar(5) NOT NULL DEFAULT '08:00',
	`hours_end` varchar(5) NOT NULL DEFAULT '17:00',
	`days_off` json NOT NULL,
	`min_calls_per_day` int NOT NULL DEFAULT 50,
	`max_calls_per_day` int NOT NULL DEFAULT 100,
	`monthly_target` decimal(12, 2) NOT NULL DEFAULT 0,
	`invite_token` varchar(80),
	`reset_token` varchar(80),
	`reset_expires_at` datetime(3),
	`booking_slug` varchar(60),
	`notify_by_email` boolean NOT NULL DEFAULT true,
	`twilio_number` varchar(20),
	`calendar_email` varchar(200),
	`active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`),
	CONSTRAINT `users_booking_slug_unique` UNIQUE(`booking_slug`)
);
--> statement-breakpoint
CREATE TABLE `voicemails` (
	`id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`lead_id` varchar(36),
	`from_number` varchar(20) NOT NULL,
	`recording_url` text NOT NULL,
	`duration_sec` int NOT NULL DEFAULT 0,
	`heard_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `voicemails_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD CONSTRAINT `automation_runs_automation_id_automations_id_fk` FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD CONSTRAINT `automation_runs_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD CONSTRAINT `automation_runs_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD CONSTRAINT `automation_runs_policy_id_policies_id_fk` FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automations` ADD CONSTRAINT `automations_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calls` ADD CONSTRAINT `calls_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calls` ADD CONSTRAINT `calls_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customers` ADD CONSTRAINT `customers_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customers` ADD CONSTRAINT `customers_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customers` ADD CONSTRAINT `customers_agent_id_users_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `device_tokens` ADD CONSTRAINT `device_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `favorites` ADD CONSTRAINT `favorites_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `favorites` ADD CONSTRAINT `favorites_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_runs` ADD CONSTRAINT `job_runs_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lead_sources` ADD CONSTRAINT `lead_sources_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_agent_id_users_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_last_call_by_id_users_id_fk` FOREIGN KEY (`last_call_by_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_locked_by_id_users_id_fk` FOREIGN KEY (`locked_by_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_bad_by_id_users_id_fk` FOREIGN KEY (`bad_by_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `live_calls` ADD CONSTRAINT `live_calls_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `live_calls` ADD CONSTRAINT `live_calls_agent_id_users_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `live_calls` ADD CONSTRAINT `live_calls_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notes` ADD CONSTRAINT `notes_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notes` ADD CONSTRAINT `notes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `phone_numbers` ADD CONSTRAINT `phone_numbers_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `phone_numbers` ADD CONSTRAINT `phone_numbers_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policies` ADD CONSTRAINT `policies_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policies` ADD CONSTRAINT `policies_agent_id_users_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_policy_id_policies_id_fk` FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_agent_id_users_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `speed_dial_contacts` ADD CONSTRAINT `speed_dial_contacts_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `speed_dial_contacts` ADD CONSTRAINT `speed_dial_contacts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_emails` ADD CONSTRAINT `team_emails_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `templates` ADD CONSTRAINT `templates_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voicemails` ADD CONSTRAINT `voicemails_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voicemails` ADD CONSTRAINT `voicemails_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voicemails` ADD CONSTRAINT `voicemails_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `appointments_user_starts_idx` ON `appointments` (`user_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `runs_due_idx` ON `automation_runs` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `runs_lead_idx` ON `automation_runs` (`lead_id`);--> statement-breakpoint
CREATE INDEX `calls_lead_idx` ON `calls` (`lead_id`);--> statement-breakpoint
CREATE INDEX `calls_user_started_idx` ON `calls` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `leads_agency_stage_idx` ON `leads` (`agency_id`,`stage`);--> statement-breakpoint
CREATE INDEX `leads_agent_idx` ON `leads` (`agent_id`);--> statement-breakpoint
CREATE INDEX `leads_phone_idx` ON `leads` (`phone`);--> statement-breakpoint
CREATE INDEX `leads_created_idx` ON `leads` (`created_at`);--> statement-breakpoint
CREATE INDEX `leads_bad_idx` ON `leads` (`agency_id`,`bad_reason`);--> statement-breakpoint
CREATE INDEX `live_calls_agency_status_idx` ON `live_calls` (`agency_id`,`status`);--> statement-breakpoint
CREATE INDEX `live_calls_agent_sid_idx` ON `live_calls` (`agent_call_sid`);--> statement-breakpoint
CREATE INDEX `messages_lead_idx` ON `messages` (`lead_id`);--> statement-breakpoint
CREATE INDEX `notes_lead_idx` ON `notes` (`lead_id`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`agency_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `phone_numbers_user_idx` ON `phone_numbers` (`user_id`);--> statement-breakpoint
CREATE INDEX `policies_renewal_idx` ON `policies` (`renewal_date`);--> statement-breakpoint
CREATE INDEX `sales_agency_sold_idx` ON `sales` (`agency_id`,`sold_at`);--> statement-breakpoint
CREATE INDEX `tasks_user_idx` ON `tasks` (`user_id`,`done_at`);--> statement-breakpoint
CREATE INDEX `users_agency_idx` ON `users` (`agency_id`);--> statement-breakpoint
CREATE INDEX `voicemails_user_idx` ON `voicemails` (`user_id`,`created_at`);