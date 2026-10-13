import { getTableColumns } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { baseFields, baseFieldsTimestampsOnly } from "./baseFields.js";

/**
 * `baseFields` is a static column-builder record, not runtime logic — these
 * tests pin its shape so accidental renames or drops cause CI noise. The
 * downstream story (auto-stamping `createdBy`/`updatedBy`, soft-delete
 * filtering, $onUpdate for updatedAt) is covered by `DrizzleEntityService`'s
 * integration tests against testcontainers.
 */
describe("baseFields", () => {
  const table = pgTable("widgets", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    ...baseFields,
  });
  const columns = getTableColumns(table);

  it("exposes the v4 audit columns", () => {
    expect(Object.keys(baseFields).sort()).toEqual([
      "createdAt",
      "createdBy",
      "deletedAt",
      "updatedAt",
      "updatedBy",
    ]);
  });

  it("can be spread into a pgTable definition with snake_case DB names", () => {
    expect(columns.createdAt.name).toBe("created_at");
    expect(columns.updatedAt.name).toBe("updated_at");
    expect(columns.deletedAt.name).toBe("deleted_at");
    expect(columns.createdBy.name).toBe("created_by");
    expect(columns.updatedBy.name).toBe("updated_by");
  });

  it("the timestamps-only variant excludes the attribution columns", () => {
    expect(Object.keys(baseFieldsTimestampsOnly).sort()).toEqual([
      "createdAt",
      "deletedAt",
      "updatedAt",
    ]);
  });

  it("createdAt and updatedAt are not-null", () => {
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("deletedAt, createdBy, and updatedBy are nullable", () => {
    expect(columns.deletedAt.notNull).toBe(false);
    expect(columns.createdBy.notNull).toBe(false);
    expect(columns.updatedBy.notNull).toBe(false);
  });
});
