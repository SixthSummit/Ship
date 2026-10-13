import { describe, expect, it } from "vitest";
import { z } from "zod";
import { publicAccess } from "./access.js";
import { operationActor } from "./actor.js";
import { defineApp } from "./application.js";
import { effectDependency, type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { type ApplicationExecutor, createExecutor } from "./executor.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import {
  defineOutbox,
  defineOutboxDispatcher,
  type OutboxBackend,
  type OutboxRecord,
  outboxDependency,
  outboxIntent,
} from "./outbox.js";
import {
  DEFAULT_OUTBOX_RUNNER_PASSES_PER_CYCLE,
  dispatchOutbox,
  OUTBOX_RUNNER_ACTOR_ID,
  type OutboxDispatchRunnerPass,
  startOutboxDispatchRunner,
} from "./outbox-runner.js";
import { valueProvider } from "./provider.js";

interface Notifier {
  send(message: { readonly subject: string }): Promise<void>;
}

const notifier = effectDependency<Notifier>("reports.notifier", { delivery: "immediate" });
const unitOfWork = unitOfWorkDependency<{ readonly records: { save(value: string): void } }>(
  "database.primary",
);
const outbox = defineOutbox({
  id: "reports.outbox",
  intents: {
    notify: outboxIntent({
      payload: z.object({ subject: z.string().min(1) }),
      effect: notifier,
      perform: ({ effect, payload }) => effect.send(payload),
    }),
  },
});
const actor = operationActor({ id: "writer", permissions: [] });
const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory backend with a controllable `send` so a pass can be held open. */
function fakeBackend() {
  const records: OutboxRecord[] = [];
  let sequence = 0;
  const replace = (id: string, patch: Partial<OutboxRecord>) => {
    const index = records.findIndex((record) => record.id === id);
    records[index] = Object.freeze({ ...records[index]!, ...patch });
    return records[index]!;
  };
  const backend: OutboxBackend & { readonly records: readonly OutboxRecord[] } = {
    kind: "ship.outbox-backend",
    outboxId: outbox.id,
    records,
    record: async (_scope, intents) =>
      intents.map((intent) => {
        sequence += 1;
        const id = `record-${sequence}`;
        records.push(
          Object.freeze({
            id,
            outboxId: outbox.id,
            intentId: intent.intentId,
            payload: intent.payload,
            status: "pending",
            attempts: 0,
            availableAt: intent.availableAt,
            createdAt: intent.availableAt,
          }),
        );
        return { recordId: id, deduplicated: false as const };
      }),
    claimDue: async (now, batchSize, leaseMs) =>
      records
        .filter((record) => record.status === "pending" && record.availableAt <= now)
        .slice(0, batchSize)
        .map((record) =>
          replace(record.id, {
            status: "claimed",
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
          }),
        ),
    claimUnknownDue: async () => [],
    complete: async (id, now) => {
      replace(id, { status: "completed", completedAt: now, leaseExpiresAt: undefined });
    },
    fail: async (id, error, disposition, now) => {
      replace(id, {
        ...("deadLetter" in disposition
          ? { status: "dead-lettered", deadLetteredAt: now }
          : { status: "pending", availableAt: disposition.retryAt }),
        lastError: error,
        leaseExpiresAt: undefined,
      });
    },
    listDeadLettered: async () => [],
    retry: async () => undefined,
    discard: async () => undefined,
    cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
    health: async () => ({ pending: 0, claimed: 0, deadLettered: 0 }),
  };
  return backend;
}

