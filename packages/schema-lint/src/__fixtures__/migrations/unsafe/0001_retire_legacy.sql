-- ship-schema-lint: allow column-drop readers removed in release 2026.10.1 and the column was archived to cold storage
ALTER TABLE "orders" DROP COLUMN "legacy_flag";
--> statement-breakpoint
ALTER TABLE "orders" RENAME COLUMN "total_cents" TO "amount_cents";
--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");
