import type { SQL } from "drizzle-orm";
import { PgDialect, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { defineAuditColumns, defineSoftDeleteColumns } from "./field-policies.js";

const records = pgTable("repository_policy_records", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  createdDate: timestamp("createdDate", { withTimezone: true }).notNull(),
  updatedDate: timestamp("updatedDate", { withTimezone: true }).notNull(),
  deletedDate: timestamp("deletedDate", { withTimezone: true }),
  createdByUserId: uuid("createdByUserId"),
  updatedByUserId: uuid("updatedByUserId"),
});

const auditNames = {
  createdAt: "createdDate",
  updatedAt: "updatedDate",
  createdBy: "createdByUserId",
  updatedBy: "updatedByUserId",
} as const;
const softDeleteNames = {
  deletedAt: "deletedDate",
  updatedAt: "updatedDate",
  actor: "updatedByUserId",
} as const;
const dialect = new PgDialect();

describe("repository field policies", () => {
  it("maps creation and update audit values onto consumer column names", () => {
    const policy = defineAuditColumns(records, auditNames);
    const at = new Date("2026-09-03T12:00:00.000Z");
    const actorId = "11111111-1111-4111-8111-111111111111";

    expect(policy.created({ at, actorId })).toEqual({
      createdDate: at,
      createdByUserId: actorId,
    });
    expect(policy.updated({ at, actorId })).toEqual({
      updatedDate: at,
      updatedByUserId: actorId,
    });
    expect(policy.created({ at })).toEqual({ createdDate: at });
    expect(policy).toMatchObject({ kind: "ship.drizzle.audit-columns", names: auditNames });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.names)).toBe(true);
    expect(Object.isFrozen(policy.updated({ at }))).toBe(true);
  });

  it("creates explicit active/deleted predicates and reversible values", () => {
    const policy = defineSoftDeleteColumns(records, softDeleteNames);
    const at = new Date("2026-09-03T13:00:00.000Z");
    const actorId = "22222222-2222-4222-8222-222222222222";

    expect(render(policy.active())).toContain('"deletedDate" is null');
    expect(render(policy.deleted())).toContain('"deletedDate" is not null');
    expect(policy.deletedValues({ at, actorId })).toEqual({
      deletedDate: at,
      updatedDate: at,
      updatedByUserId: actorId,
    });
    expect(policy.restoredValues({ at, actorId })).toEqual({
      deletedDate: null,
      updatedDate: at,
      updatedByUserId: actorId,
    });
    expect(policy.deletedValues({ at })).toEqual({ deletedDate: at, updatedDate: at });
    expect(policy).toMatchObject({ kind: "ship.drizzle.soft-delete-columns" });
  });

  it.each([
    ["audit", null, "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID", undefined],
    ["audit", {}, "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID", "createdAt"],
    [
      "audit",
      { createdAt: "missing", updatedAt: "updatedDate" },
      "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID",
      "createdAt",
    ],
    [
      "audit",
      { createdAt: "createdDate", updatedAt: "createdDate" },
      "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID",
      "updatedAt",
    ],
    [
      "audit",
      { createdAt: "createdDate", updatedAt: "updatedDate", mystery: "title" },
      "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID",
      "mystery",
    ],
    ["soft", [], "SHIP_DRIZZLE_SOFT_DELETE_COLUMNS_INVALID", undefined],
    ["soft", { deletedAt: "missing" }, "SHIP_DRIZZLE_SOFT_DELETE_COLUMNS_INVALID", "deletedAt"],
  ])("rejects invalid %s mappings %#", (kind, names, code, field) => {
    const define = kind === "audit" ? defineAuditColumns : defineSoftDeleteColumns;
    expect(() => define(records, names as never)).toThrowError(
      expect.objectContaining({ code, field }),
    );
  });

  it.each([
    ["audit", defineAuditColumns(records, auditNames)],
    ["soft", defineSoftDeleteColumns(records, softDeleteNames)],
  ])("rejects an invalid %s stamp", (kind, policy) => {
    const write =
      kind === "audit"
        ? (policy as ReturnType<typeof defineAuditColumns>).updated
        : (policy as ReturnType<typeof defineSoftDeleteColumns>).deletedValues;
    expect(() => write(null as never)).toThrowError(
      expect.objectContaining({
        code:
          kind === "audit"
            ? "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID"
            : "SHIP_DRIZZLE_SOFT_DELETE_COLUMNS_INVALID",
        field: "at",
      }),
    );
  });
});

function render(expression: SQL): string {
  return dialect.sqlToQuery(expression).sql;
}
