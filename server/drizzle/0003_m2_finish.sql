CREATE TABLE IF NOT EXISTS "team_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid,
	"to" varchar(200) NOT NULL,
	"subject" varchar(240) NOT NULL,
	"body" text NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_token" varchar(80);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "booking_slug" varchar(60);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_by_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_emails" ADD CONSTRAINT "team_emails_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_booking_slug_unique" UNIQUE("booking_slug");