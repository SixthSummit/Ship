import {
  shipIdempotencyTable,
  shipJobControlTable,
  shipJobRunsTable,
  shipJobStateTable,
  shipMailSendsTable,
  shipOutboxTable,
  shipStorageIntentsTable,
  shipStorageObjectsTable,
  shipStoragePurgesTable,
  shipWebhookEventsTable,
} from "@sixthsummit/ship-drizzle";
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
});

export const workItems = pgTable("work_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  effort: integer("effort").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const reportRequests = pgTable("report_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull(),
  requestedBy: text("requested_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Rich text documents: the sanitized document model (`body`, jsonb) and its
 * plain-text projection (`body_text`) for search and previews. Embedded
 * images are `ship_storage_objects` rows owned by `<tenant>/document/<id>`.
 */
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  title: text("title").notNull(),
  body: jsonb("body").notNull(),
  bodyText: text("body_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Framework-owned tables the application includes in its own migrations. */
export const reportsOutboxTable = shipOutboxTable();
export const idempotencyKeys = shipIdempotencyTable();
export const webhookEventsTable = shipWebhookEventsTable();
/** The PostgreSQL job backend's run ledger, schedule state and (opt-in) console pause control. */
export const jobRuns = shipJobRunsTable();
export const jobState = shipJobStateTable();
export const jobControl = shipJobControlTable();
/** Managed storage bookkeeping: intents, objects and the purge ledger (ADR-0022). */
export const storageIntents = shipStorageIntentsTable();
export const storageObjects = shipStorageObjectsTable();
export const storagePurges = shipStoragePurgesTable();
export const mailSendsTable = shipMailSendsTable();

export const portfolioSchema = {
  projects,
  workItems,
  reportRequests,
  documents,
  reportsOutboxTable,
  idempotencyKeys,
  webhookEventsTable,
  jobRuns,
  jobState,
  jobControl,
  storageIntents,
  storageObjects,
  storagePurges,
  mailSendsTable,
};
