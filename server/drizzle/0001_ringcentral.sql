CREATE TABLE `ringcentral_connections` (
	`user_id` varchar(36) NOT NULL,
	`agency_id` varchar(36) NOT NULL,
	`account_id` varchar(32) NOT NULL,
	`extension_id` varchar(32) NOT NULL,
	`extension_number` varchar(20),
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`access_expires_at` datetime(3) NOT NULL,
	`refresh_expires_at` datetime(3) NOT NULL,
	`subscription_id` varchar(64),
	`subscription_expires_at` datetime(3),
	`call_log_synced_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ringcentral_connections_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `phone_numbers` ADD `provider` varchar(12) DEFAULT 'twilio' NOT NULL;--> statement-breakpoint
ALTER TABLE `phone_numbers` ADD `rc_extension_id` varchar(32);--> statement-breakpoint
ALTER TABLE `ringcentral_connections` ADD CONSTRAINT `ringcentral_connections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ringcentral_connections` ADD CONSTRAINT `ringcentral_connections_agency_id_agencies_id_fk` FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `rc_connections_extension_idx` ON `ringcentral_connections` (`extension_id`);