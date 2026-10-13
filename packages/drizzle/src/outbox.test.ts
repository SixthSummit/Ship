import { defineOutbox, effectDependency, outboxIntent } from "@sixthsummit/ship-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDrizzleOutbox, shipOutboxTable } from "./outbox.js";

const notifier = effectDependency<{ send(): Promise<void> }>("reports.notifier", {
  delivery: "immediate",
});
const outbox = defineOutbox({
  id: "reports.outbox",
  intents: {
    notify: outboxIntent({ payload: z.object({}), effect: notifier, perform: () => undefined }),
  },
});
const database = { transaction: async () => undefined } as unknown as NodePgDatabase<
  Record<string, never>
>;

describe("createDrizzleOutbox", () => {
  it("creates a frozen backend bound to one outbox and a table", () => {
    const table = shipOutboxTable("custom_outbox");
    const backend = createDrizzleOutbox({ outbox, database, table });

    expect(backend).toMatchObject({
      kind: "ship.outbox-backend",
      adapter: "drizzle",
      outboxId: "reports.outbox",
      table,
    });
    expect(Object.isFrozen(backend)).toBe(true);
    expect(createDrizzleOutbox({ outbox, database }).table).toBeDefined();
  });

  it("refuses to record outside a Drizzle unit-of-work scope", async () => {
    const backend = createDrizzleOutbox({ outbox, database });
    await expect(
      backend.record({ not: "a scope" }, [
        { intentId: "notify", payload: {}, availableAt: new Date() },
      ]),
    ).rejects.toMatchObject({
      name: "DrizzleRepositoryError",
      code: "SHIP_DRIZZLE_OUTBOX_SCOPE_INVALID",
      repositoryId: "reports.outbox",
    });
  });

  it("returns nothing when a dispatcher asks for an empty intent subset", async () => {
    const backend = createDrizzleOutbox({ outbox, database });
    await expect(backend.claimDue(new Date(), 5, 100, [])).resolves.toEqual([]);
  });

  it.each([
    ["non-object", null, undefined],
    ["missing outbox", { database }, "outbox"],
    ["missing database", { outbox, database: {} }, "database"],
    ["bad table", { outbox, database, table: "ship_outbox" }, "table"],
  ])("rejects %s definitions", (_name, definition, field) => {
    expect(() => (createDrizzleOutbox as (value: unknown) => unknown)(definition)).toThrowError(
      expect.objectContaining({ code: "SHIP_DRIZZLE_OUTBOX_INVALID", field }),
    );
  });

  it("rejects unsafe table names", () => {
    expect(() => shipOutboxTable("Ship-Outbox")).toThrowError(
      expect.objectContaining({ code: "SHIP_DRIZZLE_OUTBOX_INVALID" }),
    );
  });
});
