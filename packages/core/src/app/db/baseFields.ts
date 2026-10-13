import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Audit + soft-delete columns spread into every framework `pgTable` definition.
 *
 * The v4 standard column set, replacing v3's `createdDate` / `updatedDate` /
 * `deletedDate`. Renamed for consistency with industry convention (`*At` suffix
 * for timestamps, separate `*By` foreign keys for audit attribution).
 *
 * - `createdAt` / `updatedAt`: `timestamptz` defaulting to `now()`. `updatedAt`
 *   is also auto-updated on row modification at the SQL level (`$onUpdateFn`)
 *   so consumers don't have to remember to set it. Drizzle propagates this
 *   into `update()` calls.
 * - `deletedAt`: nullable timestamp. Soft-delete-aware services (see
 *   `DrizzleEntityService`) filter `isNull(deletedAt)` by default.
 * - `createdBy` / `updatedBy`: nullable UUIDs referencing the actor who
 *   created / last modified the row. Auto-stamped from `RequestContext.userId`
 *   by `DrizzleEntityService` lifecycle hooks.
 *
 * Usage:
 *
 * ```ts
 * import { pgTable, varchar } from "drizzle-orm/pg-core";
 * import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";
 *
 * export const accounts = pgTable("accounts", {
 *   id: uuid("id").primaryKey().defaultRandom(),
 *   email: varchar("email", { length: 255 }).notNull().unique(),
 *   ...baseFields,
 * });
 * ```
 */
export const baseFields = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
} as const;

/**
 * Subset for tables that need only the timestamps, not the actor columns
 * (e.g., system-generated rows where attribution is meaningless: rate-limit
 * logs, idempotency-key cache, OTel-like telemetry). Use sparingly — most
 * domain tables should use the full `baseFields`.
 */
export const baseFieldsTimestampsOnly = {
  createdAt: baseFields.createdAt,
  updatedAt: baseFields.updatedAt,
  deletedAt: baseFields.deletedAt,
} as const;

/**
 * Type alias representing the shape of a row that includes `baseFields`
 * (for use in service-level type constraints).
 */
export type BaseFields = {
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
};
