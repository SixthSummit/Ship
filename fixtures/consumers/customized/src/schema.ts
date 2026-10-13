import {
  shipIdempotencyTable,
  shipOutboxTable,
  shipWebhookEventsTable,
} from "@sixthsummit/ship-drizzle";
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

/** Framework-owned tables the application includes in its own migrations. */
export const reportsOutboxTable = shipOutboxTable();
export const idempotencyKeys = shipIdempotencyTable();
export const webhookEventsTable = shipWebhookEventsTable();

export const portfolioSchema = {
  projects,
  workItems,
  reportRequests,
  reportsOutboxTable,
  idempotencyKeys,
  webhookEventsTable,
};
