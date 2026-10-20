CREATE TABLE IF NOT EXISTS "call_recordings" (
	"call_sid" varchar(64) PRIMARY KEY NOT NULL,
	"recording_sid" varchar(64) NOT NULL,
	"url" text NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agencies" ALTER COLUMN "settings" SET DEFAULT '{"assignRule":"round_robin","skipOffline":true,"skipAtLimit":true,"attemptsDay1":3,"attemptsPerDay":1,"maxAttempts":8,"retryHours":2,"requoteMonths":5,"autoRequote":true,"autoRecycle":true,"teamTarget":240000,"teamTargetVisible":true,"businessDays":["Mon","Tue","Wed","Thu","Fri"],"businessOpen":"08:00","businessClose":"18:00","timezone":"America/Chicago","reviewLinks":{"google":"","facebook":"","yelp":""},"optOutKeywords":["STOP","UNSUBSCRIBE","CANCEL","END","QUIT"],"customFields":[{"key":"dob","label":"Date of birth","type":"date"},{"key":"zip","label":"ZIP code","type":"text"},{"key":"carrier","label":"Current carrier","type":"text"}],"reminderMinutes":10,"screeningQuestions":["What ZIP code is the property or vehicle in?","Who insures you now?","When does your current policy renew?"]}'::jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "twilio_sid" varchar(64);--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcript_status" varchar(20);--> statement-breakpoint
ALTER TABLE "lead_sources" ADD COLUMN "webhook_key" varchar(48);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_id" varchar(80);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "twilio_number" varchar(20);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_webhook_key_unique" UNIQUE("webhook_key");