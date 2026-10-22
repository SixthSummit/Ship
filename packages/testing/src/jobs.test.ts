import {
  defineApp,
  defineJob,
  defineModule,
  type JobRuntimeBinding,
  jobBackendDependency,
  lockProviderDependency,
  startJobRuntime,
  systemActor,
  valueProvider,
} from "@sixthsummit/ship-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createInMemoryJobBackend,
  createInMemoryLockProvider,
  nextOccurrence,
  runJobOnce,
} from "./jobs.js";
import { conformanceJobs, jobBackendConformance } from "./jobs-conformance.js";

function clockAt(start = Date.parse("2026-09-18T12:00:00.000Z")) {
  let now = start;
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
    set: (iso: string) => {
      now = Date.parse(iso);
    },
  };
}

function binding(
  execute: JobRuntimeBinding["execute"],
  overrides: Partial<
    Record<string, { mode: "single-runner" | "parallel"; max: number; keyed: boolean }>
  > = {},
): JobRuntimeBinding {
  const jobs = conformanceJobs().map((job) =>
    overrides[job.id]
      ? Object.freeze({
          ...job,
          concurrency: Object.freeze({ ...job.concurrency, ...overrides[job.id] }),
          key: (input: unknown) => String((input as { key?: string }).key ?? ""),
        })
      : job,
  );
  return { jobs, execute };
}

describe("createInMemoryLockProvider", () => {
  it("hands out one live lease per (jobId, key) and honors expiry, release and extension", async () => {
    const time = clockAt();
    const lock = createInMemoryLockProvider(time.clock);
    const lease = await lock.acquire("reports.digest", "acme", 1_000);
    expect(lease).toMatchObject({ jobId: "reports.digest", key: "acme" });
    expect(await lock.acquire("reports.digest", "acme", 1_000)).toBeUndefined();
    expect(await lock.acquire("reports.digest", "beta", 1_000)).toBeDefined();
    expect(lock.leases().size).toBe(2);

    time.advance(900);
    expect(await lock.extend(lease as never, 1_000)).toBe(true);
    time.advance(900);
    expect(await lock.acquire("reports.digest", "acme", 1_000)).toBeUndefined();
    time.advance(200);
    expect(await lock.extend(lease as never, 1_000)).toBe(false);
    const replacement = await lock.acquire("reports.digest", "acme", 1_000);
    expect(replacement?.token).not.toBe(lease?.token);
    await lock.release(lease as never);
    expect(lock.leases().has("reports.digest:acme")).toBe(true);
    await lock.release(replacement as never);
    expect(lock.leases().has("reports.digest:acme")).toBe(false);
    lock.reset();
    expect(lock.leases().size).toBe(0);
  });
});

