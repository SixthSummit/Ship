ALTER TABLE "orders" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "note" text;
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "carrier" text NOT NULL;
