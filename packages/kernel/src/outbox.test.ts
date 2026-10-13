import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { permission, publicAccess } from "./access.js";
import { operationActor, systemActor } from "./actor.js";
import { ApplicationCompilationError, compileApp, defineApp } from "./application.js";
import { effectDependency, type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { createExecutor } from "./executor.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import {
  type AnyOutbox,
  backoffDelay,
  createOutboxWriter,
  defineOutbox,
  defineOutboxCleanup,
  defineOutboxDispatcher,
  describeOutboxOperation,
  InvalidOutboxDefinitionError,
  isOutbox,
  isOutboxBackend,
  isOutboxDependencyToken,
  type OutboxBackend,
  type OutboxRecord,
  OutboxWriteError,
  outboxBackendDependency,
  outboxDependency,
  outboxIntent,
  outboxRecordView,
} from "./outbox.js";
import { defineProvider, valueProvider } from "./provider.js";

interface Notifier {
  send(message: { readonly recipient: string; readonly subject: string }): Promise<void>;
}
interface Publisher {
  publish(topic: string): Promise<void>;
}

const notifier = effectDependency<Notifier>("reports.notifier", { delivery: "immediate" });
const publisher = effectDependency<Publisher>("events.publisher", { delivery: "immediate" });
const unitOfWork = unitOfWorkDependency<{ readonly records: { save(value: string): void } }>(
  "database.primary",
);
const notifySchema = z.object({ recipient: z.string().email(), subject: z.string().min(1) });
const publishSchema = z.object({ topic: z.string().min(1) });

function fixtureOutbox(retention?: { completedMs: number; deadLetteredMs: number }) {
  return defineOutbox({
    id: "reports.outbox",
    intents: {
      notify: outboxIntent({
        payload: notifySchema,
        effect: notifier,
        perform: ({ effect, payload }) => effect.send(payload),
      }),
      publish: outboxIntent({
        payload: publishSchema,
        effect: publisher,
        perform: ({ effect, payload }) => effect.publish(payload.topic),
      }),
    },
    ...(retention ? { retention } : {}),
  });
}

/** Minimal deterministic backend used only to exercise kernel behavior. */
function fakeBackend(outboxId: string) {
  const records: OutboxRecord[] = [];
  let sequence = 0;
  const find = (id: string) => records.findIndex((record) => record.id === id);
  const replace = (index: number, patch: Partial<OutboxRecord>) => {
    records[index] = Object.freeze({ ...records[index]!, ...patch });
    return records[index]!;
  };
  const backend: OutboxBackend & { readonly records: readonly OutboxRecord[] } = {
    kind: "ship.outbox-backend",
    outboxId,
    records,
    record: async (_scope, intents) =>
      intents.map((intent) => {
        if (
          intent.dedupeKey &&
          records.some(
            (record) =>
              record.intentId === intent.intentId && record.dedupeKey === intent.dedupeKey,
          )
        ) {
          return { deduplicated: true as const };
        }
        sequence += 1;
        const id = `record-${sequence}`;
        records.push(
          Object.freeze({
            id,
            outboxId,
            intentId: intent.intentId,
            payload: intent.payload,
            ...(intent.dedupeKey ? { dedupeKey: intent.dedupeKey } : {}),
            status: "pending",
            attempts: 0,
            availableAt: intent.availableAt,
            createdAt: intent.availableAt,
          }),
        );
        return { recordId: id, deduplicated: false as const };
      }),
    claimDue: async (now, batchSize, leaseMs, intentIds) => {
      const due = records
        .map((record, index) => ({ record, index }))
        .filter(
          ({ record }) =>
            (intentIds === undefined || intentIds.includes(record.intentId)) &&
            ((record.status === "pending" && record.availableAt <= now) ||
              (record.status === "claimed" && (record.leaseExpiresAt ?? now) <= now)),
        )
        .slice(0, batchSize);
      return due.map(({ index }) =>
        replace(index, {
          status: "claimed",
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        }),
      );
    },
    claimUnknownDue: async (now, batchSize, leaseMs, knownIntentIds) => {
      const due = records
        .map((record, index) => ({ record, index }))
        .filter(
          ({ record }) =>
            !knownIntentIds.includes(record.intentId) &&
            ((record.status === "pending" && record.availableAt <= now) ||
              (record.status === "claimed" && (record.leaseExpiresAt ?? now) <= now)),
        )
        .slice(0, batchSize);
      return due.map(({ index }) =>
        replace(index, {
          status: "claimed",
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        }),
      );
    },
    complete: async (id, now) => {
      replace(find(id), { status: "completed", completedAt: now, leaseExpiresAt: undefined });
    },
    fail: async (id, error, disposition, now) => {
      const index = find(id);
      const attempts = records[index]!.attempts + 1;
      if ("deadLetter" in disposition) {
        replace(index, {
          status: "dead-lettered",
          attempts,
          lastError: error,
          deadLetteredAt: now,
        });
      } else {
        replace(index, {
          status: "pending",
          attempts,
          lastError: error,
          availableAt: disposition.retryAt,
          leaseExpiresAt: undefined,
        });
      }
    },
    listDeadLettered: async ({ limit }) =>
      records.filter((record) => record.status === "dead-lettered").slice(0, limit),
    retry: async (id, now) => {
      const index = find(id);
      if (index < 0 || records[index]!.status !== "dead-lettered") return undefined;
      return replace(index, { status: "pending", availableAt: now, deadLetteredAt: undefined });
    },
    discard: async (id, reason, now) => {
      const index = find(id);
      if (index < 0 || records[index]!.status !== "dead-lettered") return undefined;
      return replace(index, { status: "discarded", discardedAt: now, discardReason: reason });
    },
    cleanup: async (retention, now) => {
      let completedDeleted = 0;
      let deadLetteredDeleted = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]!;
        if (
          record.status === "completed" &&
          record.completedAt &&
          now.getTime() - record.completedAt.getTime() > retention.completedMs
        ) {
          records.splice(index, 1);
          completedDeleted += 1;
        } else if (
          (record.status === "dead-lettered" || record.status === "discarded") &&
          now.getTime() - (record.deadLetteredAt ?? record.discardedAt ?? now).getTime() >
            retention.deadLetteredMs
        ) {
          records.splice(index, 1);
          deadLetteredDeleted += 1;
        }
      }
      return { completedDeleted, deadLetteredDeleted };
    },
    health: async () => ({
      pending: records.filter((record) => record.status === "pending").length,
      claimed: records.filter((record) => record.status === "claimed").length,
      deadLettered: records.filter((record) => record.status === "dead-lettered").length,
    }),
  };
  return backend;
}

