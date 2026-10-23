INSERT INTO "customers" ("id", "email") VALUES ('00000000-0000-4000-8000-000000000001', 'seed@example.com');
--> statement-breakpoint
UPDATE "orders" SET "legacy_flag" = false WHERE "legacy_flag" IS NULL;
