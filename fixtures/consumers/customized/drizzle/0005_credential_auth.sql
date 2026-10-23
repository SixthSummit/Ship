CREATE TABLE "ship_auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email_verified_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"sessions_invalid_before" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ship_auth_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"account_id" uuid,
	"session_id" uuid,
	"request_id" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"details" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ship_auth_credentials" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"algorithm" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ship_auth_mfa_secrets" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_used_step" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ship_auth_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ship_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"mfa_state" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "ship_auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"payload" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ship_auth_credentials" ADD CONSTRAINT "ship_auth_credentials_account_id_ship_auth_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ship_auth_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ship_auth_mfa_secrets" ADD CONSTRAINT "ship_auth_mfa_secrets_account_id_ship_auth_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ship_auth_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ship_auth_recovery_codes" ADD CONSTRAINT "ship_auth_recovery_codes_account_id_ship_auth_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ship_auth_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ship_auth_sessions" ADD CONSTRAINT "ship_auth_sessions_account_id_ship_auth_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ship_auth_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ship_auth_tokens" ADD CONSTRAINT "ship_auth_tokens_account_id_ship_auth_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ship_auth_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ship_auth_accounts_email_idx" ON "ship_auth_accounts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "ship_auth_audit_account_idx" ON "ship_auth_audit_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ship_auth_audit_event_idx" ON "ship_auth_audit_events" USING btree ("event","created_at");--> statement-breakpoint
CREATE INDEX "ship_auth_recovery_codes_account_idx" ON "ship_auth_recovery_codes" USING btree ("account_id","code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ship_auth_sessions_hash_idx" ON "ship_auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ship_auth_sessions_account_idx" ON "ship_auth_sessions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ship_auth_tokens_hash_idx" ON "ship_auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ship_auth_tokens_account_idx" ON "ship_auth_tokens" USING btree ("account_id","purpose");