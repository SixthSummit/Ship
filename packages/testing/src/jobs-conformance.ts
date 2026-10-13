import type {
  JobBackend,
  JobExecutionOutcome,
  JobRunExecution,
  JobRuntimeDeclaration,
} from "@sixthsummit/ship-core";

/** The minimal test-runner surface the conformance suite needs (Vitest satisfies it). */
export interface ConformanceTestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void> | void, timeout?: number): void;
  beforeEach(body: () => Promise<void> | void, timeout?: number): void;
  afterEach(body: () => Promise<void> | void, timeout?: number): void;
  expect: (value: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: object): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toHaveLength(expected: number): void;
    toBeUndefined(): void;
  };
}

export interface ConformanceBackendOptions {
  readonly maxQueueDepth: number;
  readonly maxInFlight: number;
}

export interface JobBackendConformanceOptions {
  /** Upper bound on waiting for a backend to reach a state, in milliseconds. */
  readonly timeoutMs?: number;
  /** Per-test timeout passed to the runner. */
  readonly testTimeoutMs?: number;
}

const passthrough: RuntimeDeclarationInput = {
  "conf.ok": { attempts: 3, initialMs: 10 },
  "conf.flaky": { attempts: 3, initialMs: 10 },
  "conf.final": { attempts: 3, initialMs: 10 },
  "conf.slow": { attempts: 1, initialMs: 10 },
};

type RuntimeDeclarationInput = Readonly<
  Record<string, { readonly attempts: number; readonly initialMs: number }>
>;

/** Job declarations every conformance run attaches; retention is short so cleanup is observable. */
export function conformanceJobs(): readonly JobRuntimeDeclaration[] {
  const schema = {
    "~standard": {
      version: 1 as const,
      vendor: "conformance",
      validate: (value: unknown) => ({ value }),
    },
  };
  return Object.freeze(
    Object.entries(passthrough).map(([id, retry]) =>
      Object.freeze({
        id,
        input: schema,
        trigger: Object.freeze({ kind: "enqueue" as const }),
        concurrency: Object.freeze({
          mode: "parallel" as const,
          max: 2,
          keyed: false,
          leaseMs: 1_000,
        }),
        retry: Object.freeze({
          attempts: retry.attempts,
          backoff: Object.freeze({ initialMs: retry.initialMs }),
        }),
        retention: Object.freeze({ completedMs: 50, deadLetteredMs: 50 }),
        transaction: "none" as const,
      }),
    ),
  );
}

/**
 * Shared behavioral contract for `JobBackend` adapters. The in-memory backend
 * and `@sixthsummit/ship-jobs-bullmq` both run it. `createBackend` receives the
 * budget the suite expects and must return a fresh, unattached backend.
 */
