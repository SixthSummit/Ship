import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  createExecutor,
  defineApp,
  defineJob,
  defineJobManagement,
  defineModule,
  humanActor,
  JOBS_MANAGE_PERMISSION,
  type JobRuntime,
  jobBackendDependency,
  startJobRuntime,
  valueProvider,
} from "@sixthsummit/ship-core";
import { jobBackendConformance } from "@sixthsummit/ship-testing/jobs-conformance";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type RedisTestContainer,
  startRedis,
  uniquePrefix,
  waitFor,
} from "./__fixtures__/redis.js";
import { type BullmqJobBackendOptions, createBullmqJobBackend } from "./backend.js";
import { JOB_ATTRIBUTES, JOB_METRICS, METER_NAME } from "./metrics.js";

let redis: RedisTestContainer;
let client: Redis;

beforeAll(async () => {
  redis = await startRedis();
  client = new Redis(redis.url);
}, 120_000);

afterAll(async () => {
  await client?.quit().catch(() => undefined);
  await redis?.stop();
}, 60_000);

function backend(options: Partial<BullmqJobBackendOptions> = {}) {
  return createBullmqJobBackend({
    connection: { host: redis.host, port: redis.port, maxRetriesPerRequest: null },
    prefix: uniquePrefix("bullmq"),
    worker: { lockDuration: 2_000, stalledInterval: 1_000 },
    ...options,
  });
}

jobBackendConformance(
  "bullmq",
  (options) => backend(options),
  { describe, it, beforeEach, afterEach, expect },
  { timeoutMs: 15_000 },
);

describe("BullMQ bounded result observation", () => {
  it("returns pending without cancelling a queued run, then returns its retained result after a retry", async () => {
    const bullmq = backend();
    let attempts = 0;
    bullmq.attach({
      jobs: [
        {
          id: "result.summary",
          input: z.object({ location: z.string() }),
          trigger: { kind: "http", access: { kind: "system" } },
          concurrency: { mode: "parallel", max: 1, keyed: false, leaseMs: 1_000 },
          retry: { attempts: 2, backoff: { initialMs: 10 } },
          transaction: "none",
        },
      ],
      execute: async () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: "temporary", retryable: true }
          : { ok: true, data: { sent: 1, failed: 0 } };
      },
    });
    try {
      const enqueued = await bullmq.enqueue("result.summary", { location: "one" });
      expect(enqueued.accepted).toBe(true);
      if (!enqueued.accepted) return;
      expect(await bullmq.waitForResult(enqueued.runId, { timeoutMs: 5 })).toEqual({
        status: "pending",
        runId: enqueued.runId,
      });
      await bullmq.startWorkers("worker");
      expect(await bullmq.waitForResult(enqueued.runId, { timeoutMs: 5_000 })).toEqual({
        status: "completed",
        runId: enqueued.runId,
        data: { sent: 1, failed: 0 },
      });
      expect(attempts).toBe(2);
    } finally {
      await bullmq.quit();
    }
  });

  it("reports a final failed run and never treats a missing run as completed", async () => {
    const bullmq = backend();
    bullmq.attach({
      jobs: [
        {
          id: "result.failure",
          input: z.object({}),
          trigger: { kind: "http", access: { kind: "system" } },
          concurrency: { mode: "parallel", max: 1, keyed: false, leaseMs: 1_000 },
          retry: { attempts: 1, backoff: { initialMs: 10 } },
          transaction: "none",
        },
      ],
      execute: async () => ({ ok: false, error: "remote effect held", retryable: false }),
    });
    try {
      expect(await bullmq.waitForResult("result.failure/absent", { timeoutMs: 10 })).toEqual({
        status: "missing",
        runId: "result.failure/absent",
      });
      const enqueued = await bullmq.enqueue("result.failure", {});
      expect(enqueued.accepted).toBe(true);
      if (!enqueued.accepted) return;
      await bullmq.startWorkers("worker");
      expect(await bullmq.waitForResult(enqueued.runId, { timeoutMs: 5_000 })).toEqual({
        status: "failed",
        runId: enqueued.runId,
        error: "remote effect held",
      });
    } finally {
      await bullmq.quit();
    }
  });

  it("reuses a retained terminal result for the same scheduler delivery key", async () => {
    const bullmq = backend();
    let executions = 0;
    bullmq.attach({
      jobs: [
        {
          id: "result.delivery",
          input: z.object({}),
          trigger: { kind: "http", access: { kind: "system" } },
          concurrency: { mode: "parallel", max: 1, keyed: false, leaseMs: 1_000 },
          retry: { attempts: 1, backoff: { initialMs: 10 } },
          transaction: "none",
        },
      ],
      execute: async () => ({ ok: true, data: { executions: ++executions } }),
    });
    try {
      const first = await bullmq.enqueue(
        "result.delivery",
        {},
        {
          dedupeKey: "scheduler:2026-10-01T00:00:00Z",
          reuseTerminalDedupe: true,
        },
      );
      expect(first.accepted).toBe(true);
      if (!first.accepted) return;
      await bullmq.startWorkers("worker");
      expect(await bullmq.waitForResult(first.runId, { timeoutMs: 5_000 })).toMatchObject({
        status: "completed",
        data: { executions: 1 },
      });
      const retry = await bullmq.enqueue(
        "result.delivery",
        {},
        {
          dedupeKey: "scheduler:2026-10-01T00:00:00Z",
          reuseTerminalDedupe: true,
        },
      );
      expect(retry).toEqual({ accepted: true, runId: first.runId, deduplicated: true });
      expect(await bullmq.waitForResult(first.runId, { timeoutMs: 50 })).toMatchObject({
        status: "completed",
        data: { executions: 1 },
      });
      expect(executions).toBe(1);
    } finally {
      await bullmq.quit();
    }
  });

  it("keeps distinct retained delivery keys distinct even when legacy slugging would collide", async () => {
    const bullmq = backend();
    bullmq.attach({
      jobs: [
        {
          id: "result.keys",
          input: z.object({}),
          trigger: { kind: "http", access: { kind: "system" } },
          concurrency: { mode: "parallel", max: 1, keyed: false, leaseMs: 1_000 },
          retry: { attempts: 1, backoff: { initialMs: 10 } },
          transaction: "none",
        },
      ],
      execute: async () => ({ ok: true, data: {} }),
    });
    try {
      const first = await bullmq.enqueue(
        "result.keys",
        {},
        {
          dedupeKey: "a:b",
          reuseTerminalDedupe: true,
        },
      );
      const second = await bullmq.enqueue(
        "result.keys",
        {},
        {
          dedupeKey: "a/b",
          reuseTerminalDedupe: true,
        },
      );
      expect(first.accepted && second.accepted).toBe(true);
      if (!first.accepted || !second.accepted) return;
      expect(first.runId).not.toBe(second.runId);
      expect(second.deduplicated).toBe(false);
    } finally {
      await bullmq.quit();
    }
  });
});

