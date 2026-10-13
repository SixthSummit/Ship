import { type SQL, sql } from "drizzle-orm";
import { boolean, integer, PgDialect, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildWhere } from "./buildWhere.js";
import type { DslQueryFilter } from "./QueryOptions.js";

// A small fixture table covering varied column types.
const widgets = pgTable("widgets", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  count: integer("count").notNull(),
  active: boolean("active").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

type Widget = typeof widgets.$inferSelect;

const dialect = new PgDialect();

/**
 * Each test renders the produced expression to a parameterized SQL string +
 * params so we can assert against the actual fragment without coupling to
 * Drizzle's internal AST representation.
 */
function render(expr: SQL | undefined): { sql: string; params: unknown[] } | undefined {
  if (!expr) return undefined;
  const query = dialect.sqlToQuery(expr);
  return { sql: query.sql, params: [...query.params] };
}

describe("buildWhere", () => {
  it("returns undefined for an empty / undefined filter", () => {
    expect(buildWhere(widgets, undefined)).toBeUndefined();
    expect(buildWhere(widgets, {})).toBeUndefined();
  });

  it("treats a bare value as an eq shorthand", () => {
    const expr = buildWhere(widgets, { name: "alice" });
    const out = render(expr)!;
    expect(out.sql.toLowerCase()).toContain('"name"');
    expect(out.sql).toContain("=");
    expect(out.params).toEqual(["alice"]);
  });

  it("supports the eq operator explicitly", () => {
    const out = render(buildWhere(widgets, { name: { eq: "bob" } }))!;
    expect(out.sql).toContain("=");
    expect(out.params).toEqual(["bob"]);
  });

  it("supports ne / gt / gte / lt / lte", () => {
    const filter: DslQueryFilter<Widget> = {
      count: { gte: 5, lt: 100 },
      name: { ne: "skip" },
    };
    const out = render(buildWhere(widgets, filter))!;
    expect(out.sql).toMatch(/and/i);
    expect(out.params).toEqual(expect.arrayContaining([5, 100, "skip"]));
  });

  it("supports inArray", () => {
    const out = render(buildWhere(widgets, { count: { in: [1, 2, 3] } }))!;
    expect(out.sql.toLowerCase()).toContain("in");
    expect(out.params).toEqual([1, 2, 3]);
  });

  it("supports like and ilike", () => {
    const likeOut = render(buildWhere(widgets, { name: { like: "alice%" } }))!;
    expect(likeOut.sql.toLowerCase()).toContain("like");
    expect(likeOut.params).toEqual(["alice%"]);

    const ilikeOut = render(buildWhere(widgets, { name: { ilike: "ALICE%" } }))!;
    expect(ilikeOut.sql.toLowerCase()).toContain("ilike");
    expect(ilikeOut.params).toEqual(["ALICE%"]);
  });

  it("supports isNull true (IS NULL) and false (IS NOT NULL)", () => {
    const nullOut = render(buildWhere(widgets, { archivedAt: { isNull: true } }))!;
    expect(nullOut.sql.toLowerCase()).toContain("is null");
    expect(nullOut.params).toEqual([]);

    const notNullOut = render(buildWhere(widgets, { archivedAt: { isNull: false } }))!;
    expect(notNullOut.sql.toLowerCase()).toContain("is not null");
    expect(notNullOut.params).toEqual([]);
  });

  it("ANDs multiple columns together", () => {
    const expr = buildWhere(widgets, {
      name: { ilike: "%search%" },
      active: true,
      count: { gte: 1 },
    });
    const out = render(expr)!;
    // Three conditions → two AND junctions
    expect(out.sql.toLowerCase().match(/\band\b/g)).toHaveLength(2);
  });

  it("silently drops unknown columns (validation belongs upstream)", () => {
    const expr = buildWhere(widgets, {
      // @ts-expect-error — testing runtime drop of unknown keys
      bogus: { eq: "x" },
      name: "alice",
    });
    const out = render(expr)!;
    // Only the `name` condition should be present
    expect(out.params).toEqual(["alice"]);
    expect(out.sql.toLowerCase()).not.toContain("bogus");
  });

  it("ignores undefined column entries", () => {
    const expr = buildWhere(widgets, { name: undefined });
    expect(expr).toBeUndefined();
  });

  it("returns the single condition directly when only one column matches", () => {
    const expr = buildWhere(widgets, { name: "x" });
    expect(expr).toBeDefined();
    const out = render(expr)!;
    // No `AND` for a single condition
    expect(out.sql.toLowerCase()).not.toContain(" and ");
  });

  it("combines multiple operators on the same column with AND", () => {
    const expr = buildWhere(widgets, { count: { gte: 10, lte: 50, ne: 25 } });
    const out = render(expr)!;
    // Three operators on one column → two ANDs
    expect(out.sql.toLowerCase().match(/\band\b/g)).toHaveLength(2);
    expect(out.params).toEqual(expect.arrayContaining([10, 50, 25]));
  });

  it("handles Date values as bare-eq shorthand", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const expr = buildWhere(widgets, { archivedAt: at });
    const out = render(expr)!;
    // Drizzle's `sqlToQuery` produces an ISO string param for Date values
    // before the pg driver applies its own column-mapper. The exact form
    // (here: ISO-8601 with `T` and `Z`) is what reaches pg's parameterized
    // statement; asserting on it pins the integration shape.
    expect(out.params[0]).toBe(at.toISOString());
  });

  // Sanity: `sql` import keeps the test file aware of Drizzle's runtime tag
  it("imports drizzle's sql tag without crashing", () => {
    expect(typeof sql).toBe("function");
  });
});
