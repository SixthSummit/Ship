CREATE TABLE "ship_idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'in-flight' NOT NULL,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ship_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"discard_reason" text
);
--> statement-breakpoint
CREATE TABLE "ship_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text,
	"request_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"content_type" text,
	"headers" jsonb NOT NULL,
	"body" "bytea" NOT NULL,
	"outbox_record_id" uuid
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"state" text NOT NULL,
	"effort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ship_outbox_dedupe_idx" ON "ship_outbox" USING btree ("outbox_id","intent_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "ship_outbox_due_idx" ON "ship_outbox" USING btree ("outbox_id","status","available_at");--> statement-breakpoint
CREATE INDEX "ship_outbox_pending_idx" ON "ship_outbox" USING btree ("outbox_id","available_at","created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "ship_outbox_lease_idx" ON "ship_outbox" USING btree ("outbox_id","lease_expires_at") WHERE status = 'claimed';--> statement-breakpoint
CREATE INDEX "ship_webhook_events_retention_idx" ON "ship_webhook_events" USING btree ("webhook_id","received_at");