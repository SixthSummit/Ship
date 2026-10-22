import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import { createDrizzleMailLedger, shipMailSendsTable } from "./mail-ledger.js";

const database = { transaction: async () => undefined } as unknown as NodePgDatabase<
  Record<string, never>
>;

describe("createDrizzleMailLedger", () => {
  it("creates a frozen ledger with a default or explicit table", () => {
    const table = shipMailSendsTable("custom_mail_sends");
    const ledger = createDrizzleMailLedger({ database, table });

    expect(ledger).toMatchObject({ kind: "ship.mail-ledger", adapter: "drizzle", table });
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(createDrizzleMailLedger({ database }).table).toBeDefined();
  });

  it.each([
    ["non-object", undefined, undefined],
    ["missing database", { database: null }, "database"],
    ["bad table", { database, table: 3 }, "table"],
  ])("rejects %s definitions", (_name, definition, field) => {
    expect(() =>
      (createDrizzleMailLedger as (value: unknown) => unknown)(definition),
    ).toThrowError(expect.objectContaining({ code: "SHIP_DRIZZLE_MAIL_LEDGER_INVALID", field }));
    expect(() => shipMailSendsTable("Bad Name")).toThrowError(
      expect.objectContaining({ code: "SHIP_DRIZZLE_MAIL_LEDGER_INVALID" }),
    );
  });
});
