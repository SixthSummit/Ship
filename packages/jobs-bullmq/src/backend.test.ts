import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { JobRuntimeBinding, JobRuntimeDeclaration } from "@sixthsummit/ship-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BullMQ is replaced by an in-memory emulation of the queue, worker and job
 * surface the adapter uses, so unit tests never dial Redis. Real-Redis
 * behavior is covered by the integration suite.
 */
type FakeState = "waiting" | "delayed" | "active" | "completed" | "failed";

class FakeJob {
  id: string;
  name: string;
  data: { input: unknown; key?: string; history: { attempt: number; error: string; at: string }[] };
  opts: { jobId?: string; delay?: number; attempts?: number };
  attemptsMade = 0;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason = "";
  state: FakeState;
  moved: number[] = [];

  constructor(
    id: string,
    name: string,
    data: FakeJob["data"],
    opts: FakeJob["opts"],
    timestamp: number,
  ) {
    this.id = id;
    this.name = name;
    this.data = data;
    this.opts = opts;
    this.timestamp = timestamp;
    this.state = opts.delay ? "delayed" : "waiting";
  }

  async getState() {
    return this.state;
  }
  async isFailed() {
    return this.state === "failed";
  }
  async retry() {
    this.state = "waiting";
  }
  async remove() {
    FakeQueue.instances.get(this.name)?.jobs.delete(this.id);
  }
  async updateData(data: FakeJob["data"]) {
    this.data = data;
  }
  async moveToDelayed(timestamp: number) {
    this.moved.push(timestamp);
    this.state = "delayed";
  }
}

class FakeQueue {
  static instances = new Map<string, FakeQueue>();
  static now = 100_000;
  name: string;
  jobs = new Map<string, FakeJob>();
  schedulers = new Map<string, unknown>();
  hashes = new Map<string, Map<string, string>>();
  closed = false;
  errors: unknown[] = [];
  sequence = 0;
  client = Promise.resolve({
    hset: async (key: string, field: string, value: string) => {
      const hash = this.hashes.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      this.hashes.set(key, hash);
    },
    hget: async (key: string, field: string) => this.hashes.get(key)?.get(field) ?? null,
  });

  constructor(name: string) {
    this.name = name;
    FakeQueue.instances.set(name, this);
  }
  on() {
    return this;
  }
  async getJob(id: string) {
    return this.jobs.get(id);
  }
  async getJobCounts(...types: string[]) {
    const counts: Record<string, number> = {};
    for (const type of types) {
      counts[type] = [...this.jobs.values()].filter((job) => job.state === type).length;
    }
    return counts;
  }
  async add(name: string, data: FakeJob["data"], opts: FakeJob["opts"] = {}) {
    const id = opts.jobId ?? String(++this.sequence);
    const existing = this.jobs.get(id);
    if (existing) return existing;
    const job = new FakeJob(id, name, data, opts, FakeQueue.now);
    this.jobs.set(id, job);
    return job;
  }
  async upsertJobScheduler(id: string, repeat: unknown, template: unknown) {
    this.schedulers.set(id, { repeat, template });
  }
  async removeJobScheduler(id: string) {
    return this.schedulers.delete(id);
  }
  async getWaiting() {
    return [...this.jobs.values()]
      .filter((job) => job.state === "waiting")
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(0, 1);
  }
  async getFailed(start: number, end: number) {
    return [...this.jobs.values()].filter((job) => job.state === "failed").slice(start, end + 1);
  }
  async clean(grace: number, _limit: number, type: string) {
    const removed: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.state === type && (job.finishedOn ?? 0) <= FakeQueue.now - grace) {
        removed.push(job.id);
        this.jobs.delete(job.id);
      }
    }
    return removed;
  }
  async close() {
    this.closed = true;
  }
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  name: string;
  processor: (job: FakeJob, token?: string) => Promise<unknown>;
  opts: { concurrency?: number; settings?: { backoffStrategy?: (attempts: number) => number } };
  closed = false;
  closeCalls = 0;

  constructor(name: string, processor: FakeWorker["processor"], opts: FakeWorker["opts"]) {
    this.name = name;
    this.processor = processor;
    this.opts = opts;
    FakeWorker.instances.push(this);
  }
  on() {
    return this;
  }
  async close() {
    this.closeCalls += 1;
    this.closed = true;
  }
}

class FakeDelayedError extends Error {}
class FakeUnrecoverableError extends Error {}

vi.mock("bullmq", () => ({
  Queue: FakeQueue,
  Worker: FakeWorker,
  Job: { fromId: async (queue: FakeQueue, id: string) => queue.jobs.get(id) },
  DelayedError: FakeDelayedError,
  UnrecoverableError: FakeUnrecoverableError,
}));

const { createBullmqJobBackend } = await import("./backend.js");
const { JOB_METRICS } = await import("./metrics.js");

