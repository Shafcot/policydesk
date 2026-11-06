ALTER TABLE "leads" ADD COLUMN "bad_reason" varchar(16);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "bad_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "bad_by_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_bad_by_id_users_id_fk" FOREIGN KEY ("bad_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_bad_idx" ON "leads" USING btree ("agency_id","bad_reason");