function createFixture(options: { readonly batchSize?: number } = {}) {
  const backend = fakeBackend();
  const sent: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  const dispatcher = defineOutboxDispatcher(outbox, {
    batchSize: options.batchSize ?? 10,
    lease: { ms: 1_000 },
    retry: { attempts: 2, backoff: { initialMs: 0 } },
    deadLetter: true,
    // Records are enqueued at real time; dispatch from an hour ahead so they are due.
    clock: () => new Date(Date.now() + 3_600_000),
  });
  const write = defineOperation({
    id: "reports.request",
    input: { body: z.object({ subject: z.string() }) },
    output: { 200: z.object({ ok: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "write",
    dependencies: { tx: unitOfWork, outbox: outboxDependency(outbox) },
    handler: async ({ input, services }) => {
      await services.outbox.enqueue("notify", { subject: input.body.subject });
      return { ok: true as const };
    },
  });
  const transaction: UnitOfWork<{ readonly records: { save(value: string): void } }> = {
    kind: "ship.unit-of-work",
    id: "database.primary",
    run: async (_mode, work) => work({ records: { save: () => undefined } }),
  };
  const module = defineModule({
    id: "reports",
    operations: [write, ...dispatcher.operations],
    providers: [
      valueProvider(unitOfWork, transaction),
      valueProvider(outbox.writer, backend),
      valueProvider(notifier, {
        send: async ({ subject }) => {
          await gate;
          sent.push(subject);
        },
      }),
    ],
    imports: [],
    exports: [],
  });
  const executor = createExecutor(defineApp({ id: "runner-fixture", modules: [module] }));
  return {
    backend,
    sent,
    executor,
    enqueue: async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        await executor.run("reports.request", { body: { subject: `s${index}` } }, { actor });
      }
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        gate = Promise.resolve();
      };
    },
    pending: () => backend.records.filter((record) => record.status === "pending").length,
  };
}

function claimedOf(passes: readonly OutboxDispatchRunnerPass[]): number[] {
  return passes.map((pass) => (pass.ok ? pass.result.claimed : -1));
}

describe("dispatchOutbox", () => {
  it("runs one pass as the framework system actor and returns the counts with the batch size", async () => {
    const fixture = createFixture({ batchSize: 3 });
    await fixture.enqueue(2);
    await expect(dispatchOutbox(fixture.executor, "reports.outbox.dispatch")).resolves.toEqual({
      batchSize: 3,
      claimed: 2,
      completed: 2,
      retried: 0,
      deadLettered: 0,
    });
    expect(fixture.sent).toEqual(["s0", "s1"]);
    expect(OUTBOX_RUNNER_ACTOR_ID).toBe("ship.outbox.dispatcher");
  });

  it("reports a dispatcher that is not composed as SHIP_OUTBOX_DISPATCH_FAILED", async () => {
    const fixture = createFixture();
    await expect(dispatchOutbox(fixture.executor, "billing.outbox.dispatch")).rejects.toMatchObject(
      {
        code: "SHIP_OUTBOX_DISPATCH_FAILED",
        operationId: "billing.outbox.dispatch",
        message: expect.stringContaining("not composed"),
      },
    );
  });
});