const schema = {
  "~standard": { version: 1 as const, vendor: "test", validate: (value: unknown) => ({ value }) },
};

function declaration(
  id: string,
  overrides: Partial<JobRuntimeDeclaration> = {},
): JobRuntimeDeclaration {
  return {
    id,
    input: schema,
    trigger: { kind: "enqueue" },
    concurrency: { mode: "parallel", max: 2, keyed: false, leaseMs: 1_000 },
    retry: { attempts: 3, backoff: { initialMs: 100 } },
    retention: { completedMs: 1_000, deadLetteredMs: 2_000 },
    transaction: "none",
    ...overrides,
  };
}

const jobs: readonly JobRuntimeDeclaration[] = [
  declaration("reports.digest", {
    trigger: { kind: "schedule", cron: "0 * * * *", tz: "UTC" },
    key: (input) => String((input as { tenantId?: string }).tenantId ?? ""),
  }),
  declaration("reports.render", { retention: undefined }),
];

function attach(
  backend: ReturnType<typeof createBullmqJobBackend>,
  execute: JobRuntimeBinding["execute"] = async () => ({ ok: true, data: { done: true } }),
) {
  backend.attach({ jobs, execute });
  return backend;
}

describe("createBullmqJobBackend", () => {
  beforeEach(() => {
    FakeQueue.instances.clear();
    FakeWorker.instances = [];
    FakeQueue.now = 100_000;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates options and exposes the budget", () => {
    expect(() => createBullmqJobBackend({} as never)).toThrow(TypeError);
    expect(() => createBullmqJobBackend({ connection: {}, maxInFlight: 0 })).toThrow(TypeError);
    expect(() => createBullmqJobBackend({ connection: {}, prefix: "bad prefix" })).toThrow(
      TypeError,
    );
    const backend = createBullmqJobBackend({ connection: {}, maxQueueDepth: 2, maxInFlight: 3 });
    expect(backend).toMatchObject({
      adapter: "bullmq",
      prefix: "ship",
      concurrencyBudget: { maxInFlight: 3, maxQueueDepth: 2 },
    });
  });

  it("enqueues with dedupe ids, keys and queue-full backpressure", async () => {
    const backend = attach(createBullmqJobBackend({ connection: {}, maxQueueDepth: 2 }));
    await expect(backend.enqueue("reports.missing", {})).rejects.toThrow(/knows no job/u);

    const first = await backend.enqueue(
      "reports.digest",
      { tenantId: "acme" },
      { dedupeKey: "acme:1" },
    );
    expect(first).toEqual({
      accepted: true,
      runId: "reports.digest/dedupe-acme-1",
      deduplicated: false,
    });
    const duplicate = await backend.enqueue(
      "reports.digest",
      { tenantId: "acme" },
      { dedupeKey: "acme:1" },
    );
    expect(duplicate).toEqual({
      accepted: true,
      runId: "reports.digest/dedupe-acme-1",
      deduplicated: true,
    });
    const queue = FakeQueue.instances.get("reports.digest") as FakeQueue;
    expect(queue.jobs.get("dedupe-acme-1")?.data).toEqual({
      input: { tenantId: "acme" },
      key: "acme",
      history: [],
    });
    expect(queue.jobs.get("dedupe-acme-1")?.opts).toMatchObject({
      attempts: 3,
      backoff: { type: "ship" },
      removeOnComplete: { age: 1 },
      removeOnFail: false,
    });

    const delayed = await backend.enqueue("reports.digest", { tenantId: "beta" }, { delayMs: 500 });
    expect(delayed).toMatchObject({ accepted: true, deduplicated: false });
    expect(await backend.enqueue("reports.digest", { tenantId: "gamma" })).toEqual({
      accepted: false,
      rejected: "queue-full",
    });

    // A terminal duplicate is replaced instead of blocking a new run.
    (queue.jobs.get("dedupe-acme-1") as FakeJob).state = "completed";
    queue.jobs.get("2")?.remove();
    const replaced = await backend.enqueue(
      "reports.digest",
      { tenantId: "acme" },
      { dedupeKey: "acme:1" },
    );
    expect(replaced).toMatchObject({ accepted: true, deduplicated: false });
  });

  it("upserts and removes schedulers and reconciles stale ones when workers start", async () => {
    const backend = attach(createBullmqJobBackend({ connection: {} }));
    await backend.schedule("reports.digest", { kind: "schedule", cron: "0 * * * *", tz: "UTC" });
    await backend.schedule("reports.digest", { kind: "interval", everyMs: 60_000 });
    const digest = FakeQueue.instances.get("reports.digest") as FakeQueue;
    expect(digest.schedulers.size).toBe(1);
    expect(digest.schedulers.get("schedule")).toMatchObject({ repeat: { every: 60_000 } });

    await backend.schedule("reports.render", { kind: "interval", everyMs: 1_000 });
    expect(await backend.startWorkers("api")).toBe(0);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(await backend.startWorkers("worker", { maxInFlight: 1 })).toBe(2);
    expect(await backend.startWorkers("all")).toBe(2);
    expect(FakeWorker.instances.map((worker) => worker.name)).toEqual([
      "reports.digest",
      "reports.render",
    ]);
    expect(FakeWorker.instances[0]?.opts.concurrency).toBe(2);
    expect(FakeWorker.instances[0]?.opts.settings?.backoffStrategy?.(2)).toBe(200);
    // reports.render is enqueue-triggered, so its stale scheduler is removed at boot.
    expect(FakeQueue.instances.get("reports.render")?.schedulers.size).toBe(0);
    await backend.unschedule("reports.digest");
    expect(digest.schedulers.size).toBe(0);

    await backend.quit();
    expect(FakeWorker.instances.every((worker) => worker.closed)).toBe(true);
    expect(digest.closed).toBe(true);
    expect(() => backend.attach({ jobs, execute: async () => ({ ok: true, data: 1 }) })).toThrow(
      /after quit/u,
    );
  });

  it("quits once, detaches the queue observer and refuses new queues afterwards", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const meterProvider = new MeterProvider({ readers: [reader] });
    const backend = attach(createBullmqJobBackend({ connection: {}, meterProvider }));
    await backend.enqueue("reports.render", {});
    expect(await backend.startWorkers("worker")).toBe(2);
    const render = FakeQueue.instances.get("reports.render") as FakeQueue;
    const counted = vi.spyOn(render, "getJobCounts");
    const gaugePoints = async () => {
      const { resourceMetrics } = await reader.collect();
      return resourceMetrics.scopeMetrics.flatMap((scope) =>
        scope.metrics
          .filter((metric) => metric.descriptor.name === JOB_METRICS.queueDepth)
          .flatMap((metric) => metric.dataPoints),
      );
    };
    expect((await gaugePoints()).map((point) => point.value)).toEqual([0, 1]);
    expect(counted).toHaveBeenCalledTimes(1);

    const worker = FakeWorker.instances[0] as FakeWorker;
    const [first, second] = [backend.quit(), backend.quit()];
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await backend.quit();
    expect(worker.closeCalls).toBe(1);
    expect(FakeQueue.instances.get("reports.render")?.closed).toBe(true);

    // A collection after quit neither reads the closed queue nor reopens one;
    // the cumulative reader only replays the last values it already has.
    FakeQueue.instances.clear();
    expect((await gaugePoints()).map((point) => point.value)).toEqual([0, 1]);
    expect(counted).toHaveBeenCalledTimes(1);
    expect(FakeQueue.instances.size).toBe(0);
    expect(() => backend.queue("reports.render")).toThrow(/has quit/u);
    await expect(backend.health(new Date())).rejects.toThrow(/has quit/u);
    await expect(backend.startWorkers("worker")).rejects.toThrow(/after quit/u);
    await meterProvider.shutdown();
  });

  it("requires attachment before workers start", async () => {
    const backend = createBullmqJobBackend({ connection: {} });
    await expect(backend.startWorkers("worker")).rejects.toThrow(/attach/u);
  });

  it("runs the processor through the binding and maps outcomes onto BullMQ semantics", async () => {
    const execute = vi.fn<JobRuntimeBinding["execute"]>();
    const backend = attach(
      createBullmqJobBackend({ connection: {}, clock: () => new Date(5_000) }),
      execute,
    );
    await backend.startWorkers("worker");
    const worker = FakeWorker.instances.find(
      (item) => item.name === "reports.digest",
    ) as FakeWorker;
    await backend.enqueue("reports.digest", { tenantId: "acme" });
    const queue = FakeQueue.instances.get("reports.digest") as FakeQueue;
    const job = queue.jobs.get("1") as FakeJob;

    execute.mockResolvedValueOnce({ ok: true, data: { digested: true } });
    await expect(worker.processor(job, "token")).resolves.toEqual({ digested: true });
    expect(execute).toHaveBeenCalledWith(
      "reports.digest",
      { tenantId: "acme" },
      { runId: "reports.digest/1", attempt: 1, key: "acme" },
    );
    expect(queue.hashes.get("ship:ship-jobs:last-run")?.get("reports.digest")).toBe(
      "1970-01-01T00:00:05.000Z",
    );
    expect(queue.hashes.get("ship:ship-jobs:last-success")?.get("reports.digest")).toBe(
      "1970-01-01T00:00:05.000Z",
    );

    execute.mockResolvedValueOnce({ ok: false, retryable: true, lockHeld: true, error: "held" });
    await expect(worker.processor(job, "token")).rejects.toBeInstanceOf(FakeDelayedError);
    expect(job.moved).toHaveLength(1);
    expect(job.data.history).toEqual([]);

    execute.mockResolvedValueOnce({ ok: false, retryable: true, error: "Error: boom" });
    job.attemptsMade = 1;
    await expect(worker.processor(job, "token")).rejects.toThrow("Error: boom");
    expect(job.data.history).toEqual([
      { attempt: 2, error: "Error: boom", at: "1970-01-01T00:00:05.000Z" },
    ]);

    execute.mockResolvedValueOnce({ ok: false, retryable: false, error: "VALIDATION_ERROR: nope" });
    await expect(worker.processor(job, "token")).rejects.toBeInstanceOf(FakeUnrecoverableError);
    expect(job.data.history).toHaveLength(2);
  });

  it("caps in-flight runs with the process-wide budget", async () => {
    let concurrent = 0;
    let peak = 0;
    const backend = attach(createBullmqJobBackend({ connection: {}, maxInFlight: 2 }), async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return { ok: true, data: undefined };
    });
    await backend.startWorkers("worker");
    const worker = FakeWorker.instances.find(
      (item) => item.name === "reports.render",
    ) as FakeWorker;
    const queue = FakeQueue.instances.get("reports.render") as FakeQueue;
    const runs = [];
    for (let index = 0; index < 6; index += 1) {
      await backend.enqueue("reports.render", { index });
      runs.push(worker.processor(queue.jobs.get(String(index + 1)) as FakeJob, "t"));
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("reports health, lists failures and supports retry, discard and cleanup", async () => {
    const backend = attach(
      createBullmqJobBackend({ connection: {}, clock: () => new Date(FakeQueue.now) }),
    );
    await backend.enqueue("reports.render", { a: 1 });
    await backend.enqueue("reports.render", { a: 2 });
    const queue = FakeQueue.instances.get("reports.render") as FakeQueue;
    const failed = queue.jobs.get("1") as FakeJob;
    failed.state = "failed";
    failed.attemptsMade = 3;
    failed.failedReason = "Error: boom";
    failed.finishedOn = FakeQueue.now - 5_000;
    failed.processedOn = FakeQueue.now - 6_000;
    failed.data = {
      ...failed.data,
      history: [{ attempt: 3, error: "Error: boom", at: "1970-01-01T00:00:00.000Z" }],
    };
    const completed = await queue.add(
      "reports.render",
      { input: {}, history: [] },
      { jobId: "done" },
    );
    completed.state = "completed";
    completed.finishedOn = FakeQueue.now - 5_000;

    const health = await backend.health(new Date(FakeQueue.now + 250));
    expect(health.jobs.find((entry) => entry.jobId === "reports.render")).toEqual({
      jobId: "reports.render",
      waiting: 1,
      active: 0,
      delayed: 0,
      failed: 1,
      lagMs: 250,
    });
    expect(health.jobs.map((entry) => entry.jobId)).toEqual(["reports.digest", "reports.render"]);

    const listed = await backend.listFailed({ limit: 10 });
    expect(listed).toEqual([
      expect.objectContaining({
        runId: "reports.render/1",
        jobId: "reports.render",
        input: { a: 1 },
        status: "failed",
        attempts: 3,
        lastError: "Error: boom",
        history: [{ attempt: 3, error: "Error: boom", at: new Date("1970-01-01T00:00:00.000Z") }],
        startedAt: new Date(FakeQueue.now - 6_000),
        failedAt: new Date(FakeQueue.now - 5_000),
      }),
    ]);

    expect(await backend.retry("reports.render/2")).toBeUndefined();
    expect(await backend.retry("nonsense")).toBeUndefined();
    expect(await backend.retry("reports.render/missing")).toBeUndefined();
    expect(await backend.retry("reports.unknown/1")).toBeUndefined();
    expect(await backend.retry("reports.render/1")).toMatchObject({ status: "waiting" });
    failed.state = "failed";
    expect(await backend.discard("reports.render/1", "stale")).toMatchObject({
      status: "discarded",
      discardReason: "stale",
      discardedAt: new Date(FakeQueue.now),
    });
    expect(queue.jobs.has("1")).toBe(false);
    expect(await backend.discard("reports.render/1", "again")).toBeUndefined();

    const digestQueue =
      FakeQueue.instances.get("reports.digest") ?? new FakeQueue("reports.digest");
    const old = await digestQueue.add("reports.digest", { input: {}, history: [] }, {});
    old.state = "completed";
    old.finishedOn = FakeQueue.now - 5_000;
    // reports.render has no retention, so the 7-day default keeps its completed job.
    expect(await backend.cleanup(new Date())).toEqual({
      completedDeleted: 1,
      deadLetteredDeleted: 0,
    });
    expect(digestQueue.jobs.size).toBe(0);
    expect(queue.jobs.has("done")).toBe(true);
    await backend.quit();
  });
});