describe("createInMemoryJobBackend", () => {
  it("round-robins claims across keys and keeps single-runner keys serialized", async () => {
    const time = clockAt();
    const backend = createInMemoryJobBackend({ clock: time.clock, maxInFlight: 10 });
    const order: string[] = [];
    backend.attach(
      binding(
        async (jobId, input) => {
          order.push(`${jobId}:${String((input as { key: string }).key)}`);
          return { ok: true, data: undefined };
        },
        { "conf.ok": { mode: "single-runner", max: 3, keyed: true } },
      ),
    );
    for (const key of ["a", "a", "a", "b", "c"]) await backend.enqueue("conf.ok", { key });
    expect(backend.runs().map((run) => run.key)).toEqual(["a", "a", "a", "b", "c"]);

    await expect(backend.drain()).resolves.toEqual({ executed: 5, completed: 5, failed: 0 });
    expect(order).toEqual(["conf.ok:a", "conf.ok:b", "conf.ok:c", "conf.ok:a", "conf.ok:a"]);
    expect(backend.runs().every((run) => run.status === "completed")).toBe(true);
  });

  it("treats lock contention as a delayed retry without consuming an attempt", async () => {
    const time = clockAt();
    const backend = createInMemoryJobBackend({ clock: time.clock });
    let contended = true;
    backend.attach(
      binding(async () => {
        if (contended) {
          contended = false;
          return { ok: false, retryable: true, lockHeld: true, error: "held" };
        }
        return { ok: true, data: undefined };
      }),
    );
    await backend.enqueue("conf.ok", {});
    await expect(backend.drain()).resolves.toEqual({ executed: 1, completed: 0, failed: 0 });
    expect(backend.runs()[0]).toMatchObject({ status: "delayed", attempts: 0, history: [] });
    time.advance(50);
    await expect(backend.drain()).resolves.toEqual({ executed: 1, completed: 1, failed: 0 });
  });

  it("enqueues scheduled runs with durable identities and never duplicates a tick", async () => {
    const time = clockAt();
    const backend = createInMemoryJobBackend({ clock: time.clock });
    backend.attach(binding(async () => ({ ok: true, data: undefined })));
    await backend.schedule("conf.ok", { kind: "interval", everyMs: 1_000 });
    await backend.schedule("conf.ok", { kind: "interval", everyMs: 1_000 });
    await backend.schedule("conf.flaky", { kind: "schedule", cron: "30 12 * * *", tz: "UTC" });
    expect(backend.schedules()).toEqual([
      {
        jobId: "conf.flaky",
        trigger: { kind: "schedule", cron: "30 12 * * *", tz: "UTC" },
        nextAt: new Date("2026-09-18T12:30:00.000Z"),
      },
      {
        jobId: "conf.ok",
        trigger: { kind: "interval", everyMs: 1_000 },
        nextAt: new Date("2026-09-18T12:00:01.000Z"),
      },
    ]);

    expect(await backend.tick()).toBe(0);
    time.advance(2_500);
    expect(await backend.tick()).toBe(2);
    expect(await backend.tick()).toBe(0);
    expect(backend.runs().map((run) => run.runId)).toEqual([
      "conf.ok:2026-09-18T12:00:01.000Z",
      "conf.ok:2026-09-18T12:00:02.000Z",
    ]);
    time.set("2026-09-18T12:31:00.000Z");
    expect(await backend.tick()).toBe(1 + 1_858);
    await backend.unschedule("conf.ok");
    expect(backend.schedules().map((item) => item.jobId)).toEqual(["conf.flaky"]);
    backend.reset();
    expect(backend.runs()).toEqual([]);
    expect(backend.schedules()).toEqual([]);
  });

  it("rejects unknown jobs, reports health and bounds drain", async () => {
    const time = clockAt();
    const backend = createInMemoryJobBackend({ clock: time.clock });
    await expect(backend.enqueue("conf.unknown", {})).rejects.toThrow(/knows no job/u);
    backend.attach(binding(async () => ({ ok: false, retryable: true, error: "Error: nope" })));
    await backend.enqueue("conf.ok", { a: 1 }, { delayMs: 500 });
    expect(backend.runs()[0]?.status).toBe("delayed");
    const idle = await backend.health(time.clock());
    expect(idle.jobs.find((job) => job.jobId === "conf.ok")).toEqual({
      jobId: "conf.ok",
      waiting: 0,
      active: 0,
      delayed: 1,
      failed: 0,
      lagMs: 0,
    });
    time.advance(1_000);
    expect(
      (await backend.health(time.clock())).jobs.find((job) => job.jobId === "conf.ok")?.lagMs,
    ).toBe(500);
    await expect(backend.drain({ maxRuns: 1 })).resolves.toEqual({
      executed: 1,
      completed: 0,
      failed: 0,
    });
    time.advance(10_000);
    await expect(backend.drain({ maxRuns: 0 })).rejects.toThrow(/still had runnable runs/u);
    await expect(backend.drain()).resolves.toEqual({ executed: 1, completed: 0, failed: 0 });
    time.advance(10_000);
    await expect(backend.drain()).resolves.toEqual({ executed: 1, completed: 0, failed: 1 });
    const health = await backend.health(time.clock());
    expect(health.jobs.find((job) => job.jobId === "conf.ok")).toMatchObject({
      failed: 1,
      lastRunAt: expect.any(Date),
    });
    expect(health.jobs.find((job) => job.jobId === "conf.ok")?.lastSuccessAt).toBeUndefined();
    expect(await backend.listFailed({ limit: 10 })).toMatchObject([
      { attempts: 3, history: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }] },
    ]);
  });

  it("exposes introspection: runs newest first, schedules, pause and resume", async () => {
    const time = clockAt();
    const backend = createInMemoryJobBackend({ clock: time.clock });
    expect(backend.introspection.declarations()).toEqual([]);
    backend.attach(binding(async () => ({ ok: true, data: undefined })));
    expect(backend.introspection.declarations().map((job) => job.id)).toContain("conf.ok");
    const first = await backend.enqueue("conf.ok", { a: 1 });
    time.advance(1_000);
    const second = await backend.enqueue("conf.ok", { a: 2 }, { delayMs: 60_000 });
    if (!first.accepted || !second.accepted) throw new Error("unreachable");
    expect(
      (await backend.introspection.listRuns({ limit: 10 })).map((run) => [run.runId, run.status]),
    ).toEqual([
      [second.runId, "delayed"],
      [first.runId, "waiting"],
    ]);
    expect(await backend.introspection.listRuns({ status: "delayed", limit: 10 })).toMatchObject([
      { runId: second.runId },
    ]);
    expect(await backend.introspection.listRuns({ jobId: "conf.other", limit: 10 })).toEqual([]);
    expect(await backend.introspection.listRuns({ limit: 1 })).toHaveLength(1);
    expect(await backend.introspection.getRun(first.runId)).toMatchObject({ input: { a: 1 } });
    expect(await backend.introspection.getRun("missing")).toBeUndefined();

    await backend.schedule("conf.ok", { kind: "interval", everyMs: 60_000 });
    expect(await backend.introspection.listSchedules()).toEqual([
      {
        jobId: "conf.ok",
        trigger: { kind: "interval", everyMs: 60_000 },
        nextAt: expect.any(Date),
      },
    ]);

    await backend.introspection.pause?.("conf.ok");
    expect(await backend.introspection.listPaused()).toEqual(["conf.ok"]);
    expect(await backend.drain()).toEqual({ executed: 0, completed: 0, failed: 0 });
    await backend.introspection.resume?.("conf.ok");
    expect(await backend.introspection.listPaused()).toEqual([]);
    expect((await backend.drain()).executed).toBeGreaterThan(0);
    await expect(backend.introspection.pause?.("conf.unknown")).rejects.toThrow(/knows no job/u);
    backend.reset();
    expect(await backend.introspection.listPaused()).toEqual([]);
  });

  it("starts and stops a polling worker", async () => {
    const backend = createInMemoryJobBackend({ pollMs: 1 });
    const seen: string[] = [];
    backend.attach(
      binding(async (jobId) => {
        seen.push(jobId);
        return { ok: true, data: undefined };
      }),
    );
    expect(await backend.startWorkers("api")).toBe(0);
    expect(await backend.startWorkers("worker", { maxInFlight: 1 })).toBe(1);
    expect(await backend.startWorkers("all")).toBe(1);
    await backend.enqueue("conf.ok", {});
    await vi.waitFor(() => expect(seen).toEqual(["conf.ok"]));
    await backend.quit();
    await backend.enqueue("conf.ok", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["conf.ok"]);
  });

  it("applies per-job retention on cleanup", async () => {
    const time = clockAt();
    const backend = createInMemoryJobBackend({ clock: time.clock });
    backend.attach(
      binding(async (jobId) =>
        jobId === "conf.ok"
          ? { ok: true, data: undefined }
          : { ok: false, retryable: false, error: "x" },
      ),
    );
    await backend.enqueue("conf.ok", {});
    await backend.enqueue("conf.final", {});
    await backend.drain();
    expect(await backend.cleanup(time.clock())).toEqual({
      completedDeleted: 0,
      deadLetteredDeleted: 0,
    });
    expect(await backend.discard(backend.runs()[1]?.runId as string, "no")).toMatchObject({
      status: "discarded",
    });
    time.advance(100);
    expect(await backend.cleanup(time.clock())).toEqual({
      completedDeleted: 1,
      deadLetteredDeleted: 1,
    });
    expect(backend.runs()).toEqual([]);
  });
});

