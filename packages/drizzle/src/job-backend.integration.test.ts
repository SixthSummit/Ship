import type { JobRuntimeDeclaration } from "@sixthsummit/ship-core";
import { jobBackendConformance } from "@sixthsummit/ship-testing/jobs-conformance";
import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing/postgres";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleJobBackend, type DrizzleJobBackendOptions } from "./job-backend.js";
import { shipJobRunsTable, shipJobStateTable } from "./job-store.js";

const runs = shipJobRunsTable();
const state = shipJobStateTable();
const schema = { runs, state };

let context: PostgresTestDb<typeof schema>;

beforeAll(async () => {
  context = await setupPostgresTestDb(schema);
}, 120_000);

afterAll(async () => {
  await context?.cleanup();
}, 60_000);

async function truncate() {
  await context.pool.query(`TRUNCATE TABLE "ship_job_runs", "ship_job_state"`);
}

function backend(options: Partial<DrizzleJobBackendOptions<typeof schema>> = {}) {
  return createDrizzleJobBackend({
    database: context.db,
    table: runs,
    stateTable: state,
    pollIntervalMs: 25,
    ...options,
  });
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

jobBackendConformance(
  "drizzle",
  async (options) => {
    await truncate();
    return backend({ queueDepthLimit: options.maxQueueDepth, maxInFlight: options.maxInFlight });
  },
  { describe, it, beforeEach, afterEach, expect },
  { timeoutMs: 15_000 },
);

const passthrough = {
  "~standard": { version: 1 as const, vendor: "test", validate: (value: unknown) => ({ value }) },
};

function declaration(
  id: string,
  overrides: Partial<JobRuntimeDeclaration> = {},
): JobRuntimeDeclaration {
  return {
    id,
    input: passthrough,
    trigger: { kind: "enqueue" },
    concurrency: { mode: "parallel", max: 2, keyed: false, leaseMs: 300 },
    retry: { attempts: 2, backoff: { initialMs: 10 } },
    retention: { completedMs: 1_000, deadLetteredMs: 1_000 },
    transaction: "none",
    ...overrides,
  };
}

describe("Drizzle job backend on PostgreSQL", () => {
  const started: { quit(): Promise<void> }[] = [];

  beforeEach(truncate);

  afterEach(async () => {
    await Promise.all(started.splice(0).map((item) => item.quit()));
  });

  it("lets a second process retake an expired lease and rejects the stale holder's completion", async () => {
    const errors: unknown[] = [];
    const executions: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const crashed = backend({ onError: (error) => errors.push(error) });
    const recovering = backend();
    started.push(crashed, recovering);
    // max 1: the blocked run exhausts the first backend's capacity, so only the second can retake it.
    const jobs = [
      declaration("lease.job", {
        concurrency: { mode: "parallel", max: 1, keyed: false, leaseMs: 300 },
      }),
    ];
    await crashed.attach({
      jobs,
      execute: async () => {
        executions.push("crashed");
        await gate;
        return { ok: true, data: "late" };
      },
    });
    await recovering.attach({
      jobs,
      execute: async () => {
        executions.push("recovering");
        return { ok: true, data: "fresh" };
      },
    });
    const accepted = await crashed.enqueue("lease.job", { value: 1 });
    if (!accepted.accepted) throw new Error("rejected");
    await crashed.startWorkers("worker");
    await waitFor(async () => executions.length === 1, "first claim");

    // The first process "dies": its heartbeat stops renewing and the lease lapses.
    await context.db
      .update(runs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1), claimToken: "crashed-process" })
      .where(eq(runs.id, accepted.runId));
    await recovering.startWorkers("worker");
    await waitFor(async () => executions.length === 2, "retake");
    await waitFor(
      async () =>
        (await context.db.select().from(runs).where(eq(runs.id, accepted.runId)))[0]?.status ===
        "completed",
      "fresh completion",
    );
    release();
    await waitFor(async () => errors.length === 1, "stale rejection");
    expect(errors[0]).toMatchObject({
      code: "SHIP_DRIZZLE_JOB_LEASE_STALE",
      jobId: "lease.job",
      runId: accepted.runId,
    });
    const [row] = await context.db.select().from(runs).where(eq(runs.id, accepted.runId));
    expect(row).toMatchObject({ status: "completed", attempts: 2 });
    expect(executions).toEqual(["crashed", "recovering"]);
  });

  it("runs distinct keys of a single-runner concurrently and one key serially through the advisory lock", async () => {
    const intervals: { key: string; start: number; end: number }[] = [];
    const worker = backend({ maxInFlight: 8 });
    started.push(worker);
    const active = new Map<string, number>();
    await worker.attach({
      jobs: [
        declaration("serial.job", {
          concurrency: { mode: "single-runner", max: 4, keyed: true, leaseMs: 2_000 },
          retry: { attempts: 5, backoff: { initialMs: 10, maxMs: 40 } },
          key: (input) => (input as { tenant: string }).tenant,
        }),
      ],
      execute: async (_jobId, input, run) => {
        const key = run.key as string;
        // Emulate the executor's lease: the backend must never hand two runs of one key to one process.
        const lease = await worker.lockProvider.acquire("serial.job", key, 2_000);
        if (!lease) return { ok: false, retryable: true, lockHeld: true, error: "held" };
        active.set(key, (active.get(key) ?? 0) + 1);
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 60));
        intervals.push({ key, start, end: Date.now() });
        active.set(key, (active.get(key) ?? 1) - 1);
        await worker.lockProvider.release(lease);
        return { ok: true, data: input };
      },
    });
    for (let index = 0; index < 4; index += 1) {
      await worker.enqueue("serial.job", { tenant: "acme", index });
      await worker.enqueue("serial.job", { tenant: "beta", index });
    }
    await worker.startWorkers("worker");
    await waitFor(async () => intervals.length === 8, "all runs");
    const byKey = (key: string) =>
      intervals.filter((item) => item.key === key).sort((left, right) => left.start - right.start);
    for (const key of ["acme", "beta"]) {
      const own = byKey(key);
      expect(own).toHaveLength(4);
      for (let index = 1; index < own.length; index += 1) {
        expect((own[index] as { start: number }).start).toBeGreaterThanOrEqual(
          (own[index - 1] as { end: number }).end,
        );
      }
    }
    expect(
      byKey("acme").some((left) =>
        byKey("beta").some((right) => left.start < right.end && right.start < left.end),
      ),
    ).toBe(true);
    const [row] = await context.db.select().from(runs).limit(1);
    expect(row?.attempts).toBe(1);
  });

  it("keeps runs inside retention and deletes only those past it", async () => {
    const worker = backend();
    started.push(worker);
    await worker.attach({
      jobs: [declaration("retain.job", { retention: { completedMs: 1_000, deadLetteredMs: 500 } })],
      execute: async () => ({ ok: true, data: undefined }),
    });
    const now = new Date();
    await context.db.insert(runs).values([
      {
        id: "retain.job/old-completed",
        jobId: "retain.job",
        input: {},
        status: "completed",
        attempts: 1,
        history: [],
        createdAt: now,
        availableAt: now,
        completedAt: new Date(now.getTime() - 2_000),
      },
      {
        id: "retain.job/fresh-completed",
        jobId: "retain.job",
        input: {},
        status: "completed",
        attempts: 1,
        history: [],
        createdAt: now,
        availableAt: now,
        completedAt: new Date(now.getTime() - 100),
      },
      {
        id: "retain.job/old-failed",
        jobId: "retain.job",
        input: {},
        status: "failed",
        attempts: 2,
        history: [{ attempt: 2, error: "boom", at: now.toISOString() }],
        createdAt: now,
        availableAt: now,
        failedAt: new Date(now.getTime() - 600),
      },
      {
        id: "retain.job/fresh-discarded",
        jobId: "retain.job",
        input: {},
        status: "discarded",
        attempts: 2,
        history: [],
        createdAt: now,
        availableAt: now,
        discardedAt: new Date(now.getTime() - 100),
        discardReason: "operator",
      },
      {
        id: "unknown.job/old-completed",
        jobId: "unknown.job",
        input: {},
        status: "completed",
        attempts: 1,
        history: [],
        createdAt: now,
        availableAt: now,
        // Past the fixture retention but well inside the 7-day default for undeclared jobs.
        completedAt: new Date(now.getTime() - 60_000),
      },
    ]);
    expect(await worker.cleanup(now)).toEqual({ completedDeleted: 1, deadLetteredDeleted: 1 });
    const remaining = (await context.db.select({ id: runs.id }).from(runs)).map((row) => row.id);
    expect(remaining.sort()).toEqual([
      "retain.job/fresh-completed",
      "retain.job/fresh-discarded",
      "unknown.job/old-completed",
    ]);
  });

  it("returns queue-full per job once waiting and delayed runs reach the limit", async () => {
    const limited = backend({ queueDepthLimit: 2 });
    await limited.attach({
      jobs: [declaration("full.a"), declaration("full.b")],
      execute: async () => ({ ok: true, data: undefined }),
    });
    expect(await limited.enqueue("full.a", {})).toMatchObject({ accepted: true });
    expect(await limited.enqueue("full.a", {}, { delayMs: 60_000 })).toMatchObject({
      accepted: true,
    });
    expect(await limited.enqueue("full.a", {})).toEqual({
      accepted: false,
      rejected: "queue-full",
    });
    expect(await limited.enqueue("full.b", {})).toMatchObject({ accepted: true });
    const health = await limited.health(new Date());
    expect(health.jobs.find((entry) => entry.jobId === "full.a")).toMatchObject({
      waiting: 1,
      delayed: 1,
    });
  });

  it("dead-letters with input and error history, re-runs once on retry, then discards", async () => {
    const worker = backend();
    started.push(worker);
    let attempts = 0;
    await worker.attach({
      jobs: [declaration("dead.job", { retry: { attempts: 2, backoff: { initialMs: 5 } } })],
      execute: async (_jobId, _input, run) => {
        attempts += 1;
        return { ok: false, retryable: true, error: `attempt ${run.attempt} failed` };
      },
    });
    const accepted = await worker.enqueue("dead.job", { order: 42 });
    if (!accepted.accepted) throw new Error("rejected");
    await worker.startWorkers("worker");
    await waitFor(async () => (await worker.listFailed({ limit: 5 })).length === 1, "dead-letter");
    const [failed] = await worker.listFailed({ limit: 5 });
    expect(failed).toMatchObject({
      runId: accepted.runId,
      input: { order: 42 },
      status: "failed",
      attempts: 2,
      lastError: "attempt 2 failed",
    });
    expect(failed?.history.map((item) => item.error)).toEqual([
      "attempt 1 failed",
      "attempt 2 failed",
    ]);
    expect(failed?.failedAt).toBeInstanceOf(Date);

    expect(await worker.retry(accepted.runId)).toMatchObject({ status: "waiting" });
    await waitFor(async () => attempts === 3, "one more attempt");
    await waitFor(async () => (await worker.listFailed({ limit: 5 })).length === 1, "again");
    expect((await worker.listFailed({ limit: 5 }))[0]?.history).toHaveLength(3);
    expect(await worker.discard(accepted.runId, "operator gave up")).toMatchObject({
      status: "discarded",
      discardReason: "operator gave up",
    });
    expect(await worker.listFailed({ limit: 5 })).toHaveLength(0);
    expect(await worker.retry(accepted.runId)).toBeUndefined();
  });

  it("replaces a schedule without duplicating it and ticks with durable run ids", async () => {
    const worker = backend();
    started.push(worker);
    const seen: string[] = [];
    await worker.attach({
      jobs: [declaration("tick.job", { trigger: { kind: "interval", everyMs: 200 } })],
      execute: async (_jobId, _input, run) => {
        seen.push(run.runId);
        return { ok: true, data: undefined };
      },
    });
    await worker.schedule("tick.job", { kind: "interval", everyMs: 200 });
    await worker.schedule("tick.job", { kind: "interval", everyMs: 200 });
    const [before] = await context.db.select().from(state);
    await worker.schedule("tick.job", { kind: "interval", everyMs: 300 });
    const [after] = await context.db.select().from(state);
    expect(after?.trigger).toEqual({ kind: "interval", everyMs: 300 });
    expect(after?.nextAt?.getTime()).toBeGreaterThan(before?.nextAt?.getTime() as number);
    await worker.startWorkers("worker");
    await waitFor(async () => seen.length >= 3, "three ticks");
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.every((runId) => runId.startsWith("tick.job/20"))).toBe(true);
    await worker.unschedule("tick.job");
    const [cleared] = await context.db.select().from(state);
    expect(cleared?.trigger).toBeNull();
    expect(cleared?.lastSuccessAt).toBeInstanceOf(Date);
  });
});
