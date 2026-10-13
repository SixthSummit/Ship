import {
  defineApp,
  defineJob,
  defineModule,
  type JobBackend,
  type JobRuntimeBinding,
  jobBackendDependency,
  startJobRuntime,
  valueProvider,
} from "@sixthsummit/ship-core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JobLivenessRouteError, jobLivenessRoute, projectJobLiveness } from "./job-liveness.js";

function recordingBackend() {
  let binding: JobRuntimeBinding | undefined;
  const backend: JobBackend = {
    kind: "ship.job-backend",
    adapter: "recording",
    concurrencyBudget: { maxInFlight: 2, maxQueueDepth: 10 },
    attach: (value) => {
      binding = value;
    },
    enqueue: async () => ({ accepted: true, runId: "run", deduplicated: false }),
    schedule: async () => undefined,
    unschedule: async () => undefined,
    startWorkers: async () => 1,
    quit: async () => undefined,
    health: async () => ({ jobs: [] }),
    listFailed: async () => [],
    retry: async () => undefined,
    discard: async () => undefined,
    cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
  };
  return { backend, binding: () => binding };
}

async function fixture() {
  const sweep = defineJob({
    id: "reports.sweep",
    input: z.object({ fail: z.boolean().optional() }),
    trigger: { kind: "interval", everyMs: 1_000 },
    concurrency: { mode: "parallel" },
    retry: { attempts: 1, backoff: { initialMs: 10 } },
    transaction: "none",
    dependencies: {},
    handler: async ({ input }) => {
      if (input.fail) throw new Error("sweep exploded");
      return { swept: true };
    },
  });
  const digest = defineJob({
    id: "reports.digest",
    input: z.object({}),
    trigger: { kind: "enqueue" },
    concurrency: { mode: "parallel" },
    retry: { attempts: 1, backoff: { initialMs: 10 } },
    transaction: "none",
    dependencies: {},
    handler: async () => undefined,
  });
  const recording = recordingBackend();
  const app = defineApp({
    id: "liveness-fixture",
    modules: [
      defineModule({
        id: "reports",
        operations: [sweep, digest],
        providers: [valueProvider(jobBackendDependency(), recording.backend)],
        imports: [],
        exports: [],
      }),
    ],
  });
  let tick = 0;
  const clock = () => new Date(1_700_000_000_000 + tick * 1_000);
  const runtime = await startJobRuntime(app, { backend: recording.backend, mode: "worker", clock });
  const execute = recording.binding()?.execute;
  if (!execute) throw new Error("backend was not attached");
  const advance = (seconds: number): void => {
    tick += seconds;
  };
  return { runtime, execute, clock, advance };
}

describe("jobLivenessRoute", () => {
  it("reports every job and turns 503 once a gated job falls behind", async () => {
    const { runtime, execute, clock, advance } = await fixture();
    const app = new Hono().route(
      "/",
      jobLivenessRoute({ runtime, clock, staleAfterMs: { "reports.sweep": 5_000 } }),
    );

    advance(2);
    const fresh = await app.request("/health/jobs");
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("cache-control")).toBe("no-store");
    expect(await fresh.json()).toEqual({
      ok: true,
      startedAt: "2023-11-14T22:13:20.000Z",
      jobs: [
        { jobId: "reports.digest", completed: 0, failed: 0, lagMs: 2_000, stale: false },
        { jobId: "reports.sweep", completed: 0, failed: 0, lagMs: 2_000, stale: false },
      ],
    });

    // A completed run resets the sweep's lag; the ungated digest never goes stale.
    advance(2);
    await execute("reports.sweep", {}, { runId: "run-1", attempt: 1 });
    advance(3);
    const afterRun = await app.request("/health/jobs");
    expect(afterRun.status).toBe(200);
    expect((await afterRun.json()) as { jobs: unknown[] }).toMatchObject({
      ok: true,
      jobs: [
        { jobId: "reports.digest", lagMs: 7_000, stale: false },
        {
          jobId: "reports.sweep",
          lastStartedAt: "2023-11-14T22:13:24.000Z",
          lastCompletedAt: "2023-11-14T22:13:24.000Z",
          completed: 1,
          lagMs: 3_000,
          stale: false,
        },
      ],
    });

    // A failure is recorded but does not count as a heartbeat.
    advance(1);
    await execute("reports.sweep", { fail: true }, { runId: "run-2", attempt: 1 });
    advance(5);
    const stale = await app.request("/health/jobs");
    expect(stale.status).toBe(503);
    expect((await stale.json()) as { jobs: unknown[] }).toMatchObject({
      ok: false,
      jobs: [
        { jobId: "reports.digest", stale: false },
        {
          jobId: "reports.sweep",
          lastFailedAt: "2023-11-14T22:13:28.000Z",
          failed: 1,
          lagMs: 9_000,
          stale: true,
        },
      ],
    });
  });

  it("applies one bound to every job and mounts on a custom path", async () => {
    const { runtime, clock, advance } = await fixture();
    const app = jobLivenessRoute({ runtime, clock, staleAfterMs: 1_000, path: "/_internal/jobs" });
    advance(2);
    const response = await app.request("/_internal/jobs");
    expect(response.status).toBe(503);
    expect((await response.json()) as { jobs: { stale: boolean }[] }).toMatchObject({
      ok: false,
      jobs: [{ stale: true }, { stale: true }],
    });
    expect((await app.request("/health/jobs")).status).toBe(404);
  });

  it("never fails when no bound is declared", async () => {
    const { runtime, clock, advance } = await fixture();
    advance(3_600);
    const response = await jobLivenessRoute({ runtime, clock }).request("/health/jobs");
    expect(response.status).toBe(200);
    expect(projectJobLiveness(runtime.liveness(clock())).ok).toBe(true);
  });

  it("rejects invalid options", async () => {
    const { runtime } = await fixture();
    for (const options of [
      { runtime: {} },
      { runtime, path: "health" },
      { runtime, staleAfterMs: 0 },
      { runtime, staleAfterMs: { "reports.sweep": -1 } },
      { runtime, staleAfterMs: "soon" },
      { runtime, clock: "now" },
    ]) {
      expect(() => jobLivenessRoute(options as never)).toThrow(JobLivenessRouteError);
    }
  });
});
