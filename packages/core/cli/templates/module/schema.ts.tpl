import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";

/**
 * `{{namePlural}}` table — replace this skeleton with your domain
 * columns, then run `npm run db:generate` to emit the migration.
 *
 * The `baseFields` mixin supplies the audit-column set
 * (`id`, `createdAt`, `updatedAt`, `deletedAt`, `createdBy`,
 * `updatedBy`) — DrizzleEntityService auto-stamps them on insert /
 * update / soft-delete.
 */
export const {{nameCamelPlural}} = pgTable("{{namePlural}}", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  ...baseFields,
});

export type {{NameSingular}} = typeof {{nameCamelPlural}}.$inferSelect;
export type New{{NameSingular}} = typeof {{nameCamelPlural}}.$inferInsert;
