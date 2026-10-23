CREATE TABLE "orders_archive" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
COMMENT ON TABLE "orders" IS 'retired: readers removed in 2026.10.1, drop after one release cycle';
