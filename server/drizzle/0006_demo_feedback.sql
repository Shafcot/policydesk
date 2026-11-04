CREATE TABLE IF NOT EXISTS "live_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"direction" varchar(3) NOT NULL,
	"status" varchar(12) DEFAULT 'ringing' NOT NULL,
	"agent_id" uuid,
	"agent_call_sid" varchar(64),
	"log_call_sid" varchar(64),
	"customer_call_sid" varchar(64),
	"customer_number" varchar(20) NOT NULL,
	"lead_id" uuid,
	"conference_sid" varchar(64),
	"transfer" jsonb,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "speed_dial_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid,
	"name" varchar(120) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"note" varchar(200),
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voicemails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid,
	"lead_id" uuid,
	"from_number" varchar(20) NOT NULL,
	"recording_url" text NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"heard_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agencies" ALTER COLUMN "settings" SET DEFAULT '{"assignRule":"round_robin","skipOffline":true,"skipAtLimit":true,"attemptsDay1":3,"attemptsPerDay":1,"maxAttempts":8,"retryHours":2,"requoteMonths":5,"autoRequote":true,"autoRecycle":true,"teamTarget":0,"teamTargetVisible":true,"businessDays":["Mon","Tue","Wed","Thu","Fri"],"businessOpen":"08:00","businessClose":"18:00","timezone":"America/Chicago","reviewLinks":{"google":"","facebook":"","yelp":""},"optOutKeywords":["STOP","UNSUBSCRIBE","CANCEL","END","QUIT"],"customFields":[{"key":"dob","label":"Date of birth","type":"date"},{"key":"zip","label":"ZIP code","type":"text"},{"key":"carrier","label":"Current carrier","type":"text"}],"reminderMinutes":10,"screeningQuestions":["What ZIP code is the property or vehicle in?","Who insures you now?","When does your current policy renew?"],"agentTargetsVisible":false,"targetStartDay":1,"carriers":[],"callScripts":{"*":{"opening":"Hi {first}, this is {agent} with {agency}. You asked for a {line} insurance quote, and I can get you a few options in about five minutes. Is now still a good time?","objections":[{"q":"I’m happy with my current carrier.","a":"That’s great to hear. Most of my clients were too. It takes five minutes to compare, and if we can’t beat your coverage and price, you keep what you have. Who are you with right now?"},{"q":"Just send me something by email.","a":"Happy to. To make sure the numbers are accurate, I need two or three details first. It’ll take about two minutes. What’s the ZIP code?"},{"q":"It’s too expensive.","a":"Understood. Let’s look at deductibles and discounts together. Bundling and paperless often bring the price down. What monthly price were you hoping for?"},{"q":"I need to talk to my spouse.","a":"Of course. Would it help if I booked a quick call when you’re both available? What time works best?"}]}},"phoneMenu":{"enabled":false,"mainNumber":"","greeting":"Thanks for calling {agency}.","options":[],"defaultUserIds":[],"afterHoursMessage":"Thanks for calling {agency}. We’re closed right now. Please leave a message and we’ll call you back, or book a time with the link we’re texting you."},"missedCallText":"Hi, this is {agency}. Sorry we missed your call! Book a time that suits you here: {booking}. Reply STOP to opt out.","missedCallTextOn":true,"aiConversations":true,"aiMaxTurns":8}'::jsonb;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "outlook_event_id" varchar(400);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "outlook_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ai_status" varchar(12);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ai_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "calendar_email" varchar(200);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_calls" ADD CONSTRAINT "live_calls_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_calls" ADD CONSTRAINT "live_calls_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_calls" ADD CONSTRAINT "live_calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "speed_dial_contacts" ADD CONSTRAINT "speed_dial_contacts_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "speed_dial_contacts" ADD CONSTRAINT "speed_dial_contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voicemails" ADD CONSTRAINT "voicemails_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voicemails" ADD CONSTRAINT "voicemails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voicemails" ADD CONSTRAINT "voicemails_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_calls_agency_status_idx" ON "live_calls" USING btree ("agency_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_calls_agent_sid_idx" ON "live_calls" USING btree ("agent_call_sid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voicemails_user_idx" ON "voicemails" USING btree ("user_id","created_at");--> statement-breakpoint
-- "Left message" becomes "Sent text message" (client feedback). Renaming keeps existing call history.
ALTER TYPE "public"."call_result" RENAME VALUE 'left_msg' TO 'sent_text';--> statement-breakpoint
UPDATE "automations" SET "trigger_config" = replace("trigger_config"::text, '"left_msg"', '"sent_text"')::jsonb, "steps" = replace("steps"::text, '"left_msg"', '"sent_text"')::jsonb WHERE "trigger_config"::text LIKE '%left_msg%' OR "steps"::text LIKE '%left_msg%';
