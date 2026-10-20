CREATE TABLE IF NOT EXISTS "favorites" (
	"user_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_lead_id_pk" PRIMARY KEY("user_id","lead_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"name" varchar(80) NOT NULL,
	"subject" varchar(240),
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agencies" ALTER COLUMN "settings" SET DEFAULT '{"assignRule":"round_robin","skipOffline":true,"skipAtLimit":true,"attemptsDay1":3,"attemptsPerDay":1,"maxAttempts":8,"retryHours":2,"requoteMonths":5,"autoRequote":true,"autoRecycle":true,"teamTarget":240000,"teamTargetVisible":true,"businessDays":["Mon","Tue","Wed","Thu","Fri"],"businessOpen":"08:00","businessClose":"18:00","timezone":"America/Chicago","reviewLinks":{"google":"","facebook":"","yelp":""},"optOutKeywords":["STOP","UNSUBSCRIBE","CANCEL","END","QUIT"],"customFields":[{"key":"dob","label":"Date of birth","type":"date"},{"key":"zip","label":"ZIP code","type":"text"},{"key":"carrier","label":"Current carrier","type":"text"}],"reminderMinutes":10}'::jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status" varchar(20) DEFAULT 'sent' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "favorites" ADD CONSTRAINT "favorites_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "templates" ADD CONSTRAINT "templates_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