function fakeUnitOfWork(): UnitOfWork<{ readonly records: { save(value: string): void } }> {
  return {
    kind: "ship.unit-of-work",
    id: "database.primary",
    run: async (_mode, work) => work({ records: { save: () => undefined } }),
  };
}

/**
 * A controllable clock that starts ahead of wall-clock time so records
 * enqueued by the executor's real-time writer are immediately due.
 */
function clockAt(start = Date.now() + 3_600_000) {
  let now = start;
  return {
    clock: () => new Date(now),
    at: (offsetMs: number) => new Date(start + offsetMs),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("defineOutbox", () => {
  it("creates a frozen declaration with writer and backend tokens", () => {
    const outbox = fixtureOutbox({ completedMs: 1000, deadLetteredMs: 2000 });

    expect(outbox).toMatchObject({ kind: "ship.outbox", id: "reports.outbox" });
    expect(Object.isFrozen(outbox)).toBe(true);
    expect(Object.isFrozen(outbox.intents)).toBe(true);
    expect(outboxDependency(outbox)).toMatchObject({
      kind: "ship.dependency",
      id: "reports.outbox",
      scope: "outbox",
      role: "writer",
    });
    expect(outboxBackendDependency(outbox)).toMatchObject({ role: "backend" });
    expect(outboxDependency(outbox).outbox).toBe(outbox);
    expect(isOutbox(outbox)).toBe(true);
    expect(isOutboxDependencyToken(outbox.writer)).toBe(true);
    expect(isOutboxDependencyToken(unitOfWork)).toBe(false);
    expect(isOutbox({ kind: "ship.outbox", id: "Bad" })).toBe(false);
  });

  it.each([
    ["non-object", null, "SHIP_OUTBOX_DEFINITION_INVALID"],
    ["bad id", { id: "Reports", intents: {} }, "SHIP_OUTBOX_ID_INVALID"],
    ["array intents", { id: "reports", intents: [] }, "SHIP_OUTBOX_DEFINITION_INVALID"],
    ["empty intents", { id: "reports", intents: {} }, "SHIP_OUTBOX_INTENTS_EMPTY"],
    [
      "bad intent id",
      { id: "reports", intents: { Notify: { payload: notifySchema, effect: notifier } } },
      "SHIP_OUTBOX_INTENT_ID_INVALID",
    ],
    [
      "missing payload",
      { id: "reports", intents: { notify: { effect: notifier, perform: () => undefined } } },
      "SHIP_OUTBOX_INTENT_PAYLOAD_INVALID",
    ],
    [
      "non-effect token",
      {
        id: "reports",
        intents: {
          notify: { payload: notifySchema, effect: unitOfWork, perform: () => undefined },
        },
      },
      "SHIP_OUTBOX_INTENT_EFFECT_INVALID",
    ],
    [
      "missing perform",
      { id: "reports", intents: { notify: { payload: notifySchema, effect: notifier } } },
      "SHIP_OUTBOX_INTENT_PERFORM_INVALID",
    ],
    [
      "bad retention",
      {
        id: "reports",
        intents: { notify: { payload: notifySchema, effect: notifier, perform: () => undefined } },
        retention: { completedMs: 0, deadLetteredMs: 10 },
      },
      "SHIP_OUTBOX_RETENTION_INVALID",
    ],
  ])("rejects %s", (_name, definition, code) => {
    const define = defineOutbox as (definition: unknown) => unknown;
    expect(() => define(definition)).toThrowError(
      expect.objectContaining({ name: "InvalidOutboxDefinitionError", code }),
    );
  });

  it("rejects non-outbox values passed to token helpers", () => {
    const helper = outboxDependency as (value: unknown) => unknown;
    expect(() => helper({ id: "reports.outbox" })).toThrow(InvalidOutboxDefinitionError);
    expect(() => (outboxBackendDependency as (value: unknown) => unknown)(null)).toThrow(
      InvalidOutboxDefinitionError,
    );
  });
});

describe("defineOutbox expectedRatePerSecond", () => {
  it("keeps a declared expected rate and rejects a non-positive or non-finite one", () => {
    const declared = defineOutbox({
      id: "reports.outbox",
      expectedRatePerSecond: 500,
      intents: fixtureOutbox().intents,
    });
    expect(declared.expectedRatePerSecond).toBe(500);
    expect(fixtureOutbox().expectedRatePerSecond).toBeUndefined();
    for (const expectedRatePerSecond of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "500"]) {
      expect(() =>
        defineOutbox({
          id: "reports.outbox",
          expectedRatePerSecond: expectedRatePerSecond as never,
          intents: fixtureOutbox().intents,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "SHIP_OUTBOX_EXPECTED_RATE_INVALID",
          field: "expectedRatePerSecond",
        }),
      );
    }
  });
});

describe("outbox writer", () => {
  it("validates payloads and records intent through the backend with the active scope", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const scope = { records: {} };
    const record = vi.spyOn(backend, "record");
    const writer = createOutboxWriter<typeof outbox.intents>(
      outbox,
      backend,
      scope,
      () => new Date("2026-09-18T00:00:00.000Z"),
    );

    const result = await writer.enqueue(
      "notify",
      { recipient: "ops@example.test", subject: "Weekly" },
      { dedupeKey: "weekly-1" },
    );
    const duplicate = await writer.enqueue(
      "notify",
      { recipient: "ops@example.test", subject: "Weekly" },
      { dedupeKey: "weekly-1" },
    );

    expect(result).toEqual({ recordId: "record-1", deduplicated: false });
    expect(duplicate).toEqual({ deduplicated: true });
    expect(record).toHaveBeenCalledWith(scope, [
      {
        intentId: "notify",
        payload: { recipient: "ops@example.test", subject: "Weekly" },
        dedupeKey: "weekly-1",
        availableAt: new Date("2026-09-18T00:00:00.000Z"),
      },
    ]);
    expect(Object.isFrozen(writer)).toBe(true);
    expect(writer.outboxId).toBe("reports.outbox");
  });

  it("rejects unknown intents, invalid payloads, and invalid options before touching the backend", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const writer = createOutboxWriter(outbox, backend, {});
    const enqueue = writer.enqueue as (
      intentId: string,
      payload: unknown,
      options?: unknown,
    ) => Promise<unknown>;

    await expect(enqueue("missing", {})).rejects.toMatchObject({
      name: "OutboxWriteError",
      code: "SHIP_OUTBOX_INTENT_UNKNOWN",
      outboxId: "reports.outbox",
      intentId: "missing",
    });
    await expect(enqueue("notify", { recipient: "nope", subject: "" })).rejects.toMatchObject({
      code: "SHIP_OUTBOX_PAYLOAD_INVALID",
      issues: expect.arrayContaining([expect.objectContaining({ path: ["recipient"] })]),
    });
    await expect(
      enqueue("notify", { recipient: "ops@example.test", subject: "x" }, { dedupeKey: "" }),
    ).rejects.toMatchObject({ code: "SHIP_OUTBOX_ENQUEUE_OPTIONS_INVALID" });
    await expect(
      enqueue(
        "notify",
        { recipient: "ops@example.test", subject: "x" },
        { availableAt: new Date("invalid") },
      ),
    ).rejects.toBeInstanceOf(OutboxWriteError);
    expect(backend.records).toHaveLength(0);
  });

  it("treats an empty backend response as deduplicated", async () => {
    const outbox = fixtureOutbox();
    const backend = { ...fakeBackend(outbox.id), record: async () => [] };
    const writer = createOutboxWriter(outbox, backend, {});

    await expect(
      writer.enqueue("publish", { topic: "reports" }, { availableAt: new Date(0) }),
    ).resolves.toEqual({ deduplicated: true });
  });
});

