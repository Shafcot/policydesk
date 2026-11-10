ALTER TABLE "agencies" ALTER COLUMN "brand_name" SET DEFAULT 'Bliss';--> statement-breakpoint
UPDATE "agencies" SET "brand_name" = 'Bliss' WHERE "brand_name" IN ('Policy-desk CRM', 'PolicyDesk', 'Policy-desk');