describe("startOutboxDispatchRunner", () => {
  it("validates its options, the operation id and the executor", () => {
    const executor = createFixture().executor;
    for (const options of [
      { intervalMs: 0 },
      { intervalMs: 2.5 },
      { maxPassesPerCycle: 0 },
      { backoff: { initialMs: 0 } },
      { backoff: "fast" as never },
    ]) {
      expect(() => startOutboxDispatchRunner(executor, "reports.outbox.dispatch", options)).toThrow(
        expect.objectContaining({ code: "SHIP_OUTBOX_RUNNER_INVALID" }),
      );
    }
    expect(() => startOutboxDispatchRunner(executor, "" as never)).toThrow(
      expect.objectContaining({ code: "SHIP_OUTBOX_RUNNER_INVALID" }),
    );
    expect(() => startOutboxDispatchRunner({} as never, "reports.outbox.dispatch")).toThrow(
      expect.objectContaining({ code: "SHIP_OUTBOX_RUNNER_INVALID" }),
    );
    expect(DEFAULT_OUTBOX_RUNNER_PASSES_PER_CYCLE).toBe(10);
  });

  it("follows a full batch with the next pass at once and sleeps the interval only after a short one", async () => {
    const fixture = createFixture({ batchSize: 4 });
    // 9 records at batch 4: full, full, short (1), then an idle pass after the interval.
    await fixture.enqueue(9);
    const passes: OutboxDispatchRunnerPass[] = [];
    const runner = startOutboxDispatchRunner(fixture.executor, "reports.outbox.dispatch", {
      intervalMs: 500,
      observer: { pass: (pass) => passes.push(pass) },
    });
    expect(runner.kind).toBe("ship.outbox-dispatch-runner");
    expect(runner.operationId).toBe("reports.outbox.dispatch");
    expect(runner.running).toBe(true);
    await settle(60);
    // Three passes without waiting for the 500 ms interval; the short third pass
    // then idles, so nothing else ran inside the settle window.
    expect(claimedOf(passes)).toEqual([4, 4, 1]);
    expect(fixture.sent).toHaveLength(9);
    expect(passes.every((pass) => pass.ok && pass.result.batchSize === 4)).toBe(true);
    expect(runner.passes).toBe(3);
    await runner.stop();
    expect(runner.running).toBe(false);
  });

  it("sleeps the interval after an empty pass instead of spinning", async () => {
    const fixture = createFixture({ batchSize: 4 });
    const passes: OutboxDispatchRunnerPass[] = [];
    const runner = startOutboxDispatchRunner(fixture.executor, "reports.outbox.dispatch", {
      intervalMs: 20,
      observer: { pass: (pass) => passes.push(pass) },
    });
    await settle(75);
    await runner.stop();
    // One pass per interval at most: an empty pass never triggers an immediate next round.
    expect(passes.length).toBeGreaterThanOrEqual(2);
    expect(passes.length).toBeLessThanOrEqual(5);
    expect(claimedOf(passes).every((claimed) => claimed === 0)).toBe(true);
  });

  it("caps consecutive full passes per cycle and yields to the interval", async () => {
    const fixture = createFixture({ batchSize: 2 });
    await fixture.enqueue(10);
    const passes: OutboxDispatchRunnerPass[] = [];
    const runner = startOutboxDispatchRunner(fixture.executor, "reports.outbox.dispatch", {
      intervalMs: 1_000,
      maxPassesPerCycle: 3,
      observer: { pass: (pass) => passes.push(pass) },
    });
    await settle(60);
    expect(claimedOf(passes)).toEqual([2, 2, 2]);
    expect(fixture.pending()).toBe(4);
    await runner.stop();
  });

  it("stops gracefully in the middle of a drain: the in-flight pass finishes, no further pass starts", async () => {
    const fixture = createFixture({ batchSize: 2 });
    await fixture.enqueue(8);
    const release = fixture.hold();
    const passes: OutboxDispatchRunnerPass[] = [];
    const runner = startOutboxDispatchRunner(fixture.executor, "reports.outbox.dispatch", {
      intervalMs: 5,
      observer: { pass: (pass) => passes.push(pass) },
    });
    await settle(20);
    // The first pass has claimed a full batch and is blocked inside the effect.
    expect(passes).toEqual([]);
    expect(fixture.backend.records.filter((record) => record.status === "claimed")).toHaveLength(2);
    const stopped = runner.stop();
    expect(runner.running).toBe(false);
    release();
    await stopped;
    // The in-flight pass completed its batch; the full result did not start another.
    expect(claimedOf(passes)).toEqual([2]);
    expect(fixture.sent).toEqual(["s0", "s1"]);
    expect(fixture.pending()).toBe(6);
    await settle(30);
    expect(runner.passes).toBe(1);
    // runOnce() still drains after stop, and is serialized.
    const [first, second] = await Promise.all([runner.runOnce(), runner.runOnce()]);
    expect(first.claimed + second.claimed).toBe(4);
    await runner.stop();
  });

  it("backs off after a failed pass, keeps running and reports every failure", async () => {
    const fixture = createFixture();
    let calls = 0;
    const failing: ApplicationExecutor<never> = {
      run: (async (...arguments_: Parameters<typeof fixture.executor.run>) => {
        calls += 1;
        if (calls <= 2) throw new Error(`boom ${calls}`);
        return fixture.executor.run(...arguments_);
      }) as never,
      tryRun: (() => {
        throw new Error("unused");
      }) as never,
    };
    const failures: { failures: number; retryInMs: number }[] = [];
    const observed: OutboxDispatchRunnerPass[] = [];
    const runner = startOutboxDispatchRunner(failing, "reports.outbox.dispatch", {
      intervalMs: 5,
      backoff: { initialMs: 5, multiplier: 2, maxMs: 20 },
      observer: { pass: (pass) => observed.push(pass) },
      onError: (error, pass) => {
        expect(error).toBeInstanceOf(Error);
        failures.push({ failures: pass.failures, retryInMs: pass.retryInMs });
      },
    });
    await settle(80);
    await runner.stop();
    expect(failures).toEqual([
      { failures: 1, retryInMs: 5 },
      { failures: 2, retryInMs: 10 },
    ]);
    expect(observed.slice(0, 3)).toMatchObject([
      { ok: false, failures: 1 },
      { ok: false, failures: 2 },
      { ok: true, result: { claimed: 0 } },
    ]);
    calls = 0;
    await expect(runner.runOnce()).rejects.toThrow("boom 1");
  });
});
