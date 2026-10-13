/**
 * `isQueryOperator` is the public refinement helper consumers use when
 * parsing untrusted input (e.g. building a query-string parser at the
 * HTTP boundary). The DSL itself is exercised end-to-end through
 * `buildWhere.test.ts`; this file covers the type-guard contract.
 */

import { describe, expect, it } from "vitest";
import { isQueryOperator, QUERY_OPERATORS } from "./QueryOptions.js";

describe("isQueryOperator", () => {
  it("returns true for every canonical operator", () => {
    for (const op of QUERY_OPERATORS) {
      expect(isQueryOperator(op)).toBe(true);
    }
  });

  it("returns false for non-string inputs", () => {
    expect(isQueryOperator(undefined)).toBe(false);
    expect(isQueryOperator(null)).toBe(false);
    expect(isQueryOperator(0)).toBe(false);
    expect(isQueryOperator(false)).toBe(false);
    expect(isQueryOperator({})).toBe(false);
    expect(isQueryOperator([])).toBe(false);
  });

  it("returns false for unknown operator strings", () => {
    expect(isQueryOperator("contains")).toBe(false);
    expect(isQueryOperator("EQ")).toBe(false); // case-sensitive
    expect(isQueryOperator("")).toBe(false);
  });

  it("QUERY_OPERATORS contains the documented set", () => {
    // Tripwire — if a contributor adds or removes an operator, this
    // test forces them to update the public docs (cursor rule
    // api.mdc lists the canonical set).
    expect([...QUERY_OPERATORS].sort()).toEqual([
      "eq",
      "gt",
      "gte",
      "ilike",
      "in",
      "isNull",
      "like",
      "lt",
      "lte",
      "ne",
    ]);
  });
});
