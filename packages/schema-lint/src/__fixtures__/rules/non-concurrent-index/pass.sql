CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_customer_id_idx" ON "orders" USING btree ("customer_id");
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_id_idx" ON "invoices" USING btree ("order_id");