describe("nextOccurrence", () => {
  it("evaluates cron fields in the declared time zone", () => {
    const from = new Date("2026-09-18T12:00:00.000Z");
    expect(nextOccurrence({ kind: "interval", everyMs: 250 }, from)).toEqual(
      new Date("2026-09-18T12:00:00.250Z"),
    );
    // 2026-09-18 is a Friday: 09:00 EDT is 13:00Z, still ahead of `from`.
    expect(
      nextOccurrence({ kind: "schedule", cron: "0 9 * * 1-5", tz: "America/New_York" }, from),
    ).toEqual(new Date("2026-09-18T13:00:00.000Z"));
    expect(
      nextOccurrence(
        { kind: "schedule", cron: "0 9 * * 1-5", tz: "America/New_York" },
        new Date("2026-09-18T13:00:00.000Z"),
      ),
    ).toEqual(new Date("2026-09-21T13:00:00.000Z"));
    expect(nextOccurrence({ kind: "schedule", cron: "*/15 * * * *", tz: "UTC" }, from)).toEqual(
      new Date("2026-09-18T12:15:00.000Z"),
    );
    expect(nextOccurrence({ kind: "schedule", cron: "0 0 1 1,7 *", tz: "UTC" }, from)).toEqual(
      new Date("2027-01-01T00:00:00.000Z"),
    );
    expect(nextOccurrence({ kind: "schedule", cron: "0 0 0 3 10 *", tz: "UTC" }, from)).toEqual(
      new Date("2026-10-03T00:00:00.000Z"),
    );
    expect(nextOccurrence({ kind: "schedule", cron: "5-10/5 2 * * 0", tz: "UTC" }, from)).toEqual(
      new Date("2026-09-20T02:05:00.000Z"),
    );
    expect(() => nextOccurrence({ kind: "schedule", cron: "x * * * *", tz: "UTC" }, from)).toThrow(
      /unsupported cron field/u,
    );
    expect(() => nextOccurrence({ kind: "schedule", cron: "0 0 31 2 *", tz: "UTC" }, from)).toThrow(
      /no occurrence/u,
    );
  });
});

