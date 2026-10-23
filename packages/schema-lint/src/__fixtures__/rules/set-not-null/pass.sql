ALTER TABLE "customers" ADD CONSTRAINT "customers_display_name_not_null" CHECK ("display_name" IS NOT NULL) NOT VALID;
