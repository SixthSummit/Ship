import {
  createExecutor,
  defineApp,
  defineModule,
  defineOperation,
  defineOutbox,
  defineOutboxCleanup,
  defineOutboxDispatcher,
  effectDependency,
  type OutboxBackend,
  operationError,
  operationFailure,
  outboxDependency,
  outboxIntent,
  publicAccess,
  systemActor,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDrizzleOutbox, shipOutboxTable } from "./outbox.js";
import { createDrizzleUnitOfWork, type DrizzleTransaction } from "./unit-of-work.js";

const records = pgTable("outbox_domain_records", {
  id: serial("id").primaryKey(),
  value: text("value").notNull(),
});
const outboxTable = shipOutboxTable();
const schema = { records, outboxTable };
type Schema = typeof schema;

interface Capabilities {
  readonly domain: { insert(value: string): Promise<void> };
}
interface Notifier {
  send(message: { readonly recipient: string }): Promise<void>;
}

const transactionToken = unitOfWorkDependency<Capabilities>("database.integration");
const notifier = effectDependency<Notifier>("reports.notifier", { delivery: "immediate" });
const writeRejected = operationError({ code: "WRITE_REJECTED", status: 409, message: "Rejected" });
const outbox = defineOutbox({
  id: "reports.outbox",
  retention: { completedMs: 60_000, deadLetteredMs: 120_000 },
  intents: {
    notify: outboxIntent({
      payload: z.object({ recipient: z.string().email() }),
      effect: notifier,
      perform: ({ effect, payload }) => effect.send(payload),
    }),
  },
});