describe("runJobOnce", () => {
  const job = defineJob({
    id: "reports.digest",
    input: z.object({ tenantId: z.string().min(1) }),
    trigger: { kind: "enqueue" },
    concurrency: { mode: "single-runner", key: (input) => input.tenantId },
    retry: { attempts: 1, backoff: { initialMs: 1 } },
    transaction: "none",
    dependencies: {},
    handler: async ({ input, context }) => ({
      tenantId: input.tenantId,
      actor: context.actor.id,
      requestId: context.requestId,
    }),
  });
  const app = defineApp({
    id: "jobs-api",
    modules: [
      defineModule({
        id: "reports",
        operations: [job],
        providers: [valueProvider(lockProviderDependency(), createInMemoryLockProvider())],
        imports: [],
        exports: [],
      }),
    ],
  });

  it("runs the job as a permissionless system actor and returns the executor result", async () => {
    const result = await runJobOnce(
      app,
      "reports.digest",
      { tenantId: "acme" },
      { requestId: "run-1" },
    );
    expect(result).toMatchObject({
      ok: true,
      data: { tenantId: "acme", actor: "ship.testing.jobs", requestId: "run-1" },
    });
    await expect(runJobOnce(app, "reports.digest", { tenantId: "" })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(
      runJobOnce(
        app,
        "reports.digest",
        { tenantId: "acme" },
        { actor: systemActor({ id: "custom" }) },
      ),
    ).resolves.toMatchObject({ ok: true, data: { actor: "custom" } });
  });
});

describe("startJobRuntime with the in-memory backend", () => {
  let backend: ReturnType<typeof createInMemoryJobBackend>;
  beforeEach(() => {
    backend = createInMemoryJobBackend({ pollMs: 1 });
  });
  afterEach(async () => {
    await backend.quit();
  });

  it("drives declared jobs end to end", async () => {
    const seen: string[] = [];
    const job = defineJob({
      id: "reports.digest",
      input: z.object({ tenantId: z.string() }),
      trigger: { kind: "enqueue" },
      concurrency: { mode: "parallel", max: 2 },
      retry: { attempts: 1, backoff: { initialMs: 1 } },
      transaction: "none",
      dependencies: {},
      handler: async ({ input }) => {
        seen.push(input.tenantId);
      },
    });
    const app = defineApp({
      id: "jobs-api",
      modules: [
        defineModule({
          id: "reports",
          operations: [job],
          providers: [valueProvider(jobBackendDependency(), backend)],
          imports: [],
          exports: [],
        }),
      ],
      runtime: { workers: { mode: "worker" } },
    });
    const runtime = await startJobRuntime(app, { backend });
    expect(runtime.workers).toBe(1);
    await backend.enqueue("reports.digest", { tenantId: "acme" });
    await vi.waitFor(() => expect(seen).toEqual(["acme"]));
    await runtime.stop();
  });
});

jobBackendConformance(
  "in-memory",
  (options) => createInMemoryJobBackend({ ...options, pollMs: 1 }),
  { describe, it, beforeEach, afterEach, expect },
  { timeoutMs: 5_000 },
);
