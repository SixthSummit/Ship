CREATE TABLE "ship_mail_sends" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"mailer_id" text NOT NULL,
	"message" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"delivered_to" jsonb NOT NULL,
	"intercepted" boolean DEFAULT false NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"last_error" text,
	"tenant_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "ship_mail_sends_message_idx" ON "ship_mail_sends" USING btree ("mailer_id","message","created_at");--> statement-breakpoint
CREATE INDEX "ship_mail_sends_recipients_idx" ON "ship_mail_sends" USING gin ("recipients");--> statement-breakpoint
CREATE INDEX "ship_mail_sends_tenant_idx" ON "ship_mail_sends" USING btree ("tenant_id","created_at");