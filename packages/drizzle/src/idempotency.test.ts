import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import { createDrizzleIdempotencyStore, shipIdempotencyTable } from "./idempotency.js";

const database = { transaction: async () => undefined } as unknown as NodePgDatabase<
  Record<string, never>
>;

describe("createDrizzleIdempotencyStore", () => {
  it("creates a frozen store with a default or explicit table", () => {
    const table = shipIdempotencyTable("custom_keys");
    const store = createDrizzleIdempotencyStore({ database, table });

    expect(store).toMatchObject({ kind: "ship.idempotency-store", adapter: "drizzle", table });
    expect(Object.isFrozen(store)).toBe(true);
    expect(createDrizzleIdempotencyStore({ database }).table).toBeDefined();
  });

  it.each([
    ["non-object", undefined, undefined],
    ["missing database", { database: null }, "database"],
    ["bad table", { database, table: 3 }, "table"],
  ])("rejects %s definitions", (_name, definition, field) => {
    expect(() =>
      (createDrizzleIdempotencyStore as (value: unknown) => unknown)(definition),
    ).toThrowError(expect.objectContaining({ code: "SHIP_DRIZZLE_IDEMPOTENCY_INVALID", field }));
    expect(() => shipIdempotencyTable("Bad Name")).toThrowError(
      expect.objectContaining({ code: "SHIP_DRIZZLE_IDEMPOTENCY_INVALID" }),
    );
  });
});
