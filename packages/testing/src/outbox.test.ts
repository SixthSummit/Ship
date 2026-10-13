import {
  createExecutor,
  defineApp,
  defineModule,
  defineOperation,
  defineOutbox,
  defineOutboxDispatcher,
  effectDependency,
  idempotencyStoreDependency,
  outboxDependency,
  outboxIntent,
  publicAccess,
  systemActor,
  type UnitOfWork,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInMemoryIdempotencyStore, createInMemoryOutbox, drainOutbox } from "./outbox.js";

interface Notifier {
  send(message: { readonly to: string }): Promise<void>;
}
const notifier = effectDependency<Notifier>("mail.notifier", { delivery: "immediate" });
const unitOfWork = unitOfWorkDependency<{ readonly noop: true }>("database.primary");
const outbox = defineOutbox({
  id: "mail.outbox",
  intents: {
    send: outboxIntent({
      payload: z.object({ to: z.string() }),
      effect: notifier,
      perform: ({ effect, payload }) => effect.send(payload),
    }),
  },
});
const controller: UnitOfWork<{ readonly noop: true }> = {
  kind: "ship.unit-of-work",
  id: "database.primary",
  run: async (_mode, work) => work({ noop: true }),
};

function application(send: Notifier["send"], clock: () => Date, attempts = 2) {
  const backend = createInMemoryOutbox(outbox);
  const request = defineOperation({
    id: "mail.request",
    input: { body: z.object({ to: z.string(), dedupeKey: z.string().optional() }) },
    output: { 200: z.object({ queued: z.boolean() }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "write",
    dependencies: { tx: unitOfWork, outbox: outboxDependency(outbox) },
    handler: async ({ input, services }) => {
      const result = await services.outbox.enqueue(
        "send",
        { to: input.body.to },
        input.body.dedupeKey ? { dedupeKey: input.body.dedupeKey } : {},
      );
      return { queued: !result.deduplicated };
    },
  });
  const dispatcher = defineOutboxDispatcher(outbox, {
    batchSize: 5,
    lease: { ms: 1_000 },
    retry: { attempts, backoff: { initialMs: 10 } },
    deadLetter: true,
    clock,
  });
  const module = defineModule({
    id: "mail",
    operations: [request, ...dispatcher.operations],
    providers: [
      valueProvider(unitOfWork, controller),
      valueProvider(outbox.writer, backend),
      valueProvider(notifier, { send }),
    ],
    imports: [],
    exports: [],
  });
  return { backend, executor: createExecutor(defineApp({ id: "mail-api", modules: [module] })) };
}

function clockAt(start = Date.now() + 3_600_000) {
  let now = start;
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createInMemoryOutbox", () => {
  it("rejects values that are not outboxes", () => {
    expect(() => createInMemoryOutbox({ id: "mail.outbox" } as never)).toThrow(TypeError);
  });

  it("drains enqueued intents through the dispatcher and deduplicates keys", async () => {
    const send = vi.fn(async () => undefined);
    const time = clockAt();
    const { backend, executor } = application(send, time.clock);

    await executor.run("mail.request", { body: { to: "a@example.test", dedupeKey: "a" } });
    await expect(
      executor.run("mail.request", { body: { to: "a@example.test", dedupeKey: "a" } }),
    ).resolves.toMatchObject({ data: { queued: false } });
    await executor.run("mail.request", { body: { to: "b@example.test" } });

    await expect(drainOutbox(executor, outbox)).resolves.toEqual({
      batchSize: 5,
      claimed: 2,
      completed: 2,
      retried: 0,
      deadLettered: 0,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(backend.records().map((record) => record.status)).toEqual(["completed", "completed"]);
    expect(await backend.health(time.clock())).toEqual({ pending: 0, claimed: 0, deadLettered: 0 });
  });

  it("retries, dead-letters, retries again from management, discards, and cleans up", async () => {
    const send = vi.fn(async () => {
      throw new Error("bounce");
    });
    const time = clockAt();
    const { backend, executor } = application(send, time.clock);
    await executor.run("mail.request", { body: { to: "x@example.test" } });

    await expect(drainOutbox(executor, "mail.outbox")).resolves.toMatchObject({
      claimed: 1,
      retried: 1,
    });
    expect(await backend.health(time.clock())).toMatchObject({
      pending: 1,
      oldestPendingAt: expect.any(Date),
    });
    time.advance(20);
    await expect(drainOutbox(executor, outbox)).resolves.toMatchObject({ deadLettered: 1 });
    const [dead] = backend.records();
    expect(dead).toMatchObject({
      status: "dead-lettered",
      attempts: 2,
      lastError: "Error: bounce",
    });
    expect(await backend.listDeadLettered({ limit: 10 })).toHaveLength(1);
    await expect(backend.retry("missing", time.clock())).resolves.toBeUndefined();
    await expect(backend.discard("missing", "x", time.clock())).resolves.toBeUndefined();

    await expect(backend.retry(dead!.id, time.clock())).resolves.toMatchObject({
      status: "pending",
    });
    await drainOutbox(executor, outbox);
    time.advance(20);
    await drainOutbox(executor, outbox);
    const discarded = await backend.discard(dead!.id, "gone", time.clock());
    expect(discarded).toMatchObject({ status: "discarded", discardReason: "gone" });

    await expect(
      backend.cleanup({ completedMs: 1, deadLetteredMs: 10_000 }, time.clock()),
    ).resolves.toEqual({ completedDeleted: 0, deadLetteredDeleted: 0 });
    time.advance(10_000);
    await expect(
      backend.cleanup({ completedMs: 1, deadLetteredMs: 10_000 }, time.clock()),
    ).resolves.toEqual({ completedDeleted: 0, deadLetteredDeleted: 1 });
    expect(backend.records()).toEqual([]);
    backend.reset();
  });

  it("re-leases expired claims, ignores completion of unclaimed rows, and filters intents", async () => {
    const backend = createInMemoryOutbox(outbox);
    const time = clockAt();
    const [first] = await backend.record({}, [
      { intentId: "send", payload: { to: "x" }, availableAt: time.clock() },
    ]);
    const id = first && "recordId" in first ? first.recordId : "";
    await backend.complete(id, time.clock());
    expect(backend.records()[0]).toMatchObject({ status: "pending" });
    await backend.fail(id, "ignored", { deadLetter: true }, time.clock());
    expect(backend.records()[0]).toMatchObject({ status: "pending", attempts: 0 });

    expect(await backend.claimDue(time.clock(), 10, 100, ["other"])).toEqual([]);
    expect(await backend.claimDue(time.clock(), 10, 100)).toHaveLength(1);
    expect(await backend.claimDue(time.clock(), 10, 100)).toHaveLength(0);
    expect(await backend.health(time.clock())).toMatchObject({ claimed: 1 });
    time.advance(101);
    expect(await backend.claimDue(time.clock(), 10, 100)).toHaveLength(1);
    await backend.complete(id, time.clock());
    time.advance(5);
    await expect(
      backend.cleanup({ completedMs: 1, deadLetteredMs: 1 }, time.clock()),
    ).resolves.toEqual({
      completedDeleted: 1,
      deadLetteredDeleted: 0,
    });
  });

  it("surfaces dispatcher failures and bounded runs from drainOutbox", async () => {
    const time = clockAt();
    const { executor } = application(async () => undefined, time.clock);
    await expect(
      drainOutbox(executor, outbox, { actor: systemActor({ id: "custom" }), maxRuns: 1 }),
    ).resolves.toMatchObject({ claimed: 0 });
    await expect(drainOutbox(executor, "missing.outbox")).rejects.toThrow(
      /SHIP_OPERATION_NOT_FOUND|missing/u,
    );

    const failing = createExecutor(
      defineApp({
        id: "denied",
        modules: [
          defineModule({
            id: "mail",
            operations: [
              defineOperation({
                id: "mail.outbox.dispatch",
                input: {},
                output: { 200: z.object({}) },
                successStatus: 200,
                errors: [],
                access: publicAccess(),
                transaction: "none",
                dependencies: {},
                handler: () => ({}),
              }),
            ],
            providers: [],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );
    await expect(drainOutbox(failing, outbox, { maxRuns: 2 })).rejects.toThrow(/still claimed/u);
  });
});

describe("createInMemoryIdempotencyStore", () => {
  it("claims, replays, reports in-flight keys, releases, and expires", async () => {
    const store = createInMemoryIdempotencyStore();
    const now = new Date();
    const context = { now };

    await expect(store.claim("k", 1_000, context)).resolves.toBe("claimed");
    await expect(store.claim("k", 1_000, context)).resolves.toBe("in-flight");
    await store.complete("k", { status: 200, data: 1 }, context);
    await expect(store.claim("k", 1_000, context)).resolves.toBe("duplicate");
    await expect(store.readResult("k", context)).resolves.toEqual({ status: 200, data: 1 });
    await store.release("k", context);
    await expect(store.claim("k", 1_000, context)).resolves.toBe("duplicate");

    const later = { now: new Date(now.getTime() + 1_001) };
    await expect(store.readResult("k", later)).resolves.toBeUndefined();
    await expect(store.claim("k", 1_000, later)).resolves.toBe("claimed");
    await store.release("k", later);
    await expect(store.claim("k", 1_000, later)).resolves.toBe("claimed");
    await store.complete("unknown", {}, later);
    store.reset();
    await expect(store.claim("k", 1_000, later)).resolves.toBe("claimed");
  });

  it("enforces idempotency through the executor", async () => {
    const store = createInMemoryIdempotencyStore();
    const token = idempotencyStoreDependency("platform.idempotency");
    const handler = vi.fn(() => ({ ok: true as const }));
    const executor = createExecutor(
      defineApp({
        id: "idem",
        modules: [
          defineModule({
            id: "orders",
            operations: [
              defineOperation({
                id: "orders.place",
                input: { body: z.object({ key: z.string() }) },
                output: { 200: z.object({ ok: z.literal(true) }) },
                successStatus: 200,
                errors: [],
                access: publicAccess(),
                transaction: "none",
                dependencies: {},
                idempotency: { key: (input) => input.body.key, windowMs: 1_000, store: token },
                handler,
              }),
            ],
            providers: [valueProvider(token, store)],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );

    await executor.run("orders.place", { body: { key: "a" } });
    await executor.run("orders.place", { body: { key: "a" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
