import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineApp } from "./application.js";
import {
  defineJob,
  type JobBackend,
  type JobRuntimeBinding,
  jobBackendDependency,
  type LockProvider,
  lockProviderDependency,
} from "./job.js";
import { defineModule } from "./module.js";
import { operationError, operationFailure } from "./operation-error.js";
import { valueProvider } from "./provider.js";
import { collectJobs, JobRuntimeError, startJobRuntime } from "./runtime.js";

const tenantRefused = operationError({
  code: "TENANT_REFUSED",
  status: 403,
  message: "Tenant refused",
});

function recordingBackend() {
  const calls: string[] = [];
  let binding: JobRuntimeBinding | undefined;
  const backend: JobBackend = {
    kind: "ship.job-backend",
    adapter: "recording",
    concurrencyBudget: { maxInFlight: 2, maxQueueDepth: 10 },
    attach: (value) => {
      binding = value;
      calls.push(`attach ${value.jobs.map((job) => job.id).join(",")}`);
    },
    enqueue: async () => ({ accepted: true, runId: "run", deduplicated: false }),
    schedule: async (jobId, trigger) => {
      calls.push(`schedule ${jobId} ${trigger.kind}`);
    },
    unschedule: async () => undefined,
    startWorkers: async (mode, budget) => {
      calls.push(`start ${mode} ${JSON.stringify(budget)}`);
      return mode === "api" ? 0 : 3;
    },
    quit: async () => {
      calls.push("quit");
    },
    health: async () => ({ jobs: [] }),
    listFailed: async () => [],
    retry: async () => undefined,
    discard: async () => undefined,
    cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
  };
  return { backend, calls, binding: () => binding };
}

const lock: LockProvider = {
  kind: "ship.lock-provider",
  acquire: async (jobId, key, ttlMs) => ({
    jobId,
    key,
    token: "t",
    expiresAt: new Date(Date.now() + ttlMs),
  }),
  release: async () => undefined,
};

function fixtureApp(
  options: { readonly mode?: "api" | "worker" | "all"; readonly budget?: number } = {},
) {
  const handler = vi.fn(async ({ input }: { input: { tenantId: string } }) => {
    if (input.tenantId === "boom") throw new Error("handler exploded");
    if (input.tenantId === "refused") throw operationFailure(tenantRefused);
    return { tenantId: input.tenantId };
  });
  const digest = defineJob({
    id: "reports.digest",
    input: z.object({ tenantId: z.string().min(1) }),
    trigger: { kind: "schedule", cron: "0 * * * *", tz: "UTC" },
    concurrency: { mode: "parallel", max: 2 },
    retry: { attempts: 2, backoff: { initialMs: 10 } },
    transaction: "none",
    dependencies: {},
    errors: [tenantRefused],
    handler,
  });
  const sweep = defineJob({
    id: "reports.sweep",
    input: z.object({}),
    trigger: { kind: "interval", everyMs: 1_000 },
    concurrency: { mode: "single-runner", reason: "one sweep at a time" },
    retry: { attempts: 1, backoff: { initialMs: 10 } },
    transaction: "none",
    dependencies: {},
    handler: async () => ({ swept: true }),
  });
  const manual = defineJob({
    id: "reports.manual",
    input: z.object({}),
    trigger: { kind: "enqueue" },
    concurrency: { mode: "parallel" },
    retry: { attempts: 1, backoff: { initialMs: 10 } },
    transaction: "none",
    dependencies: {},
    handler: async () => undefined,
  });
  const recording = recordingBackend();
  const module = defineModule({
    id: "reports",
    operations: [digest, sweep, manual],
    providers: [
      valueProvider(jobBackendDependency(), recording.backend),
      valueProvider(lockProviderDependency(), lock),
    ],
    imports: [],
    exports: [],
  });
  const app = defineApp({
    id: "jobs-api",
    modules: [module],
    ...(options.mode
      ? {
          runtime: {
            workers: { mode: options.mode, ...(options.budget ? { budget: options.budget } : {}) },
          },
        }
      : {}),
  });
  return { app, handler, ...recording };
}