export function jobBackendConformance(
  name: string,
  createBackend: (options: ConformanceBackendOptions) => Promise<JobBackend> | JobBackend,
  test: ConformanceTestApi,
  options: JobBackendConformanceOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const testTimeoutMs = options.testTimeoutMs ?? timeoutMs + 5_000;

  test.describe(`${name} job backend conformance`, () => {
    let backend: JobBackend;
    let calls: { jobId: string; input: unknown; run: JobRunExecution }[];
    let flakyFailures: number;

    const execute = async (
      jobId: string,
      input: unknown,
      run: JobRunExecution,
    ): Promise<JobExecutionOutcome> => {
      calls.push({ jobId, input, run });
      if (jobId === "conf.ok") return { ok: true, data: { echoed: input } };
      if (jobId === "conf.final") {
        return { ok: false, retryable: false, error: "VALIDATION_ERROR: rejected" };
      }
      if (jobId === "conf.slow") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { ok: true, data: undefined };
      }
      if (flakyFailures > 0) {
        flakyFailures -= 1;
        return { ok: false, retryable: true, error: `Error: flaky ${run.attempt}` };
      }
      return { ok: true, data: { attempt: run.attempt } };
    };

    const waitFor = async (predicate: () => Promise<boolean> | boolean, label: string) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`${name} conformance timed out waiting for ${label}`);
    };

    test.beforeEach(async () => {
      calls = [];
      flakyFailures = 0;
      backend = await createBackend({ maxQueueDepth: 3, maxInFlight: 2 });
      await backend.attach({ jobs: conformanceJobs(), execute });
    }, testTimeoutMs);

    test.afterEach(async () => {
      await backend.quit();
    }, testTimeoutMs);

    test.it(
      "accepts runs, executes them once workers start and reports health",
      async () => {
        const accepted = await backend.enqueue("conf.ok", { value: 1 });
        test.expect(accepted).toMatchObject({ accepted: true, deduplicated: false });
        const before = await backend.health(new Date());
        test
          .expect(before.jobs.find((job) => job.jobId === "conf.ok"))
          .toMatchObject({ waiting: 1 });

        test.expect(await backend.startWorkers("worker")).toBeGreaterThanOrEqual(1);
        await waitFor(() => calls.length === 1, "one execution");
        test.expect(calls[0]).toMatchObject({
          jobId: "conf.ok",
          input: { value: 1 },
          run: { attempt: 1 },
        });
        if (!accepted.accepted) throw new Error("unreachable");
        test.expect(calls[0]?.run.runId).toBe(accepted.runId);
        // The handler returning is not the completion signal: a backend records the
        // outcome after the handler resolves, so wait for health to report the run
        // neither waiting nor active before asserting on the settled counts.
        await waitFor(async () => {
          const entry = (await backend.health(new Date())).jobs.find(
            (job) => job.jobId === "conf.ok",
          );
          return entry?.waiting === 0 && entry.active === 0;
        }, "health to drain");
        const after = await backend.health(new Date());
        const entry = after.jobs.find((job) => job.jobId === "conf.ok");
        test.expect(entry).toMatchObject({ waiting: 0, active: 0, failed: 0 });
        test.expect(entry?.lastSuccessAt === undefined).toBe(false);
      },
      testTimeoutMs,
    );

    test.it(
      "deduplicates a repeated dedupeKey while the first run is not terminal",
      async () => {
        const first = await backend.enqueue("conf.ok", { value: 1 }, { dedupeKey: "same" });
        const second = await backend.enqueue("conf.ok", { value: 2 }, { dedupeKey: "same" });
        if (!first.accepted || !second.accepted) throw new Error("runs were rejected");
        test.expect(second.deduplicated).toBe(true);
        test.expect(second.runId).toBe(first.runId);
        test
          .expect(
            (await backend.health(new Date())).jobs.find((job) => job.jobId === "conf.ok")?.waiting,
          )
          .toBe(1);
      },
      testTimeoutMs,
    );

    test.it(
      "returns queue-full past the configured depth instead of buffering",
      async () => {
        for (let index = 0; index < 3; index += 1) {
          test
            .expect(await backend.enqueue("conf.ok", { index }))
            .toMatchObject({ accepted: true });
        }
        test.expect(await backend.enqueue("conf.ok", { index: 3 })).toEqual({
          accepted: false,
          rejected: "queue-full",
        });
        // Other jobs keep their own depth.
        test.expect(await backend.enqueue("conf.final", {})).toMatchObject({ accepted: true });
      },
      testTimeoutMs,
    );

    test.it(
      "never exceeds the per-job max under a burst",
      async () => {
        let concurrent = 0;
        let peak = 0;
        await backend.quit();
        backend = await createBackend({ maxQueueDepth: 50, maxInFlight: 10 });
        await backend.attach({
          jobs: conformanceJobs(),
          execute: async () => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            await new Promise((resolve) => setTimeout(resolve, 40));
            concurrent -= 1;
            return { ok: true, data: undefined };
          },
        });
        for (let index = 0; index < 10; index += 1) await backend.enqueue("conf.slow", { index });
        await backend.startWorkers("worker");
        await waitFor(async () => {
          const entry = (await backend.health(new Date())).jobs.find(
            (job) => job.jobId === "conf.slow",
          );
          return entry?.waiting === 0 && entry.active === 0 && entry.delayed === 0;
        }, "the burst to finish");
        test.expect(peak <= 2).toBe(true);
        test.expect(peak).toBeGreaterThanOrEqual(1);
      },
      testTimeoutMs,
    );

    test.it(
      "retries with backoff, records attempt history, dead-letters and supports retry/discard",
      async () => {
        flakyFailures = 5;
        const accepted = await backend.enqueue("conf.flaky", { value: "x" });
        if (!accepted.accepted) throw new Error("run was rejected");
        await backend.startWorkers("worker");
        await waitFor(
          async () => (await backend.listFailed({ limit: 10 })).length === 1,
          "dead-letter",
        );

        const [failed] = await backend.listFailed({ limit: 10 });
        test.expect(failed).toMatchObject({
          runId: accepted.runId,
          jobId: "conf.flaky",
          input: { value: "x" },
          status: "failed",
          attempts: 3,
          lastError: "Error: flaky 3",
        });
        test
          .expect(failed?.history.map((item) => item.error))
          .toEqual(["Error: flaky 1", "Error: flaky 2", "Error: flaky 3"]);
        test.expect(calls.filter((call) => call.jobId === "conf.flaky")).toHaveLength(3);

        // Manual retry re-runs once; the remaining scripted failure dead-letters it again.
        const retried = await backend.retry(accepted.runId);
        test.expect(retried?.status === "failed").toBe(false);
        await waitFor(
          () => calls.filter((call) => call.jobId === "conf.flaky").length === 4,
          "retry run",
        );
        await waitFor(
          async () => (await backend.listFailed({ limit: 10 })).length === 1,
          "second dead-letter",
        );
        test.expect((await backend.listFailed({ limit: 10 }))[0]?.history).toHaveLength(4);
        test.expect(await backend.retry("missing-run")).toBeUndefined();

        const discarded = await backend.discard(accepted.runId, "operator gave up");
        test
          .expect(discarded)
          .toMatchObject({ status: "discarded", discardReason: "operator gave up" });
        test.expect(await backend.listFailed({ limit: 10 })).toHaveLength(0);
        test.expect(await backend.discard(accepted.runId, "again")).toBeUndefined();
      },
      testTimeoutMs,
    );

    test.it(
      "dead-letters non-retryable outcomes immediately",
      async () => {
        await backend.enqueue("conf.final", { value: 1 });
        await backend.startWorkers("worker");
        await waitFor(
          async () => (await backend.listFailed({ limit: 10 })).length === 1,
          "dead-letter",
        );
        test.expect(calls.filter((call) => call.jobId === "conf.final")).toHaveLength(1);
        test.expect((await backend.listFailed({ limit: 10 }))[0]).toMatchObject({
          attempts: 1,
          lastError: "VALIDATION_ERROR: rejected",
        });
      },
      testTimeoutMs,
    );

    test.it(
      "replaces schedules instead of duplicating them and unschedules cleanly",
      async () => {
        await backend.schedule("conf.ok", { kind: "interval", everyMs: 60_000 });
        await backend.schedule("conf.ok", { kind: "interval", everyMs: 120_000 });
        await backend.schedule("conf.ok", { kind: "interval", everyMs: 120_000 });
        await backend.startWorkers("worker");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const entry = (await backend.health(new Date())).jobs.find(
          (job) => job.jobId === "conf.ok",
        );
        test.expect((entry?.waiting ?? 0) + (entry?.delayed ?? 0) <= 1).toBe(true);
        await backend.unschedule("conf.ok");
      },
      testTimeoutMs,
    );

    test.it(
      "deletes completed and dead-lettered runs past retention",
      async () => {
        await backend.enqueue("conf.ok", {});
        await backend.enqueue("conf.final", {});
        await backend.startWorkers("worker");
        await waitFor(async () => {
          const entry = (await backend.health(new Date())).jobs.find(
            (job) => job.jobId === "conf.ok",
          );
          return (
            calls.length === 2 &&
            entry?.waiting === 0 &&
            entry.active === 0 &&
            (await backend.listFailed({ limit: 10 })).length === 1
          );
        }, "both runs to be recorded");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const result = await backend.cleanup(new Date(Date.now() + 60_000));
        test.expect(result.completedDeleted).toBeGreaterThanOrEqual(1);
        test.expect(result.deadLetteredDeleted).toBeGreaterThanOrEqual(1);
        test.expect(await backend.listFailed({ limit: 10 })).toHaveLength(0);
      },
      testTimeoutMs,
    );
  });
}