describe("BullMQ backpressure", () => {
  let runtime: JobRuntime | undefined;
  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it("returns queue-full past the configured depth", async () => {
    const limited = backend({ maxQueueDepth: 5 });
    limited.attach({
      jobs: [
        {
          id: "bp.limited",
          input: z.object({}),
          trigger: { kind: "enqueue" },
          concurrency: { mode: "parallel", max: 1, keyed: false, leaseMs: 1_000 },
          retry: { attempts: 1, backoff: { initialMs: 10 } },
          transaction: "none",
        },
      ],
      execute: async () => ({ ok: true, data: undefined }),
    });
    for (let index = 0; index < 5; index += 1) {
      expect(await limited.enqueue("bp.limited", { index })).toMatchObject({ accepted: true });
    }
    expect(await limited.enqueue("bp.limited", { index: 5 })).toEqual({
      accepted: false,
      rejected: "queue-full",
    });
    await limited.quit();
  });

  it("keeps in-flight runs at or below max under a 10x burst", async () => {
    const prefix = uniquePrefix("burst");
    const counter = `${prefix}:in-flight`;
    const peakKey = `${prefix}:peak`;
    const work = defineJob({
      id: "bp.work",
      input: z.object({ index: z.number().int() }),
      trigger: { kind: "enqueue" },
      concurrency: { mode: "parallel", max: 3 },
      retry: { attempts: 1, backoff: { initialMs: 10 } },
      transaction: "none",
      dependencies: {},
      handler: async () => {
        const current = await client.incr(counter);
        const peak = Number((await client.get(peakKey)) ?? 0);
        if (current > peak) await client.set(peakKey, String(current));
        await new Promise((resolve) => setTimeout(resolve, 60));
        await client.decr(counter);
      },
    });
    const bullmq = backend({ prefix, maxInFlight: 10 });
    const app = defineApp({
      id: "burst",
      modules: [
        defineModule({
          id: "bp",
          operations: [work],
          providers: [valueProvider(jobBackendDependency(), bullmq)],
          imports: [],
          exports: [],
        }),
      ],
    });
    runtime = await startJobRuntime(app, { backend: bullmq, mode: "worker" });
    for (let index = 0; index < 30; index += 1) {
      expect(await bullmq.enqueue("bp.work", { index })).toMatchObject({ accepted: true });
    }
    await waitFor(async () => {
      const counts = await bullmq.queue("bp.work").getJobCounts("completed");
      return counts.completed === 30;
    }, "the burst to drain");
    expect(Number(await client.get(peakKey))).toBeGreaterThanOrEqual(2);
    expect(Number(await client.get(peakKey))).toBeLessThanOrEqual(3);
  }, 60_000);
});

