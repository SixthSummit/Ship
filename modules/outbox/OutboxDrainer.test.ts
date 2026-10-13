import { describe, expect, it, vi } from "vitest";
import { type EventHandler, eventHandlerRegistry } from "./handlers/EventHandler.js";
import { OutboxDrainer } from "./OutboxDrainer.js";
import type { OutboxEvent } from "./schema.js";
import type { OutboxEventService } from "./services/OutboxEventService.js";

function makeService(opts: {
  ready: OutboxEvent[];
  // claimedSubset: ids the service "wins" claims for; defaults to all
  claimedSubset?: (ids: string[]) => string[];
}): {
  service: OutboxEventService;
  calls: {
    findReadyToPublish: number;
    claimForProcessing: string[][];
    markPublished: string[];
    markFailed: Array<{ id: string; error: string }>;
    markForRetry: Array<{ id: string; error: string; attempts: number }>;
  };
} {
  const calls = {
    findReadyToPublish: 0,
    claimForProcessing: [] as string[][],
    markPublished: [] as string[],
    markFailed: [] as Array<{ id: string; error: string }>,
    markForRetry: [] as Array<{ id: string; error: string; attempts: number }>,
  };
  // After a successful runOnce we want subsequent passes (in
  // runUntilEmpty) to find nothing — drain consumes the queue.
  let consumed = false;
  const service: Partial<OutboxEventService> = {
    async findReadyToPublish() {
      calls.findReadyToPublish += 1;
      if (consumed) return [];
      consumed = true;
      return opts.ready;
    },
    async claimForProcessing(ids) {
      calls.claimForProcessing.push([...ids]);
      const subset = opts.claimedSubset ? opts.claimedSubset([...ids]) : [...ids];
      return subset;
    },
    async markPublished(id) {
      calls.markPublished.push(id);
      return null;
    },
    async markFailed(id, error) {
      calls.markFailed.push({ id, error });
      return null;
    },
    async markForRetry(id, error, attempts) {
      calls.markForRetry.push({ id, error, attempts });
      return null;
    },
  };
  return { service: service as OutboxEventService, calls };
}

function makeEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    eventId: "22222222-2222-4222-8222-222222222222",
    eventType: "account.created",
    eventVersion: 1,
    occurredAt: new Date(),
    aggregateType: "account",
    aggregateId: null,
    ownerUserId: null,
    tenantId: null,
    dedupeKey: null,
    correlationId: null,
    payload: { x: 1 },
    status: "pending",
    publishAttempts: 0,
    nextAttemptAt: null,
    publishedAt: null,
    lastError: null,
    maxRetries: 10,
    startedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

