import { describe, expect, it } from "vitest";
import { DrizzleRepositoryError } from "./repository-error.js";
import { createDrizzleWebhookEventStore, shipWebhookEventsTable } from "./webhook-events.js";

const database = { transaction: () => undefined } as never;

describe("createDrizzleWebhookEventStore", () => {
  it("builds the events table with byte-exact bodies and a retention index", () => {
    const table = shipWebhookEventsTable("custom_webhook_events");
    expect(Object.keys(table)).toEqual(
      expect.arrayContaining(["id", "webhookId", "receivedAt", "body", "outboxRecordId"]),
    );
    expect(() => shipWebhookEventsTable("Bad-Name")).toThrow(
      expect.objectContaining({ code: "SHIP_DRIZZLE_WEBHOOK_EVENTS_INVALID" }),
    );
  });

  it("validates its definition", () => {
    expect(() => createDrizzleWebhookEventStore(null as never)).toThrow(DrizzleRepositoryError);
    expect(() => createDrizzleWebhookEventStore({ database: {} as never })).toThrow(
      expect.objectContaining({ field: "database" }),
    );
    expect(() => createDrizzleWebhookEventStore({ database, outboxTable: 5 as never })).toThrow(
      expect.objectContaining({ field: "outboxTable" }),
    );
    const store = createDrizzleWebhookEventStore({ database });
    expect(store.kind).toBe("ship.webhook-event-store");
    expect(store.adapter).toBe("drizzle");
  });

  it("refuses to record or link outside a unit-of-work scope", async () => {
    const store = createDrizzleWebhookEventStore({ database });
    await expect(
      store.record(
        {},
        {
          id: "e",
          webhookId: "w",
          provider: "p",
          requestId: "r",
          receivedAt: new Date(),
          headers: {},
          body: new Uint8Array(),
        },
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: "SHIP_DRIZZLE_WEBHOOK_EVENTS_SCOPE_INVALID" }),
    );
    await expect(store.link({}, "e", "r")).rejects.toThrow(DrizzleRepositoryError);
  });
});