describe("defineOutboxDispatcher", () => {
  function dispatcherOptions(clock: () => Date, attempts = 3) {
    return {
      batchSize: 10,
      lease: { ms: 1_000 },
      retry: { attempts, backoff: { initialMs: 100, multiplier: 2, maxMs: 1_000 } },
      deadLetter: true as const,
      clock,
    };
  }

  function application(
    outbox: ReturnType<typeof fixtureOutbox>,
    backend: OutboxBackend,
    effects: { notifier: Notifier; publisher: Publisher },
    clock: () => Date,
    options: Partial<Parameters<typeof defineOutboxDispatcher>[1]> = {},
  ) {
    const dispatcher = defineOutboxDispatcher(outbox, {
      ...dispatcherOptions(clock),
      ...options,
    } as Parameters<typeof defineOutboxDispatcher>[1]);
    const write = defineOperation({
      id: "reports.request",
      input: { body: z.object({ subject: z.string(), dedupeKey: z.string().optional() }) },
      output: { 200: z.object({ recordId: z.string().optional() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "write",
      dependencies: { tx: unitOfWork, outbox: outboxDependency(outbox) },
      handler: async ({ input, services }) => {
        services.tx.records.save(input.body.subject);
        const result = await services.outbox.enqueue(
          "notify",
          { recipient: "ops@example.test", subject: input.body.subject },
          input.body.dedupeKey ? { dedupeKey: input.body.dedupeKey } : {},
        );
        return "recordId" in result ? { recordId: result.recordId } : {};
      },
    });
    const module = defineModule({
      id: "reports",
      operations: [write, ...dispatcher.operations],
      providers: [
        valueProvider(unitOfWork, fakeUnitOfWork()),
        valueProvider(outbox.writer, backend),
        valueProvider(notifier, effects.notifier),
        valueProvider(publisher, effects.publisher),
      ],
      imports: [],
      exports: [],
    });
    const app = defineApp({ id: "outbox-api", modules: [module] });
    return { app, dispatcher, executor: createExecutor(app) };
  }

  it("generates system-access dispatcher and permission-gated management operations", () => {
    const outbox = fixtureOutbox();
    const dispatcher = defineOutboxDispatcher(
      outbox,
      dispatcherOptions(() => new Date()),
    );

    expect(dispatcher.operations.map((operation) => operation.id)).toEqual([
      "reports.outbox.dispatch",
      "reports.outbox.list-dead-lettered",
      "reports.outbox.retry",
      "reports.outbox.discard",
    ]);
    expect(dispatcher.dispatch).toMatchObject({
      access: { kind: "system" },
      transaction: "none",
      effects: [publisher, notifier],
    });
    expect(Object.keys(dispatcher.dispatch.dependencies)).toEqual([
      "outbox",
      "eventsPublisher",
      "reportsNotifier",
    ]);
    expect(dispatcher.retry.access).toEqual(permission("ship.outbox:manage"));
    expect(describeOutboxOperation(dispatcher.dispatch)).toEqual({
      role: "dispatcher",
      outboxId: "reports.outbox",
      intentIds: ["notify", "publish"],
      batchSize: 10,
    });
    expect(describeOutboxOperation(dispatcher.discard)).toEqual({
      role: "management",
      outboxId: "reports.outbox",
      action: "discard",
    });
    expect(Object.isFrozen(dispatcher)).toBe(true);
  });

  it("records a declared dispatch cadence in the operation role and rejects an invalid one", () => {
    const outbox = fixtureOutbox();
    const dispatcher = defineOutboxDispatcher(outbox, {
      ...dispatcherOptions(() => new Date()),
      roundsPerSecond: 4,
    });
    expect(describeOutboxOperation(dispatcher.dispatch)).toEqual({
      role: "dispatcher",
      outboxId: "reports.outbox",
      intentIds: ["notify", "publish"],
      batchSize: 10,
      roundsPerSecond: 4,
    });
    for (const roundsPerSecond of [0, -2, Number.NaN, "4"]) {
      expect(() =>
        defineOutboxDispatcher(outbox, {
          ...dispatcherOptions(() => new Date()),
          roundsPerSecond: roundsPerSecond as never,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID",
          field: "roundsPerSecond",
        }),
      );
    }
  });

  it("enqueues in the write operation and performs the bound effect from the dispatcher", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const { clock } = clockAt();
    const send = vi.fn(async () => undefined);
    const { executor } = application(
      outbox,
      backend,
      { notifier: { send }, publisher: { publish: vi.fn() } },
      clock,
    );

    const written = await executor.run("reports.request", { body: { subject: "Weekly" } });
    expect(written).toMatchObject({ ok: true, data: { recordId: "record-1" } });
    expect(send).not.toHaveBeenCalled();

    const denied = await executor.run(
      "reports.outbox.dispatch",
      {},
      { actor: operationActor({ id: "user", permissions: ["ship.outbox:manage"] }) },
    );
    expect(denied).toMatchObject({ ok: false, status: 403 });

    const dispatched = await executor.run(
      "reports.outbox.dispatch",
      {},
      { actor: systemActor({ id: "dispatcher" }) },
    );
    expect(dispatched).toMatchObject({
      ok: true,
      data: { claimed: 1, completed: 1, retried: 0, deadLettered: 0 },
    });
    expect(send).toHaveBeenCalledWith({ recipient: "ops@example.test", subject: "Weekly" });
    expect(backend.records[0]).toMatchObject({ status: "completed" });

    const idle = await executor.run(
      "reports.outbox.dispatch",
      {},
      { actor: systemActor({ id: "dispatcher" }) },
    );
    expect(idle).toMatchObject({ ok: true, data: { claimed: 0 } });
  });

  it("retries with backoff, dead-letters after the attempt limit, and exposes management operations", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const time = clockAt();
    const send = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const { executor } = application(
      outbox,
      backend,
      { notifier: { send }, publisher: { publish: vi.fn() } },
      time.clock,
    );
    const system = { actor: systemActor({ id: "dispatcher" }) };
    const manager = { actor: operationActor({ id: "ops", permissions: ["ship.outbox:manage"] }) };
    await executor.run("reports.request", { body: { subject: "Weekly" } });

    const first = await executor.run("reports.outbox.dispatch", {}, system);
    expect(first).toMatchObject({ ok: true, data: { claimed: 1, retried: 1 } });
    expect(backend.records[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "Error: smtp down",
      availableAt: time.at(100),
    });

    const notDue = await executor.run("reports.outbox.dispatch", {}, system);
    expect(notDue).toMatchObject({ ok: true, data: { claimed: 0 } });

    time.advance(150);
    await executor.run("reports.outbox.dispatch", {}, system);
    expect(backend.records[0]).toMatchObject({
      attempts: 2,
      availableAt: time.at(350),
    });
    time.advance(250);
    const last = await executor.run("reports.outbox.dispatch", {}, system);
    expect(last).toMatchObject({ ok: true, data: { claimed: 1, deadLettered: 1 } });
    expect(backend.records[0]).toMatchObject({ status: "dead-lettered", attempts: 3 });
    expect(send).toHaveBeenCalledTimes(3);

    const list = await executor.run("reports.outbox.list-dead-lettered", { query: {} }, manager);
    expect(list).toMatchObject({
      ok: true,
      data: {
        records: [
          {
            id: "record-1",
            intentId: "notify",
            status: "dead-lettered",
            attempts: 3,
            lastError: "Error: smtp down",
          },
        ],
      },
    });
    const forbidden = await executor.run(
      "reports.outbox.list-dead-lettered",
      { query: {} },
      { actor: operationActor({ id: "ops" }) },
    );
    expect(forbidden).toMatchObject({ ok: false, status: 403 });

    const missing = await executor.run(
      "reports.outbox.retry",
      { body: { recordId: "record-404" } },
      manager,
    );
    expect(missing).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "OUTBOX_RECORD_NOT_FOUND" },
    });

    const retried = await executor.run(
      "reports.outbox.retry",
      { body: { recordId: "record-1" } },
      manager,
    );
    expect(retried).toMatchObject({ ok: true, data: { record: { status: "pending" } } });
    send.mockResolvedValueOnce(undefined as never);
    const recovered = await executor.run("reports.outbox.dispatch", {}, system);
    expect(recovered).toMatchObject({ ok: true, data: { completed: 1 } });

    await executor.run("reports.request", { body: { subject: "Again" } });
    time.advance(10_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await executor.run("reports.outbox.dispatch", {}, system);
      time.advance(2_000);
    }
    expect(backend.records[1]).toMatchObject({ status: "dead-lettered" });
    const discarded = await executor.run(
      "reports.outbox.discard",
      { body: { recordId: "record-2", reason: "stale recipient" } },
      manager,
    );
    expect(discarded).toMatchObject({
      ok: true,
      data: { record: { status: "discarded", discardReason: "stale recipient" } },
    });
    await expect(
      executor.run(
        "reports.outbox.discard",
        { body: { recordId: "record-2", reason: "again" } },
        manager,
      ),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("leaves a record claimed when completion recording fails so the lease makes it retryable", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const time = clockAt();
    const send = vi.fn(async () => undefined);
    let crash = true;
    const crashing: OutboxBackend = {
      ...backend,
      complete: async (id, now) => {
        if (crash) throw new Error("process crashed before completion");
        return backend.complete(id, now);
      },
    };
    const { executor } = application(
      outbox,
      crashing,
      { notifier: { send }, publisher: { publish: vi.fn() } },
      time.clock,
    );
    const system = { actor: systemActor({ id: "dispatcher" }) };
    await executor.run("reports.request", { body: { subject: "Weekly" } });

    await expect(executor.run("reports.outbox.dispatch", {}, system)).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(backend.records[0]).toMatchObject({ status: "claimed" });

    const leased = await executor.run("reports.outbox.dispatch", {}, system);
    expect(leased).toMatchObject({ ok: true, data: { claimed: 0 } });

    crash = false;
    time.advance(1_001);
    const redelivered = await executor.run("reports.outbox.dispatch", {}, system);
    expect(redelivered).toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    // At-least-once: the effect ran twice because completion was never recorded the first time.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("dead-letters a removed intent while completing declared work in the same pass", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const time = clockAt();
    await backend.record({}, [
      { intentId: "removed", payload: {}, availableAt: time.clock() },
      { intentId: "publish", payload: { topic: "x" }, availableAt: time.clock() },
    ]);
    const publish = vi.fn(async () => undefined);
    const { executor } = application(
      outbox,
      backend,
      { notifier: { send: vi.fn() }, publisher: { publish } },
      time.clock,
      { retry: { attempts: 1, backoff: { initialMs: 0 } } },
    );
    const result = await executor.run(
      "reports.outbox.dispatch",
      {},
      { actor: systemActor({ id: "dispatcher" }) },
    );
    expect(result).toMatchObject({ ok: true, data: { claimed: 2, deadLettered: 1, completed: 1 } });
    expect(backend.records[0]).toMatchObject({
      status: "dead-lettered",
      lastError: expect.stringContaining("not declared"),
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const manager = { actor: systemActor({ id: "ops", permissions: ["ship.outbox:manage"] }) };
    await expect(
      executor.run("reports.outbox.list-dead-lettered", { query: { limit: 5 } }, manager),
    ).resolves.toMatchObject({
      ok: true,
      data: { records: [{ intentId: "removed", status: "dead-lettered" }] },
    });
  });

  it("keeps full-coverage custom backends compatible and refuses unsafe partitioned ones", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const { claimUnknownDue: _newMethod, ...legacyBackend } = backend;
    expect(isOutboxBackend(legacyBackend)).toBe(true);
    const time = clockAt();
    await backend.record({}, [{ intentId: "removed", payload: {}, availableAt: time.clock() }]);
    const effects = {
      notifier: { send: vi.fn(async () => undefined) },
      publisher: { publish: vi.fn(async () => undefined) },
    };
    const full = application(outbox, legacyBackend, effects, time.clock);
    await expect(
      full.executor.run("reports.outbox.dispatch", {}, { actor: systemActor({ id: "d" }) }),
    ).resolves.toMatchObject({ ok: true, data: { claimed: 1, deadLettered: 1 } });

    const partitioned = defineOutboxDispatcher(outbox, {
      ...dispatcherOptions(time.clock),
      intents: ["publish"],
    });
    const module = defineModule({
      id: "reports",
      operations: partitioned.operations,
      providers: [
        valueProvider(outbox.writer, legacyBackend),
        valueProvider(publisher, effects.publisher),
      ],
      imports: [],
      exports: [],
    });
    const executor = createExecutor(defineApp({ id: "partitioned", modules: [module] }));
    await expect(
      executor.run("reports.outbox.dispatch", {}, { actor: systemActor({ id: "d" }) }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_HANDLER_FAILED" });
    expect(backend.records[0]).toMatchObject({ status: "dead-lettered" });
  });

  it("stops between records once the signal aborts", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const time = clockAt();
    await backend.record({}, [
      { intentId: "publish", payload: { topic: "a" }, availableAt: time.clock() },
      { intentId: "publish", payload: { topic: "b" }, availableAt: time.clock() },
    ]);
    const controller = new AbortController();
    const publish = vi.fn(async () => {
      controller.abort();
    });
    const { executor } = application(
      outbox,
      backend,
      { notifier: { send: vi.fn() }, publisher: { publish } },
      time.clock,
    );

    await expect(
      executor.run(
        "reports.outbox.dispatch",
        {},
        { actor: systemActor({ id: "dispatcher" }), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_ABORTED" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(backend.records.map((record) => record.status)).toEqual(["completed", "claimed"]);
  });

  it("dispatches only the declared intent subset when partitioned", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const time = clockAt();
    await backend.record({}, [
      {
        intentId: "notify",
        payload: { recipient: "ops@example.test", subject: "x" },
        availableAt: time.clock(),
      },
      { intentId: "publish", payload: { topic: "a" }, availableAt: time.clock() },
      { intentId: "removed", payload: {}, availableAt: time.clock() },
    ]);
    const dispatcher = defineOutboxDispatcher(outbox, {
      ...dispatcherOptions(time.clock),
      intents: ["publish"],
    });
    expect(Object.keys(dispatcher.dispatch.dependencies)).toEqual(["outbox", "eventsPublisher"]);
    const publish = vi.fn(async () => undefined);
    const module = defineModule({
      id: "reports",
      operations: dispatcher.operations,
      providers: [valueProvider(outbox.writer, backend), valueProvider(publisher, { publish })],
      imports: [],
      exports: [],
    });
    const executor = createExecutor(defineApp({ id: "partitioned", modules: [module] }));

    await expect(
      executor.run("reports.outbox.dispatch", {}, { actor: systemActor({ id: "d" }) }),
    ).resolves.toMatchObject({
      ok: true,
      data: { claimed: 2, completed: 1, deadLettered: 1 },
    });
    expect(backend.records.map((record) => record.status)).toEqual([
      "pending",
      "completed",
      "dead-lettered",
    ]);
  });

  it("alternates known and removed receipts with a single-slot dispatcher", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const time = clockAt();
    await backend.record({}, [
      { intentId: "removed", payload: {}, availableAt: time.clock() },
      { intentId: "removed", payload: {}, availableAt: time.clock() },
      {
        intentId: "notify",
        payload: { recipient: "ops@example.test", subject: "a" },
        availableAt: time.clock(),
      },
      {
        intentId: "notify",
        payload: { recipient: "ops@example.test", subject: "b" },
        availableAt: time.clock(),
      },
    ]);
    const send = vi.fn(async () => undefined);
    const { executor } = application(
      outbox,
      backend,
      { notifier: { send }, publisher: { publish: vi.fn() } },
      time.clock,
      { batchSize: 1 },
    );
    const results = [];
    for (let pass = 0; pass < 4; pass += 1) {
      results.push(
        await executor.run("reports.outbox.dispatch", {}, { actor: systemActor({ id: "d" }) }),
      );
    }
    expect(results.map((result) => (result.ok ? result.data : result.error))).toMatchObject([
      { claimed: 1, completed: 1, deadLettered: 0 },
      { claimed: 1, completed: 0, deadLettered: 1 },
      { claimed: 1, completed: 1, deadLettered: 0 },
      { claimed: 1, completed: 0, deadLettered: 1 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("probes an empty unknown set periodically and discovers a later removed receipt", async () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const claimUnknownDue = vi.fn(backend.claimUnknownDue);
    const time = clockAt();
    const { executor } = application(
      outbox,
      { ...backend, claimUnknownDue },
      { notifier: { send: vi.fn() }, publisher: { publish: vi.fn() } },
      time.clock,
      { batchSize: 2 },
    );
    const actor = { actor: systemActor({ id: "d" }) };

    await executor.run("reports.outbox.dispatch", {}, actor);
    await backend.record({}, [{ intentId: "removed", payload: {}, availableAt: time.clock() }]);
    await executor.run("reports.outbox.dispatch", {}, actor);
    expect(claimUnknownDue).toHaveBeenCalledTimes(1);
    expect(backend.records[0]).toMatchObject({ status: "pending" });

    time.advance(5_000);
    await expect(executor.run("reports.outbox.dispatch", {}, actor)).resolves.toMatchObject({
      ok: true,
      data: { claimed: 1, deadLettered: 1 },
    });
    expect(claimUnknownDue).toHaveBeenCalledTimes(3);
    expect(backend.records[0]).toMatchObject({ status: "dead-lettered" });
  });

  it.each([
    ["missing batch size", { batchSize: 0 }, "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID"],
    ["missing lease", { lease: { ms: -1 } }, "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID"],
    [
      "missing attempts",
      { retry: { attempts: 0, backoff: { initialMs: 1 } } },
      "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID",
    ],
    [
      "bad backoff",
      { retry: { attempts: 1, backoff: { initialMs: 1, multiplier: 0 } } },
      "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID",
    ],
    [
      "bad max",
      { retry: { attempts: 1, backoff: { initialMs: 1, maxMs: 0 } } },
      "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID",
    ],
    ["dead letter disabled", { deadLetter: false }, "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID"],
    ["bad clock", { clock: "now" }, "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID"],
    ["empty intents", { intents: [] }, "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID"],
    ["unknown intent", { intents: ["missing"] }, "SHIP_OUTBOX_DISPATCHER_INTENT_UNKNOWN"],
  ])("rejects %s", (_name, override, code) => {
    const define = defineOutboxDispatcher as (outbox: unknown, options: unknown) => unknown;
    expect(() =>
      define(fixtureOutbox(), { ...dispatcherOptions(() => new Date()), ...override }),
    ).toThrowError(expect.objectContaining({ code }));
    expect(() => define(fixtureOutbox(), null)).toThrowError(
      expect.objectContaining({ code: "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID" }),
    );
    expect(() =>
      define(
        {},
        dispatcherOptions(() => new Date()),
      ),
    ).toThrowError(expect.objectContaining({ code: "SHIP_OUTBOX_DEFINITION_INVALID" }));
  });

  it("rejects effect ids whose binding name collides with the backend binding", () => {
    const collider = effectDependency<Notifier>("outbox", { delivery: "immediate" });
    const outbox = defineOutbox({
      id: "collisions",
      intents: {
        notify: outboxIntent({ payload: notifySchema, effect: collider, perform: () => undefined }),
      },
    });
    expect(() =>
      defineOutboxDispatcher(
        outbox,
        dispatcherOptions(() => new Date()),
      ),
    ).toThrowError(expect.objectContaining({ code: "SHIP_OUTBOX_EFFECT_BINDING_CONFLICT" }));
  });

  it("computes bounded exponential backoff", () => {
    expect(backoffDelay({ initialMs: 100 }, 1)).toBe(100);
    expect(backoffDelay({ initialMs: 100 }, 3)).toBe(400);
    expect(backoffDelay({ initialMs: 100, multiplier: 3, maxMs: 500 }, 3)).toBe(500);
    expect(backoffDelay({ initialMs: 100 }, 0)).toBe(100);
  });
});

describe("defineOutboxCleanup", () => {
  it("requires retention and deletes only expired terminal records", async () => {
    expect(() => defineOutboxCleanup(fixtureOutbox())).toThrowError(
      expect.objectContaining({ code: "SHIP_OUTBOX_RETENTION_REQUIRED" }),
    );
    expect(() => (defineOutboxCleanup as (value: unknown) => unknown)({})).toThrow(
      InvalidOutboxDefinitionError,
    );

    const outbox = fixtureOutbox({ completedMs: 1_000, deadLetteredMs: 5_000 });
    const backend = fakeBackend(outbox.id);
    const time = clockAt();
    await backend.record({}, [
      { intentId: "publish", payload: { topic: "done" }, availableAt: time.clock() },
      { intentId: "publish", payload: { topic: "dead" }, availableAt: time.clock() },
      { intentId: "publish", payload: { topic: "pending" }, availableAt: time.clock() },
    ]);
    await backend.complete("record-1", time.clock());
    await backend.fail("record-2", "boom", { deadLetter: true }, time.clock());
    const cleanup = defineOutboxCleanup(outbox, { clock: time.clock });
    expect(describeOutboxOperation(cleanup)).toEqual({
      role: "cleanup",
      outboxId: "reports.outbox",
    });
    expect(cleanup).toMatchObject({ id: "reports.outbox.cleanup", access: { kind: "system" } });
    const module = defineModule({
      id: "reports",
      operations: [cleanup],
      providers: [valueProvider(outbox.writer, backend)],
      imports: [],
      exports: [],
    });
    const executor = createExecutor(defineApp({ id: "cleanup", modules: [module] }));
    const system = { actor: systemActor({ id: "cleaner" }) };

    time.advance(2_000);
    await expect(executor.run("reports.outbox.cleanup", {}, system)).resolves.toMatchObject({
      ok: true,
      data: { completedDeleted: 1, deadLetteredDeleted: 0 },
    });
    time.advance(5_000);
    await expect(executor.run("reports.outbox.cleanup", {}, system)).resolves.toMatchObject({
      ok: true,
      data: { completedDeleted: 0, deadLetteredDeleted: 1 },
    });
    expect(backend.records.map((record) => record.status)).toEqual(["pending"]);
  });
});

describe("outbox application diagnostics and graph", () => {
  function writeOperation(
    outbox: AnyOutbox,
    transaction: "none" | "read" | "write" = "write",
    id = "reports.request",
  ) {
    return defineOperation({
      id,
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction,
      dependencies: {
        ...(transaction === "none" ? {} : { tx: unitOfWork }),
        outbox: outboxDependency(outbox as ReturnType<typeof fixtureOutbox>),
      },
      handler: () => ({ ok: true as const }),
    });
  }

  function codes(modules: Parameters<typeof compileApp>[0]["modules"]) {
    try {
      compileApp({ id: "outbox-diagnostics", modules });
      return [];
    } catch (error) {
      if (error instanceof ApplicationCompilationError) {
        return error.diagnostics.map((diagnostic) => diagnostic.code);
      }
      throw error;
    }
  }

  function ratedApplication(input: {
    readonly expectedRatePerSecond?: number;
    readonly dispatcher: { readonly batchSize: number; readonly roundsPerSecond?: number };
  }) {
    const outbox = defineOutbox({
      id: "reports.outbox",
      ...(input.expectedRatePerSecond !== undefined
        ? { expectedRatePerSecond: input.expectedRatePerSecond }
        : {}),
      intents: fixtureOutbox().intents,
    });
    const backend = fakeBackend(outbox.id);
    const dispatcher = defineOutboxDispatcher(outbox, {
      batchSize: input.dispatcher.batchSize,
      lease: { ms: 10 },
      retry: { attempts: 1, backoff: { initialMs: 0 } },
      deadLetter: true,
      ...(input.dispatcher.roundsPerSecond !== undefined
        ? { roundsPerSecond: input.dispatcher.roundsPerSecond }
        : {}),
    });
    return compileApp({
      id: "outbox-capacity",
      modules: [
        defineModule({
          id: "reports",
          operations: [writeOperation(outbox), ...dispatcher.operations],
          providers: [
            valueProvider(unitOfWork, fakeUnitOfWork()),
            valueProvider(outbox.writer, backend),
            valueProvider(notifier, { send: async () => undefined }),
            valueProvider(publisher, { publish: async () => undefined }),
          ],
          imports: [],
          exports: [],
        }),
      ],
    });
  }

  it("warns when the declared dispatch capacity is below the declared write rate", () => {
    const app = ratedApplication({
      expectedRatePerSecond: 500,
      dispatcher: { batchSize: 25, roundsPerSecond: 4 },
    });
    expect(app.diagnostics).toEqual([
      expect.objectContaining({
        code: "SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE",
        severity: "warning",
        providerId: "reports.outbox",
        operationId: "reports.request",
        path: "expectedRatePerSecond",
        message: expect.stringContaining(
          "expects 500 intents/s but its dispatchers declare 100 records/s",
        ),
      }),
    ]);
    expect(app.graph.outboxes[0]).toMatchObject({
      id: "reports.outbox",
      expectedRatePerSecond: 500,
      dispatchCapacityPerSecond: 100,
    });
  });

  it("stays quiet when the declared capacity meets the rate", () => {
    const enough = ratedApplication({
      expectedRatePerSecond: 500,
      dispatcher: { batchSize: 25, roundsPerSecond: 20 },
    });
    expect(enough.diagnostics ?? []).toEqual([]);
    expect(enough.graph.outboxes[0]).toMatchObject({
      expectedRatePerSecond: 500,
      dispatchCapacityPerSecond: 500,
    });
  });

  it("computes no capacity, and warns nothing, unless the dispatcher declares its cadence", () => {
    const partial = ratedApplication({
      expectedRatePerSecond: 500,
      dispatcher: { batchSize: 25 },
    });
    expect(partial.diagnostics ?? []).toEqual([]);
    expect(partial.graph.outboxes[0]).not.toHaveProperty("dispatchCapacityPerSecond");
    expect(partial.graph.outboxes[0]).toMatchObject({ expectedRatePerSecond: 500 });
    const unrated = ratedApplication({ dispatcher: { batchSize: 1, roundsPerSecond: 1 } });
    expect(unrated.diagnostics ?? []).toEqual([]);
    expect(unrated.graph.outboxes[0]).not.toHaveProperty("expectedRatePerSecond");
    expect(unrated.graph.outboxes[0]).toMatchObject({ dispatchCapacityPerSecond: 1 });
  });

  it("rejects writers outside write transactions and outboxes without a dispatcher", () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const providers = [
      valueProvider(unitOfWork, fakeUnitOfWork()),
      valueProvider(outbox.writer, backend),
    ];

    expect(
      codes([
        defineModule({
          id: "reports",
          operations: [writeOperation(outbox, "read")],
          providers,
          imports: [],
          exports: [],
        }),
      ]),
    ).toEqual(["SHIP_OUTBOX_DISPATCHER_MISSING", "SHIP_OUTBOX_WRITER_TRANSACTION_INVALID"]);
    expect(
      codes([
        defineModule({
          id: "reports",
          operations: [writeOperation(outbox, "none")],
          providers,
          imports: [],
          exports: [],
        }),
      ]),
    ).toContain("SHIP_OUTBOX_WRITER_TRANSACTION_INVALID");
  });

  it("rejects dispatchers that leave an intent uncovered and non-singleton outbox providers", () => {
    const outbox = fixtureOutbox();
    const backend = fakeBackend(outbox.id);
    const dispatcher = defineOutboxDispatcher(outbox, {
      batchSize: 1,
      lease: { ms: 10 },
      retry: { attempts: 1, backoff: { initialMs: 0 } },
      deadLetter: true,
      intents: ["publish"],
    });
    const module = defineModule({
      id: "reports",
      operations: [writeOperation(outbox), ...dispatcher.operations],
      providers: [
        valueProvider(unitOfWork, fakeUnitOfWork()),
        defineProvider({
          token: outbox.writer,
          dependencies: {},
          lifetime: "operation",
          create: () => backend,
        }),
        valueProvider(notifier, { send: async () => undefined }),
        valueProvider(publisher, { publish: async () => undefined }),
      ],
      imports: [],
      exports: [],
    });

    expect(codes([module])).toEqual([
      "SHIP_OUTBOX_INTENT_UNDISPATCHED",
      "SHIP_OUTBOX_PROVIDER_LIFETIME_INVALID",
    ]);
  });

  it("rejects providers that hide outbox tokens and requires a backend provider", () => {
    const outbox = fixtureOutbox();
    const hidden = defineProvider({
      token: unitOfWork,
      dependencies: { outbox: outbox.backend },
      lifetime: "singleton",
      create: () => fakeUnitOfWork(),
    });
    const module = defineModule({
      id: "reports",
      operations: [],
      providers: [hidden],
      imports: [],
      exports: [],
    });

    expect(codes([module])).toEqual(["SHIP_PROVIDER_MISSING", "SHIP_PROVIDER_OUTBOX_FORBIDDEN"]);
  });

  it("projects outbox nodes, intent effect edges, and operation roles into the graph", () => {
    const outbox = fixtureOutbox({ completedMs: 60_000, deadLetteredMs: 120_000 });
    const backend = fakeBackend(outbox.id);
    const dispatcher = defineOutboxDispatcher(outbox, {
      batchSize: 1,
      lease: { ms: 10 },
      retry: { attempts: 1, backoff: { initialMs: 0 } },
      deadLetter: true,
    });
    const module = defineModule({
      id: "reports",
      operations: [writeOperation(outbox), ...dispatcher.operations, defineOutboxCleanup(outbox)],
      providers: [
        valueProvider(unitOfWork, fakeUnitOfWork()),
        valueProvider(outbox.writer, backend),
        valueProvider(notifier, { send: async () => undefined }),
        valueProvider(publisher, { publish: async () => undefined }),
      ],
      imports: [],
      exports: [],
    });
    const app = compileApp({ id: "outbox-graph", modules: [module] });

    expect(app.graph.outboxes).toEqual([
      {
        id: "reports.outbox",
        providerId: "reports.outbox",
        intents: [
          { id: "notify", effectId: "reports.notifier", payloadVendor: "zod" },
          { id: "publish", effectId: "events.publisher", payloadVendor: "zod" },
        ],
        retention: { completedMs: 60_000, deadLetteredMs: 120_000 },
        operations: {
          writers: ["reports.request"],
          dispatchers: ["reports.outbox.dispatch"],
          cleanups: ["reports.outbox.cleanup"],
          management: [
            "reports.outbox.discard",
            "reports.outbox.list-dead-lettered",
            "reports.outbox.retry",
          ],
        },
      },
    ]);
    const byId = Object.fromEntries(app.graph.operations.map((node) => [node.id, node]));
    expect(byId["reports.request"]).toMatchObject({
      outbox: [{ id: "reports.outbox", role: "writer" }],
      dependencies: expect.arrayContaining([
        { name: "outbox", providerId: "reports.outbox", scope: "outbox", role: "writer" },
      ]),
    });
    expect(byId["reports.outbox.dispatch"]).toMatchObject({
      access: { kind: "system" },
      outbox: [{ id: "reports.outbox", role: "dispatcher", intents: ["notify", "publish"] }],
      effects: [
        { id: "events.publisher", delivery: "immediate" },
        { id: "reports.notifier", delivery: "immediate" },
      ],
    });
    expect(byId["reports.outbox.cleanup"]?.outbox).toEqual([
      { id: "reports.outbox", role: "cleanup" },
    ]);
    expect(byId["reports.outbox.retry"]?.outbox).toEqual([
      { id: "reports.outbox", role: "management" },
    ]);
    expect(app.graph.providers.find((node) => node.id === "reports.outbox")).toMatchObject({
      scope: "outbox",
      lifetime: "singleton",
    });
    expect(JSON.parse(JSON.stringify(app.graph))).toEqual(app.graph);
  });

  it("fails at execution when the bound provider is not a backend for that outbox", async () => {
    const outbox = fixtureOutbox();
    const other = fakeBackend("other.outbox");
    const dispatcher = defineOutboxDispatcher(outbox, {
      batchSize: 1,
      lease: { ms: 10 },
      retry: { attempts: 1, backoff: { initialMs: 0 } },
      deadLetter: true,
    });
    const module = defineModule({
      id: "reports",
      operations: dispatcher.operations,
      providers: [
        valueProvider(outbox.writer, other),
        valueProvider(notifier, { send: async () => undefined }),
        valueProvider(publisher, { publish: async () => undefined }),
      ],
      imports: [],
      exports: [],
    });
    const executor = createExecutor(defineApp({ id: "mismatch", modules: [module] }));

    await expect(
      executor.run("reports.outbox.dispatch", {}, { actor: systemActor({ id: "d" }) }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_OUTBOX_BACKEND_INVALID" });
    expect(isOutboxBackend(other)).toBe(true);
    expect(isOutboxBackend({ kind: "ship.outbox-backend", outboxId: "x" })).toBe(false);
  });

  it("serializes record views with ISO timestamps", () => {
    const now = new Date("2026-09-18T00:00:00.000Z");
    expect(
      outboxRecordView({
        id: "r1",
        outboxId: "reports.outbox",
        intentId: "notify",
        payload: { a: 1 },
        dedupeKey: "k",
        status: "discarded",
        attempts: 2,
        availableAt: now,
        createdAt: now,
        lastError: "x",
        deadLetteredAt: now,
        discardedAt: now,
        discardReason: "old",
      }),
    ).toEqual({
      id: "r1",
      intentId: "notify",
      payload: { a: 1 },
      dedupeKey: "k",
      status: "discarded",
      attempts: 2,
      availableAt: "2026-09-18T00:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
      lastError: "x",
      deadLetteredAt: "2026-09-18T00:00:00.000Z",
      discardedAt: "2026-09-18T00:00:00.000Z",
      discardReason: "old",
    });
  });
});
