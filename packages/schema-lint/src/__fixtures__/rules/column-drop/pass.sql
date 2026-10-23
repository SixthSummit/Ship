ALTER TABLE "orders" DROP CONSTRAINT "orders_customer_id_customers_id_fk";
--> statement-breakpoint
COMMENT ON COLUMN "orders"."legacy_flag" IS 'retired: drop after release 2026.10.1';