describe("OutboxDrainer", () => {
  describe("runOnce", () => {
    it("returns ZERO_RESULT when nothing is ready", async () => {
      const { service } = makeService({ ready: [] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry());
      const result = await drainer.runOnce();
      expect(result).toEqual({
        processed: 0,
        published: 0,
        failed: 0,
        retried: 0,
        skippedNoHandler: 0,
      });
    });

    it("publishes successfully when handler completes normally", async () => {
      const event = makeEvent();
      const handlerSpy = vi.fn(async () => undefined);
      const handler: EventHandler = {
        eventType: "account.created",
        handle: handlerSpy,
      };
      const { service, calls } = makeService({ ready: [event] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry(handler));

      const result = await drainer.runOnce();
      expect(result.processed).toBe(1);
      expect(result.published).toBe(1);
      expect(result.retried).toBe(0);
      expect(result.failed).toBe(0);
      expect(handlerSpy).toHaveBeenCalledOnce();
      expect(calls.markPublished).toEqual([event.id]);
    });

    it("retries when handler throws and budget remains", async () => {
      const event = makeEvent({ publishAttempts: 1, maxRetries: 5 });
      const handler: EventHandler = {
        eventType: "account.created",
        handle: async () => {
          throw new Error("transient downstream");
        },
      };
      const { service, calls } = makeService({ ready: [event] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry(handler));

      const result = await drainer.runOnce();
      expect(result.retried).toBe(1);
      expect(result.failed).toBe(0);
      expect(calls.markForRetry).toEqual([
        { id: event.id, error: "transient downstream", attempts: 1 },
      ]);
    });

    it("marks failed (terminal) when handler throws and budget exhausted", async () => {
      const event = makeEvent({ publishAttempts: 10, maxRetries: 10 });
      const handler: EventHandler = {
        eventType: "account.created",
        handle: async () => {
          throw new Error("permanent error");
        },
      };
      const { service, calls } = makeService({ ready: [event] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry(handler));

      const result = await drainer.runOnce();
      expect(result.failed).toBe(1);
      expect(result.retried).toBe(0);
      expect(calls.markFailed).toEqual([{ id: event.id, error: "permanent error" }]);
    });

    it("retries with 'no handler registered' message when no handler matches", async () => {
      const event = makeEvent({ publishAttempts: 0, maxRetries: 10 });
      const { service, calls } = makeService({ ready: [event] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry());

      const result = await drainer.runOnce();
      expect(result.skippedNoHandler).toBe(1);
      expect(result.retried).toBe(1);
      expect(calls.markForRetry).toHaveLength(1);
      expect(calls.markForRetry[0].error).toMatch(/no handler/i);
    });

    it("marks failed when no handler AND budget exhausted (op never going to fix it)", async () => {
      const event = makeEvent({ publishAttempts: 10, maxRetries: 10 });
      const { service, calls } = makeService({ ready: [event] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry());

      const result = await drainer.runOnce();
      expect(result.skippedNoHandler).toBe(1);
      expect(result.failed).toBe(1);
      expect(calls.markFailed).toHaveLength(1);
    });

    it("only processes events that this worker won the claim race for", async () => {
      const e1 = makeEvent({ id: "11111111-1111-4111-8111-111111111111" });
      const e2 = makeEvent({ id: "22222222-2222-4222-8222-222222222222" });
      const handler: EventHandler = {
        eventType: "account.created",
        handle: vi.fn(async () => undefined),
      };
      const { service, calls } = makeService({
        ready: [e1, e2],
        claimedSubset: () => [e1.id], // competing worker claimed e2
      });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry(handler));

      const result = await drainer.runOnce();
      expect(result.processed).toBe(1);
      expect(result.published).toBe(1);
      expect(calls.markPublished).toEqual([e1.id]);
    });

    it("forwards signal + metadata to handlers", async () => {
      const event = makeEvent();
      const handlerSpy = vi.fn(async () => undefined);
      const handler: EventHandler = {
        eventType: "account.created",
        handle: handlerSpy,
      };
      const { service } = makeService({ ready: [event] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry(handler));

      const ac = new AbortController();
      await drainer.runOnce({
        signal: ac.signal,
        metadata: { requestId: "r-1" },
      });

      const ctx = handlerSpy.mock.calls[0][1];
      expect(ctx.signal).toBe(ac.signal);
      expect(ctx.metadata).toEqual({ requestId: "r-1" });
    });

    it("aborts mid-batch when signal fires between handlers", async () => {
      const events = [
        makeEvent({ id: "11111111-1111-4111-8111-111111111111" }),
        makeEvent({ id: "22222222-2222-4222-8222-222222222222" }),
        makeEvent({ id: "33333333-3333-4333-8333-333333333333" }),
      ];
      const ac = new AbortController();
      const handlerSpy = vi.fn(async () => {
        ac.abort(); // aborts after the first handler succeeds
      });
      const handler: EventHandler = {
        eventType: "account.created",
        handle: handlerSpy,
      };
      const { service, calls } = makeService({ ready: events });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry(handler));

      const result = await drainer.runOnce({ signal: ac.signal });
      expect(result.processed).toBe(3); // claimed all 3
      expect(handlerSpy).toHaveBeenCalledTimes(1); // only first ran
      expect(calls.markPublished).toHaveLength(1);
    });
  });

  describe("runUntilEmpty", () => {
    it("loops until findReadyToPublish returns 0 rows", async () => {
      const event = makeEvent();
      const handler: EventHandler = {
        eventType: "account.created",
        handle: async () => undefined,
      };
      const { service, calls } = makeService({ ready: [event] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry(handler));

      const total = await drainer.runUntilEmpty();
      // First pass: 1 event. Second pass: 0 (consumed).
      expect(total.processed).toBe(1);
      expect(total.published).toBe(1);
      expect(calls.findReadyToPublish).toBe(2);
    });

    it("aborts when signal fires between passes", async () => {
      const ac = new AbortController();
      const event = makeEvent();
      const handler: EventHandler = {
        eventType: "account.created",
        handle: async () => {
          ac.abort();
        },
      };
      const { service, calls } = makeService({ ready: [event] });
      const drainer = new OutboxDrainer(service, eventHandlerRegistry(handler));

      const total = await drainer.runUntilEmpty({ signal: ac.signal });
      expect(total.processed).toBe(1);
      // Second pass aborted before findReadyToPublish.
      expect(calls.findReadyToPublish).toBe(1);
    });
  });
});