describe("startJobRuntime", () => {
  it("attaches every declared job, reconciles schedules in worker mode and starts workers", async () => {
    const { app, calls, backend } = fixtureApp({ mode: "worker", budget: 8 });

    const runtime = await startJobRuntime(app, { backend });

    expect(runtime).toMatchObject({
      kind: "ship.job-runtime",
      mode: "worker",
      workers: 3,
      scheduled: ["reports.digest", "reports.sweep"],
    });
    expect(runtime.jobs.map((job) => job.id)).toEqual([
      "reports.digest",
      "reports.manual",
      "reports.sweep",
    ]);
    expect(calls).toEqual([
      "attach reports.digest,reports.manual,reports.sweep",
      "schedule reports.digest schedule",
      "schedule reports.sweep interval",
      'start worker {"maxInFlight":8}',
    ]);
    await runtime.stop();
    expect(calls.at(-1)).toBe("quit");
    expect(collectJobs(app).map((job) => job.id)).toEqual(runtime.jobs.map((job) => job.id));
  });

  it("starts no workers and registers no schedules in api mode", async () => {
    const { app, calls, backend } = fixtureApp();
    const runtime = await startJobRuntime(app, { backend, budget: { maxQueueDepth: 5 } });
    expect(runtime).toMatchObject({ mode: "api", workers: 0, scheduled: [] });
    expect(calls).toEqual([
      "attach reports.digest,reports.manual,reports.sweep",
      'start api {"maxQueueDepth":5}',
    ]);
  });

  it("executes runs as a permissionless system actor and classifies outcomes", async () => {
    const { app, backend, binding, handler } = fixtureApp({ mode: "all" });
    await startJobRuntime(app, { backend, mode: "worker", actorId: "ship.jobs.test" });
    const execute = binding()?.execute;
    if (!execute) throw new Error("backend was not attached");

    await expect(
      execute("reports.digest", { tenantId: "acme" }, { runId: "run-1", attempt: 1 }),
    ).resolves.toEqual({ ok: true, data: { tenantId: "acme" } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          requestId: "run-1",
          actor: expect.objectContaining({ id: "ship.jobs.test", kind: "system" }),
        }),
      }),
    );
    expect(handler.mock.calls[0]?.[0].context.actor.permissions).toBeUndefined();

    await expect(
      execute("reports.digest", { tenantId: "" }, { runId: "run-2", attempt: 1 }),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      error: "VALIDATION_ERROR: Request validation failed",
    });
    await expect(
      execute("reports.digest", { tenantId: "boom" }, { runId: "run-3", attempt: 1 }),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      error: expect.stringContaining("handler exploded"),
    });
    // A declared failure is a final outcome: it never consumes a retry attempt.
    await expect(
      execute("reports.digest", { tenantId: "refused" }, { runId: "run-3b", attempt: 1 }),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      error: "TENANT_REFUSED: Tenant refused",
    });
    await expect(
      execute("reports.missing", {}, { runId: "run-4", attempt: 1 }),
    ).resolves.toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it("projects per-job liveness from the runs this process executed", async () => {
    const { app, backend, binding } = fixtureApp({ mode: "all" });
    let tick = 0;
    const clock = () => new Date(1_000_000 + tick * 1_000);
    const runtime = await startJobRuntime(app, { backend, mode: "worker", clock });
    const execute = binding()?.execute;
    if (!execute) throw new Error("backend was not attached");

    // Nothing has completed: lag is measured from the runtime start.
    tick = 5;
    expect(runtime.liveness(clock()).jobs.map((entry) => [entry.jobId, entry.lagMs])).toEqual([
      ["reports.digest", 5_000],
      ["reports.manual", 5_000],
      ["reports.sweep", 5_000],
    ]);

    tick = 10;
    await execute("reports.digest", { tenantId: "acme" }, { runId: "run-1", attempt: 1 });
    tick = 12;
    await execute("reports.digest", { tenantId: "boom" }, { runId: "run-2", attempt: 1 });
    tick = 20;
    const liveness = runtime.liveness(clock());
    expect(liveness.startedAt).toEqual(new Date(1_000_000));
    expect(liveness.jobs.find((entry) => entry.jobId === "reports.digest")).toEqual({
      jobId: "reports.digest",
      lastStartedAt: new Date(1_012_000),
      lastCompletedAt: new Date(1_010_000),
      lastFailedAt: new Date(1_012_000),
      completed: 1,
      failed: 1,
      // A failure does not reset the lag: it counts from the last success.
      lagMs: 10_000,
    });
    expect(liveness.jobs.find((entry) => entry.jobId === "reports.sweep")).toMatchObject({
      completed: 0,
      failed: 0,
      lagMs: 20_000,
    });
    // The runtime reads its own clock when the caller passes no instant.
    expect(runtime.liveness().jobs[0]?.lagMs).toBe(10_000);
  });

  it("reports lock contention as a retryable, lock-held outcome", async () => {
    const { app, backend, binding } = fixtureApp({ mode: "worker" });
    const heldLock: LockProvider = { ...lock, acquire: async () => undefined };
    const contended = defineApp({
      id: "jobs-api",
      modules: [
        defineModule({
          id: "reports",
          operations: app.modules[0].operations,
          providers: [
            valueProvider(jobBackendDependency(), backend),
            valueProvider(lockProviderDependency(), heldLock),
          ],
          imports: [],
          exports: [],
        }),
      ],
    });
    await startJobRuntime(contended, { backend, mode: "worker" });
    await expect(
      binding()?.execute("reports.sweep", {}, { runId: "run-5", attempt: 1 }),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      lockHeld: true,
      error: "Another runner holds the lock for this job key",
    });
  });

  it("rejects invalid backends, modes and actor ids", async () => {
    const { app, backend } = fixtureApp();
    await expect(startJobRuntime(app, { backend: {} as never })).rejects.toMatchObject({
      name: "JobRuntimeError",
      code: "SHIP_JOB_RUNTIME_BACKEND_INVALID",
    });
    await expect(startJobRuntime(app, { backend, mode: "cron" as never })).rejects.toBeInstanceOf(
      JobRuntimeError,
    );
    await expect(startJobRuntime(app, { backend, actorId: "Not Valid" })).rejects.toMatchObject({
      code: "SHIP_JOB_RUNTIME_ACTOR_INVALID",
    });
  });
});