describe("BullMQ dead-letter management through the executor", () => {
  it("dead-letters after retry.attempts, retries once and discards behind the manage permission", async () => {
    const prefix = uniquePrefix("dead-letter");
    const flag = `${prefix}:succeed`;
    const flaky = defineJob({
      id: "dl.flaky",
      input: z.object({ key: z.string() }),
      trigger: { kind: "enqueue" },
      concurrency: { mode: "parallel", max: 1 },
      retry: { attempts: 2, backoff: { initialMs: 20 } },
      transaction: "none",
      dependencies: {},
      handler: async ({ input }) => {
        if ((await client.get(flag)) !== "yes") throw new Error(`still failing for ${input.key}`);
        return { key: input.key };
      },
    });
    const management = defineJobManagement();
    const bullmq = backend({ prefix });
    const app = defineApp({
      id: "dead-letter",
      modules: [
        defineModule({
          id: "dl",
          operations: [flaky],
          providers: [valueProvider(jobBackendDependency(), bullmq)],
          imports: [],
          exports: [jobBackendDependency()],
        }),
        defineModule({
          id: "jobs",
          operations: management.operations,
          providers: [],
          imports: ["dl"],
          exports: [],
        }),
      ],
    });
    const runtime = await startJobRuntime(app, { backend: bullmq, mode: "worker" });
    const executor = createExecutor(app);
    const admin = humanActor({ id: "admin", permissions: [JOBS_MANAGE_PERMISSION] });
    const viewer = humanActor({ id: "viewer", permissions: ["reports:read"] });
    try {
      const accepted = await bullmq.enqueue("dl.flaky", { key: "one" });
      if (!accepted.accepted) throw new Error("rejected");
      await waitFor(
        async () => (await bullmq.listFailed({ limit: 5 })).length === 1,
        "dead-letter",
      );

      await expect(
        executor.run("jobs.list-failed", { query: {} }, { actor: viewer }),
      ).resolves.toMatchObject({
        ok: false,
        status: 403,
      });
      const listed = await executor.run("jobs.list-failed", { query: {} }, { actor: admin });
      expect(listed).toMatchObject({
        ok: true,
        data: {
          runs: [
            {
              runId: accepted.runId,
              jobId: "dl.flaky",
              input: { key: "one" },
              status: "failed",
              attempts: 2,
              lastError: expect.stringContaining("still failing for one"),
            },
          ],
        },
      });
      if (!listed.ok) throw new Error("unreachable");
      expect(listed.data.runs[0]?.history.map((item) => item.attempt)).toEqual([1, 2]);

      await client.set(flag, "yes");
      await expect(
        executor.run("jobs.retry", { body: { runId: accepted.runId } }, { actor: viewer }),
      ).resolves.toMatchObject({ ok: false, status: 403 });
      await expect(
        executor.run("jobs.retry", { body: { runId: accepted.runId } }, { actor: admin }),
      ).resolves.toMatchObject({ ok: true, data: { run: { status: "waiting" } } });
      await waitFor(
        async () => (await bullmq.queue("dl.flaky").getJobCounts("completed")).completed === 1,
        "the retried run to complete",
      );
      expect(await bullmq.listFailed({ limit: 5 })).toHaveLength(0);

      await client.del(flag);
      const second = await bullmq.enqueue("dl.flaky", { key: "two" });
      if (!second.accepted) throw new Error("rejected");
      await waitFor(
        async () => (await bullmq.listFailed({ limit: 5 })).length === 1,
        "second dead-letter",
      );
      await expect(
        executor.run(
          "jobs.discard",
          { body: { runId: second.runId, reason: "gave up" } },
          { actor: viewer },
        ),
      ).resolves.toMatchObject({ ok: false, status: 403 });
      await expect(
        executor.run(
          "jobs.discard",
          { body: { runId: second.runId, reason: "gave up" } },
          { actor: admin },
        ),
      ).resolves.toMatchObject({
        ok: true,
        data: { run: { status: "discarded", discardReason: "gave up" } },
      });
      expect(await bullmq.listFailed({ limit: 5 })).toHaveLength(0);
      await expect(
        executor.run(
          "jobs.discard",
          { body: { runId: second.runId, reason: "again" } },
          { actor: admin },
        ),
      ).resolves.toMatchObject({ ok: false, status: 404, error: { code: "JOB_RUN_NOT_FOUND" } });
      await expect(executor.run("jobs.health", {}, { actor: admin })).resolves.toMatchObject({
        ok: true,
        data: { jobs: [expect.objectContaining({ jobId: "dl.flaky", failed: 0 })] },
      });
    } finally {
      await runtime.stop();
    }
  }, 60_000);
});