function clockAt(start = Date.now() + 3_600_000) {
  let now = start;
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Drizzle outbox integration", () => {
  let context: PostgresTestDb<Schema>;

  beforeAll(async () => {
    context = await setupPostgresTestDb(schema);
  });

  beforeEach(async () => {
    await truncateAll(context);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  function unitOfWork() {
    return createDrizzleUnitOfWork({
      id: "database.integration",
      database: context.db,
      create: (transaction: DrizzleTransaction<Schema>) => ({
        domain: {
          insert: async (value: string) => {
            await transaction.insert(records).values({ value });
          },
        },
      }),
    });
  }

  function application(
    backend: OutboxBackend,
    send: Notifier["send"],
    clock: () => Date,
    options: { readonly attempts?: number; readonly leaseMs?: number } = {},
  ) {
    const write = defineOperation({
      id: "reports.request",
      input: { body: z.object({ value: z.string(), fail: z.boolean().optional() }) },
      output: { 200: z.object({ recordId: z.string().optional() }) },
      successStatus: 200,
      errors: [writeRejected],
      access: publicAccess(),
      transaction: "write",
      dependencies: { tx: transactionToken, outbox: outboxDependency(outbox) },
      handler: async ({ input, services }) => {
        await services.tx.domain.insert(input.body.value);
        const result = await services.outbox.enqueue(
          "notify",
          { recipient: `${input.body.value}@example.test` },
          { dedupeKey: input.body.value },
        );
        if (input.body.fail) throw operationFailure(writeRejected);
        return "recordId" in result ? { recordId: result.recordId } : {};
      },
    });
    const dispatcher = defineOutboxDispatcher(outbox, {
      batchSize: 10,
      lease: { ms: options.leaseMs ?? 1_000 },
      retry: { attempts: options.attempts ?? 2, backoff: { initialMs: 10 } },
      deadLetter: true,
      clock,
    });
    const module = defineModule({
      id: "reports",
      operations: [write, ...dispatcher.operations, defineOutboxCleanup(outbox, { clock })],
      providers: [
        valueProvider(transactionToken, unitOfWork()),
        valueProvider(outbox.writer, backend),
        valueProvider(notifier, { send }),
      ],
      imports: [],
      exports: [],
    });
    return createExecutor(defineApp({ id: "outbox-integration", modules: [module] }));
  }

  const system = { actor: systemActor({ id: "dispatcher" }) };

  it("records intent in the business transaction: commit persists, rollback removes it", async () => {
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    const executor = application(backend, async () => undefined, clockAt().clock);

    await expect(
      executor.run("reports.request", { body: { value: "kept", fail: true } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "WRITE_REJECTED" } });
    expect(await context.db.select().from(records)).toHaveLength(0);
    expect(await context.db.select().from(outboxTable)).toHaveLength(0);

    const committed = await executor.run("reports.request", { body: { value: "kept" } });
    expect(committed).toMatchObject({ ok: true, data: { recordId: expect.any(String) } });
    expect(await context.db.select().from(records)).toHaveLength(1);
    expect(await context.db.select().from(outboxTable)).toMatchObject([
      { outboxId: "reports.outbox", intentId: "notify", status: "pending", dedupeKey: "kept" },
    ]);

    const duplicate = await executor.run("reports.request", { body: { value: "kept" } });
    expect(duplicate).toMatchObject({ ok: true, data: {} });
    expect(await context.db.select().from(outboxTable)).toHaveLength(1);
  });

  it("refuses to record outside a Drizzle unit-of-work scope", async () => {
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    await expect(
      backend.record({}, [{ intentId: "notify", payload: {}, availableAt: new Date() }]),
    ).rejects.toMatchObject({ code: "SHIP_DRIZZLE_OUTBOX_SCOPE_INVALID" });
  });

  it("never lets two concurrent dispatcher processes perform the same intent", async () => {
    const time = clockAt();
    const performed: string[] = [];
    const send = vi.fn(async (message: { readonly recipient: string }) => {
      performed.push(message.recipient);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const processA = application(
      createDrizzleOutbox({
        outbox,
        database: drizzle(context.pool, { schema }),
        table: outboxTable,
      }),
      send,
      time.clock,
    );
    const processB = application(
      createDrizzleOutbox({
        outbox,
        database: drizzle(context.pool, { schema }),
        table: outboxTable,
      }),
      send,
      time.clock,
    );
    for (let index = 0; index < 8; index += 1) {
      await processA.run("reports.request", { body: { value: `user-${index}` } });
    }

    const [first, second] = await Promise.all([
      processA.run("reports.outbox.dispatch", {}, system),
      processB.run("reports.outbox.dispatch", {}, system),
    ]);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("dispatch failed");
    expect(first.data.claimed + second.data.claimed).toBe(8);
    expect(first.data.completed + second.data.completed).toBe(8);
    expect(new Set(performed).size).toBe(8);
    expect(send).toHaveBeenCalledTimes(8);
    const rows = await context.db.select().from(outboxTable);
    expect(rows.every((row) => row.status === "completed")).toBe(true);
  });

  it("quarantines a removed persisted intent without delaying current work", async () => {
    const time = clockAt();
    const send = vi.fn(async () => undefined);
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    const executor = application(backend, send, time.clock);
    await context.db.insert(outboxTable).values({
      outboxId: outbox.id,
      intentId: "removed-by-new-version",
      payload: { old: true },
      availableAt: time.clock(),
    });
    await executor.run("reports.request", { body: { value: "current" } });

    await expect(executor.run("reports.outbox.dispatch", {}, system)).resolves.toMatchObject({
      ok: true,
      data: { claimed: 2, completed: 1, deadLettered: 1 },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await context.db.select().from(outboxTable);
    expect(rows.find((row) => row.intentId === "notify")).toMatchObject({ status: "completed" });
    const removed = rows.find((row) => row.intentId === "removed-by-new-version");
    expect(removed).toMatchObject({
      status: "dead-lettered",
      attempts: 1,
      lastError: expect.stringContaining("not declared"),
    });
    expect(await backend.health(time.clock())).toMatchObject({
      pending: 0,
      deadLettered: 1,
    });

    const manager = { actor: systemActor({ id: "ops", permissions: ["ship.outbox:manage"] }) };
    await expect(
      executor.run("reports.outbox.list-dead-lettered", { query: { limit: 5 } }, manager),
    ).resolves.toMatchObject({
      ok: true,
      data: { records: [{ id: removed!.id, intentId: "removed-by-new-version" }] },
    });
    await expect(
      executor.run("reports.outbox.retry", { body: { recordId: removed!.id } }, manager),
    ).resolves.toMatchObject({ ok: true, data: { record: { status: "pending" } } });
    const restarted = application(backend, send, time.clock);
    await expect(restarted.run("reports.outbox.dispatch", {}, system)).resolves.toMatchObject({
      ok: true,
      data: { claimed: 1, deadLettered: 1 },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets a crashed claim be retaken after the lease expires (at-least-once)", async () => {
    const time = clockAt();
    const send = vi.fn(async () => undefined);
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    let crash = true;
    const crashing: OutboxBackend = {
      ...backend,
      complete: async (id, now) => {
        if (crash) throw new Error("crashed after the effect succeeded");
        return backend.complete(id, now);
      },
    };
    const executor = application(crashing, send, time.clock, { leaseMs: 500 });
    await executor.run("reports.request", { body: { value: "crash" } });

    await expect(executor.run("reports.outbox.dispatch", {}, system)).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await context.db.select().from(outboxTable))[0]).toMatchObject({ status: "claimed" });

    await expect(executor.run("reports.outbox.dispatch", {}, system)).resolves.toMatchObject({
      data: { claimed: 0 },
    });

    crash = false;
    time.advance(501);
    await expect(executor.run("reports.outbox.dispatch", {}, system)).resolves.toMatchObject({
      data: { claimed: 1, completed: 1 },
    });
    // The effect ran twice: durable retry plus deduplication, never exactly-once.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries with backoff, dead-letters after the attempt limit, and supports retry/discard", async () => {
    const time = clockAt();
    const send = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    const executor = application(backend, send, time.clock, { attempts: 2 });
    const manager = {
      actor: systemActor({ id: "ops", permissions: ["ship.outbox:manage"] }),
    };
    await executor.run("reports.request", { body: { value: "flaky" } });

    await expect(executor.run("reports.outbox.dispatch", {}, system)).resolves.toMatchObject({
      data: { claimed: 1, retried: 1 },
    });
    expect((await context.db.select().from(outboxTable))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "Error: smtp down",
    });
    time.advance(20);
    await expect(executor.run("reports.outbox.dispatch", {}, system)).resolves.toMatchObject({
      data: { claimed: 1, deadLettered: 1 },
    });
    const [dead] = await context.db.select().from(outboxTable);
    expect(dead).toMatchObject({ status: "dead-lettered", attempts: 2 });
    expect(await backend.health(time.clock())).toEqual({ pending: 0, claimed: 0, deadLettered: 1 });

    const listed = await executor.run(
      "reports.outbox.list-dead-lettered",
      { query: { limit: 5 } },
      manager,
    );
    expect(listed).toMatchObject({ ok: true, data: { records: [{ id: dead!.id }] } });

    send.mockResolvedValueOnce(undefined as never);
    await expect(
      executor.run("reports.outbox.retry", { body: { recordId: dead!.id } }, manager),
    ).resolves.toMatchObject({ ok: true, data: { record: { status: "pending" } } });
    await expect(executor.run("reports.outbox.dispatch", {}, system)).resolves.toMatchObject({
      data: { completed: 1 },
    });

    await executor.run("reports.request", { body: { value: "hopeless" } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await executor.run("reports.outbox.dispatch", {}, system);
      time.advance(50);
    }
    const hopeless = (await context.db.select().from(outboxTable)).find(
      (row) => row.dedupeKey === "hopeless",
    );
    expect(hopeless).toMatchObject({ status: "dead-lettered" });
    await expect(
      executor.run(
        "reports.outbox.discard",
        { body: { recordId: hopeless!.id, reason: "recipient left" } },
        manager,
      ),
    ).resolves.toMatchObject({ ok: true, data: { record: { status: "discarded" } } });
    await expect(
      executor.run("reports.outbox.retry", { body: { recordId: hopeless!.id } }, manager),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("cleans up only expired completed and dead-lettered rows", async () => {
    const time = clockAt();
    const send = vi.fn(async ({ recipient }: { readonly recipient: string }) => {
      if (recipient.startsWith("dead")) throw new Error("no");
    });
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    const executor = application(backend, send, time.clock, { attempts: 1 });
    await executor.run("reports.request", { body: { value: "done" } });
    await executor.run("reports.request", { body: { value: "dead" } });
    await executor.run("reports.outbox.dispatch", {}, system);
    await executor.run("reports.request", { body: { value: "pending" } });
    await context.db
      .update(outboxTable)
      .set({ availableAt: new Date(time.clock().getTime() + 10_000_000) });
    const statuses = async () =>
      (await context.db.select().from(outboxTable))
        .map((row) => `${row.dedupeKey}:${row.status}`)
        .sort();
    expect(await statuses()).toEqual(["dead:dead-lettered", "done:completed", "pending:pending"]);

    time.advance(30_000);
    await expect(executor.run("reports.outbox.cleanup", {}, system)).resolves.toMatchObject({
      data: { completedDeleted: 0, deadLetteredDeleted: 0 },
    });
    time.advance(31_000);
    await expect(executor.run("reports.outbox.cleanup", {}, system)).resolves.toMatchObject({
      data: { completedDeleted: 1, deadLetteredDeleted: 0 },
    });
    time.advance(60_000);
    await expect(executor.run("reports.outbox.cleanup", {}, system)).resolves.toMatchObject({
      data: { completedDeleted: 0, deadLetteredDeleted: 1 },
    });
    expect(await statuses()).toEqual(["pending:pending"]);
    expect(await backend.health(time.clock())).toMatchObject({
      pending: 1,
      oldestPendingAt: expect.any(Date),
    });
  });

  it("claims only the intents a partitioned dispatcher declares and honors availableAt", async () => {
    const time = clockAt();
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    await unitOfWork().run("write", async (capabilities) => {
      await backend.record(capabilities, [
        {
          intentId: "notify",
          payload: { recipient: "later@example.test" },
          availableAt: new Date(time.clock().getTime() + 5_000),
        },
      ]);
    });
    expect(await backend.claimDue(time.clock(), 10, 1_000, ["other"])).toEqual([]);
    expect(await backend.claimDue(time.clock(), 10, 1_000, [])).toEqual([]);
    expect(await backend.claimDue(time.clock(), 10, 1_000)).toEqual([]);
    time.advance(5_000);
    const claimed = await backend.claimDue(time.clock(), 10, 1_000, ["notify"]);
    expect(claimed).toMatchObject([{ status: "claimed", intentId: "notify" }]);
    expect(claimed[0]!.leaseExpiresAt).toEqual(new Date(time.clock().getTime() + 1_000));
  });

  it("claims unknown IDs without claiming another partition's declared ID", async () => {
    const time = clockAt();
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    await context.db.insert(outboxTable).values([
      {
        outboxId: outbox.id,
        intentId: "notify",
        payload: { recipient: "current@example.test" },
        availableAt: time.clock(),
      },
      {
        outboxId: outbox.id,
        intentId: "removed",
        payload: {},
        availableAt: time.clock(),
      },
    ]);
    const unknown = await backend.claimUnknownDue(time.clock(), 10, 1_000, ["notify"]);
    expect(unknown).toMatchObject([{ intentId: "removed", status: "claimed" }]);
    expect(await backend.claimDue(time.clock(), 10, 1_000, ["notify"])).toMatchObject([
      { intentId: "notify", status: "claimed" },
    ]);
  });
});
