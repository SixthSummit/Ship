CREATE TABLE "ship_job_control" (
	"job_id" text PRIMARY KEY NOT NULL,
	"paused_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ship_job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"input" jsonb,
	"key" text,
	"dedupe_key" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"discard_reason" text,
	"lease_expires_at" timestamp with time zone,
	"claim_token" text
);
--> statement-breakpoint
CREATE TABLE "ship_job_state" (
	"job_id" text PRIMARY KEY NOT NULL,
	"trigger" jsonb,
	"next_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ship_job_runs_claim_idx" ON "ship_job_runs" USING btree ("job_id","status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ship_job_runs_dedupe_idx" ON "ship_job_runs" USING btree ("job_id","dedupe_key") WHERE status in ('waiting', 'active');