import { getTableColumns } from "drizzle-orm";
import { getTableConfig, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { tenantScoped } from "./tenantScoped.js";

/**
 * `tenantScoped(tenants)` is a static column-builder factory (the opt-in
 * sibling of `baseFields`). These tests pin its shape AND its FK wiring (target
 * + `onDelete: "restrict"`) via Drizzle's `getTableConfig`, so a schema-only
 * regression (e.g. `onDelete: "cascade"`) fails the unit suite, not just the
 * Docker-only integration test. SQL-level enforcement is additionally exercised
 * in the accounts module's tenancy integration test.
 */
describe("tenantScoped", () => {
  // Stand-in `tenants` root table — the consumer owns the real one.
  const tenants = pgTable("tenants", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
  });

  const projects = pgTable("projects", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    ...tenantScoped(tenants),
  });
  const columns = getTableColumns(projects);

  it("contributes exactly one `tenantId` column", () => {
    expect(Object.keys(tenantScoped(tenants))).toEqual(["tenantId"]);
  });

  it("maps to a snake_case `tenant_id` column of uuid type", () => {
    expect(columns.tenantId.name).toBe("tenant_id");
    expect(columns.tenantId.getSQLType()).toBe("uuid");
  });

  it("is NOT NULL — a scoped row must belong to a tenant", () => {
    expect(columns.tenantId.notNull).toBe(true);
  });

  it("wires a foreign key to the tenants table with onDelete: restrict", () => {
    const { foreignKeys } = getTableConfig(projects);
    const fk = foreignKeys.find((f) => f.reference().columns.some((c) => c.name === "tenant_id"));
    expect(fk, "tenant_id should carry a foreign key").toBeDefined();
    expect(fk!.onDelete).toBe("restrict");
    const ref = fk!.reference();
    expect(ref.foreignTable).toBe(tenants);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
  });

  it("returns a fresh column object per call (no shared builder state)", () => {
    const a = tenantScoped(tenants);
    const b = tenantScoped(tenants);
    expect(a).not.toBe(b);
    expect(a.tenantId).not.toBe(b.tenantId);
  });
});
