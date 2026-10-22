ALTER TABLE "orders" ADD COLUMN "currency" text;
--> statement-breakpoint
UPDATE "orders" SET "currency" = 'USD' WHERE "currency" IS NULL;
