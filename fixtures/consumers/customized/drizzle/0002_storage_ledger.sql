CREATE TABLE "ship_storage_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attachment_id" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"actor_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"object_id" uuid,
	CONSTRAINT "ship_storage_intents_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "ship_storage_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attachment_id" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"uploaded_by" text NOT NULL,
	"owner_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"attached_at" timestamp with time zone,
	"variants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ship_storage_objects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "ship_storage_purges" (
	"object_id" uuid PRIMARY KEY NOT NULL,
	"keys" jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"purged_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ship_storage_intents_expiry_idx" ON "ship_storage_intents" USING btree ("expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "ship_storage_objects_owner_idx" ON "ship_storage_objects" USING btree ("attachment_id","owner_id") WHERE status = 'attached';--> statement-breakpoint
CREATE INDEX "ship_storage_objects_stale_idx" ON "ship_storage_objects" USING btree ("created_at") WHERE status = 'uploaded';