describe("BullMQ OpenTelemetry metrics", () => {
  it("emits run, queue and dead-letter metrics for a scheduled and an enqueued job", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const meterProvider = new MeterProvider({ readers: [reader] });
    const scheduled = defineJob({
      id: "metrics.tick",
      input: z.object({}),
      trigger: { kind: "interval", everyMs: 300 },
      concurrency: { mode: "parallel" },
      retry: { attempts: 1, backoff: { initialMs: 10 } },
      transaction: "none",
      dependencies: {},
      handler: async () => ({ ticked: true }),
    });
    const enqueued = defineJob({
      id: "metrics.work",
      input: z.object({ tenantId: z.string() }),
      trigger: { kind: "enqueue" },
      concurrency: { mode: "parallel", key: (input) => input.tenantId },
      retry: { attempts: 1, backoff: { initialMs: 10 } },
      transaction: "none",
      dependencies: {},
      handler: async ({ input }) => {
        if (input.tenantId === "broken") throw new Error("broken tenant");
        return { tenantId: input.tenantId };
      },
    });
    const bullmq = backend({ meterProvider });
    const app = defineApp({
      id: "metrics",
      modules: [
        defineModule({
          id: "metrics",
          operations: [scheduled, enqueued],
          providers: [valueProvider(jobBackendDependency(), bullmq)],
          imports: [],
          exports: [],
        }),
      ],
    });
    const runtime = await startJobRuntime(app, { backend: bullmq, mode: "worker" });
    try {
      await bullmq.enqueue("metrics.work", { tenantId: "acme" });
      await bullmq.enqueue("metrics.work", { tenantId: "broken" });
      await waitFor(async () => {
        const [tick, work] = await Promise.all([
          bullmq.queue("metrics.tick").getJobCounts("completed"),
          bullmq.queue("metrics.work").getJobCounts("completed", "failed"),
        ]);
        return (tick.completed ?? 0) >= 2 && work.completed === 1 && work.failed === 1;
      }, "both jobs to run");

      const { resourceMetrics } = await reader.collect();
      const scope = resourceMetrics.scopeMetrics.find((item) => item.scope.name === METER_NAME);
      const byName = Object.fromEntries(
        (scope?.metrics ?? []).map((metric) => [metric.descriptor.name, metric]),
      );
      const runs = (byName[JOB_METRICS.runs]?.dataPoints ?? []).map((point) => ({
        id: point.attributes[JOB_ATTRIBUTES.id],
        key: point.attributes[JOB_ATTRIBUTES.key],
        outcome: point.attributes[JOB_ATTRIBUTES.outcome],
        value: point.value,
      }));
      expect(runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "metrics.tick", key: "", outcome: "success" }),
          { id: "metrics.work", key: "acme", outcome: "success", value: 1 },
          { id: "metrics.work", key: "broken", outcome: "failure", value: 1 },
        ]),
      );
      const durations = byName[JOB_METRICS.runDuration]?.dataPoints ?? [];
      expect(durations.map((point) => point.attributes[JOB_ATTRIBUTES.id])).toEqual(
        expect.arrayContaining(["metrics.tick", "metrics.work"]),
      );
      const deadLetters = byName[JOB_METRICS.deadLetterCount]?.dataPoints ?? [];
      expect(
        deadLetters.find((point) => point.attributes[JOB_ATTRIBUTES.id] === "metrics.work")?.value,
      ).toBe(1);
      expect(
        (byName[JOB_METRICS.queueDepth]?.dataPoints ?? []).map(
          (point) => point.attributes[JOB_ATTRIBUTES.id],
        ),
      ).toEqual(expect.arrayContaining(["metrics.tick", "metrics.work"]));
      expect(byName[JOB_METRICS.oldestWaitingAge]).toBeDefined();
    } finally {
      await runtime.stop();
      await meterProvider.shutdown();
    }
  }, 60_000);
});
