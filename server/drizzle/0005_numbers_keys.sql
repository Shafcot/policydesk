CREATE TABLE IF NOT EXISTS "integration_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"number" varchar(20) NOT NULL,
	"label" varchar(80),
	"user_id" uuid,
	"twilio_sid" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_numbers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "agencies" ALTER COLUMN "settings" SET DEFAULT '{"assignRule":"round_robin","skipOffline":true,"skipAtLimit":true,"attemptsDay1":3,"attemptsPerDay":1,"maxAttempts":8,"retryHours":2,"requoteMonths":5,"autoRequote":true,"autoRecycle":true,"teamTarget":0,"teamTargetVisible":true,"businessDays":["Mon","Tue","Wed","Thu","Fri"],"businessOpen":"08:00","businessClose":"18:00","timezone":"America/Chicago","reviewLinks":{"google":"","facebook":"","yelp":""},"optOutKeywords":["STOP","UNSUBSCRIBE","CANCEL","END","QUIT"],"customFields":[{"key":"dob","label":"Date of birth","type":"date"},{"key":"zip","label":"ZIP code","type":"text"},{"key":"carrier","label":"Current carrier","type":"text"}],"reminderMinutes":10,"screeningQuestions":["What ZIP code is the property or vehicle in?","Who insures you now?","When does your current policy renew?"]}'::jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_numbers_user_idx" ON "phone_numbers" USING btree ("user_id");--> statement-breakpoint
-- Numbers already set on users become pool numbers assigned to them.
INSERT INTO "phone_numbers" ("agency_id", "number", "user_id")
SELECT "agency_id", "twilio_number", "id" FROM "users" WHERE "twilio_number" IS NOT NULL ON CONFLICT ("number") DO NOTHING;
