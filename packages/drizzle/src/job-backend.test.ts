import type {
  JobAttemptFailure,
  JobHealthEntry,
  JobIntervalTrigger,
  JobRetention,
  JobRun,
  JobRunExecution,
  JobRuntimeDeclaration,
  JobScheduleTrigger,
} from "@sixthsummit/ship-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDrizzleJobBackend, createJobBackendOverStore } from "./job-backend.js";
import { createDrizzleJobMetrics } from "./job-metrics.js";
import type {
  ClaimedRun,
  ClaimRequest,
  FailureDisposition,
  JobRunStore,
  NewJobRun,
} from "./job-store.js";
import { shipJobRunsTable, shipJobStateTable } from "./job-store.js";

interface Row {
  runId: string;
  jobId: string;
  input: unknown;
  key?: string;
  dedupeKey?: string;
  status: JobRun["status"];
  attempts: number;
  lastError?: string;
  history: JobAttemptFailure[];
  createdAt: Date;
  availableAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  discardedAt?: Date;
  discardReason?: string;
  leaseExpiresAt?: Date;
  claimToken?: string;
}

/** A faithful in-memory `JobRunStore` so the worker loop runs without PostgreSQL. */
function memoryStore() {
  const rows: Row[] = [];
  const schedules = new Map<
    string,
    { trigger: JobScheduleTrigger | JobIntervalTrigger; nextAt: Date }
  >();
  const marks = new Map<string, { lastRunAt?: Date; lastSuccessAt?: Date }>();
  const paused = new Set<string>();
  let tokens = 0;
  const snapshot = (row: Row): JobRun => Object.freeze({ ...row, history: [...row.history] });
  const delayedView = (row: Row, now: Date): JobRun =>
    Object.freeze({
      ...snapshot(row),
      status: row.status === "waiting" && row.availableAt > now ? "delayed" : row.status,
    });
  const owned = (runId: string, token: string) =>
    rows.find((row) => row.runId === runId && row.status === "active" && row.claimToken === token);
  const store: JobRunStore = {
    insert: async (run: NewJobRun) => {
      if (rows.some((row) => row.runId === run.runId)) return false;
      if (
        run.dedupeKey !== undefined &&
        rows.some(
          (row) =>
            row.jobId === run.jobId &&
            row.dedupeKey === run.dedupeKey &&
            (row.status === "waiting" || row.status === "active"),
        )
      ) {
        return false;
      }
      rows.push({ ...run, status: "waiting", attempts: 0, history: [] });
      return true;
    },
    findDeduplicated: async (jobId, dedupeKey) =>
      rows.find(
        (row) =>
          row.jobId === jobId &&
          row.dedupeKey === dedupeKey &&
          (row.status === "waiting" || row.status === "active"),
      )?.runId,
    countQueued: async (jobId) =>
      rows.filter((row) => row.jobId === jobId && row.status === "waiting").length,
    claim: async (request: ClaimRequest, now: Date) => {
      const due = rows
        .filter(
          (row) =>
            row.jobId === request.jobId &&
            ((row.status === "waiting" && row.availableAt <= now) ||
              (row.status === "active" && (row.leaseExpiresAt as Date) <= now)) &&
            (row.key === undefined || !request.excludeKeys.includes(row.key)),
        )
        .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())
        .slice(0, request.limit);
      tokens += 1;
      const token = `token-${tokens}`;
      for (const row of due) {
        row.status = "active";
        row.attempts += 1;
        row.startedAt = now;
        row.leaseExpiresAt = new Date(now.getTime() + request.leaseMs);
        row.claimToken = token;
      }
      if (due.length > 0) marks.set(request.jobId, { ...marks.get(request.jobId), lastRunAt: now });
      return due.map((row) => Object.freeze({ ...snapshot(row), claimToken: token }) as ClaimedRun);
    },
    heartbeat: async (runId, token, leaseExpiresAt) => {
      const row = owned(runId, token);
      if (!row) return false;
      row.leaseExpiresAt = leaseExpiresAt;
      return true;
    },
    complete: async (runId, jobId, token, now) => {
      const row = owned(runId, token);
      if (!row) return false;
      row.status = "completed";
      row.completedAt = now;
      marks.set(jobId, { ...marks.get(jobId), lastSuccessAt: now });
      return true;
    },
    reschedule: async (runId, token, availableAt) => {
      const row = owned(runId, token);
      if (!row) return false;
      row.status = "waiting";
      row.attempts -= 1;
      row.availableAt = availableAt;
      return true;
    },
    fail: async (runId, token, failure, disposition: FailureDisposition) => {
      const row = owned(runId, token);
      if (!row) return false;
      row.history.push(failure);
      row.lastError = failure.error;
      if ("deadLetter" in disposition) {
        row.status = "failed";
        row.failedAt = failure.at;
      } else {
        row.status = "waiting";
        row.availableAt = disposition.retryAt;
      }
      return true;
    },
    upsertSchedule: async (jobId, trigger, nextAt) => {
      const existing = schedules.get(jobId);
      schedules.set(jobId, {
        trigger,
        nextAt:
          existing && JSON.stringify(existing.trigger) === JSON.stringify(trigger)
            ? existing.nextAt
            : nextAt,
      });
    },
    deleteSchedule: async (jobId) => {
      schedules.delete(jobId);
    },
    tick: async (jobIds, now, advance) => {
      let enqueued = 0;
      for (const jobId of jobIds) {
        const entry = schedules.get(jobId);
        if (!entry || entry.nextAt > now) continue;
        const runId = `${jobId}/${entry.nextAt.toISOString()}`;
        if (!rows.some((row) => row.runId === runId)) {
          rows.push({
            runId,
            jobId,
            input: {},
            status: "waiting",
            attempts: 0,
            history: [],
            createdAt: entry.nextAt,
            availableAt: entry.nextAt,
          });
          enqueued += 1;
        }
        let next = entry.nextAt;
        while (next <= now) next = advance(entry.trigger, next);
        entry.nextAt = next;
      }
      return enqueued;
    },
    health: async (jobIds, now) =>
      [...new Set([...jobIds, ...rows.map((row) => row.jobId)])]
        .sort()
        .map((jobId): JobHealthEntry => {
          const own = rows.filter((row) => row.jobId === jobId);
          const waiting = own.filter((row) => row.status === "waiting" && row.availableAt <= now);
          const oldest = waiting.map((row) => row.availableAt).sort()[0];
          return {
            jobId,
            waiting: waiting.length,
            delayed: own.filter((row) => row.status === "waiting" && row.availableAt > now).length,
            active: own.filter((row) => row.status === "active").length,
            failed: own.filter((row) => row.status === "failed").length,
            lagMs: oldest ? now.getTime() - oldest.getTime() : 0,
            ...marks.get(jobId),
          };
        }),
    listFailed: async (limit) =>
      rows
        .filter((row) => row.status === "failed")
        .slice(0, limit)
        .map(snapshot),
    listRuns: async (query, now) =>
      rows
        .filter(
          (row) =>
            (query.jobId === undefined || row.jobId === query.jobId) &&
            (query.status === undefined ||
              (query.status === "delayed"
                ? row.status === "waiting" && row.availableAt > now
                : query.status === "waiting"
                  ? row.status === "waiting" && row.availableAt <= now
                  : row.status === query.status)),
        )
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            rows.indexOf(right) - rows.indexOf(left),
        )
        .slice(0, query.limit)
        .map((row) => delayedView(row, now)),
    getRun: async (runId, now) => {
      const row = rows.find((item) => item.runId === runId);
      return row ? delayedView(row, now) : undefined;
    },
    listSchedules: async () =>
      [...schedules]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([jobId, entry]) => ({ jobId, trigger: entry.trigger, nextAt: entry.nextAt })),
    listPaused: async () => [...paused].sort(),
    setPaused: async (jobId, value) => {
      if (value) paused.add(jobId);
      else paused.delete(jobId);
    },
    retry: async (runId, now) => {
      const row = rows.find((item) => item.runId === runId && item.status === "failed");
      if (!row) return undefined;
      row.status = "waiting";
      row.availableAt = now;
      row.failedAt = undefined;
      return snapshot(row);
    },
    discard: async (runId, reason, now) => {
      const row = rows.find((item) => item.runId === runId && item.status === "failed");
      if (!row) return undefined;
      row.status = "discarded";
      row.discardedAt = now;
      row.discardReason = reason;
      return snapshot(row);
    },
    cleanup: async (retention: ReadonlyMap<string, JobRetention>, fallback, now) => {
      let completedDeleted = 0;
      let deadLetteredDeleted = 0;
      for (const row of [...rows]) {
        const policy = retention.get(row.jobId) ?? fallback;
        if (
          row.status === "completed" &&
          now.getTime() - (row.completedAt as Date).getTime() >= policy.completedMs
        ) {
          rows.splice(rows.indexOf(row), 1);
          completedDeleted += 1;
        } else if (
          (row.status === "failed" || row.status === "discarded") &&
          now.getTime() - ((row.failedAt ?? row.discardedAt) as Date).getTime() >=
            policy.deadLetteredMs
        ) {
          rows.splice(rows.indexOf(row), 1);
          deadLetteredDeleted += 1;
        }
      }
      return { completedDeleted, deadLetteredDeleted };
    },
  };
  return { store, rows, schedules };
}

const schema = {
  "~standard": { version: 1 as const, vendor: "test", validate: (value: unknown) => ({ value }) },
};

function job(
  id: string,
  overrides: Partial<Omit<JobRuntimeDeclaration, "concurrency" | "retry">> & {
    readonly concurrency?: Partial<JobRuntimeDeclaration["concurrency"]>;
    readonly retry?: Partial<JobRuntimeDeclaration["retry"]>;
    readonly key?: (input: unknown) => string;
  } = {},
): JobRuntimeDeclaration {
  return {
    id,
    input: schema,
    trigger: { kind: "enqueue" },
    transaction: "none",
    ...overrides,
    concurrency: {
      mode: "parallel",
      max: 2,
      keyed: overrides.key !== undefined,
      leaseMs: 300,
      ...overrides.concurrency,
    },
    retry: { attempts: 3, backoff: { initialMs: 5 }, ...overrides.retry },
  };
}

function backendOver(
  store: JobRunStore,
  options: Partial<Parameters<typeof createJobBackendOverStore>[1]> = {},
) {
  return createJobBackendOverStore(store, {
    pollIntervalMs: 5,
    maxQueueDepth: 3,
    maxInFlight: 4,
    metrics: createDrizzleJobMetrics(),
    clock: () => new Date(),
    ...options,
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("createJobBackendOverStore", () => {
  const backends: { quit(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.quit()));
  });

  it("refuses to enqueue unknown jobs and to start workers before attach", async () => {
    const backend = backendOver(memoryStore().store);
    await expect(backend.enqueue("missing.job", {})).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
      jobId: "missing.job",
    });
    await expect(backend.startWorkers("worker")).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
    });
    expect(await backend.startWorkers("api")).toBe(0);
  });

  it("enqueues with keys, delay and dedupe, and reports queue-full past the depth", async () => {
    const { store, rows } = memoryStore();
    const backend = backendOver(store);
    backend.attach({
      jobs: [job("t.keyed", { key: (input) => (input as { tenant: string }).tenant })],
      execute: async () => ({ ok: true, data: undefined }),
    });
    const first = await backend.enqueue("t.keyed", { tenant: "acme" }, { dedupeKey: "a" });
    const second = await backend.enqueue("t.keyed", { tenant: "acme" }, { dedupeKey: "a" });
    expect(first).toMatchObject({ accepted: true, deduplicated: false });
    expect(second).toMatchObject({ accepted: true, deduplicated: true });
    if (!first.accepted || !second.accepted) throw new Error("unreachable");
    expect(second.runId).toBe(first.runId);
    expect(rows[0]).toMatchObject({ key: "acme", dedupeKey: "a" });

    const delayed = await backend.enqueue("t.keyed", { tenant: "beta" }, { delayMs: 60_000 });
    expect(delayed).toMatchObject({ accepted: true });
    expect(rows[1]?.availableAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    await backend.enqueue("t.keyed", { tenant: "gamma" });
    expect(await backend.enqueue("t.keyed", { tenant: "delta" })).toEqual({
      accepted: false,
      rejected: "queue-full",
    });
    const health = await backend.health(new Date());
    expect(health.jobs[0]).toMatchObject({ jobId: "t.keyed", waiting: 2, delayed: 1 });
  });

  it("exposes introspection over the store and skips paused jobs when polling", async () => {
    const { store, schedules } = memoryStore();
    const executed: string[] = [];
    const backend = backendOver(store, { pollIntervalMs: 5 });
    backends.push(backend);
    backend.attach({
      jobs: [job("t.paused"), job("t.cron", { trigger: { kind: "interval", everyMs: 60_000 } })],
      execute: async (jobId) => {
        executed.push(jobId);
        return { ok: true, data: undefined };
      },
    });
    expect(backend.introspection.declarations().map((item) => item.id)).toEqual([
      "t.paused",
      "t.cron",
    ]);
    const first = await backend.enqueue("t.paused", { n: 1 });
    await backend.enqueue("t.paused", { n: 2 }, { delayMs: 60_000 });
    if (!first.accepted) throw new Error("unreachable");
    expect((await backend.introspection.listRuns({ limit: 10 })).map((run) => run.status)).toEqual([
      "delayed",
      "waiting",
    ]);
    expect(await backend.introspection.getRun(first.runId)).toMatchObject({ input: { n: 1 } });
    await backend.schedule("t.cron", { kind: "interval", everyMs: 60_000 });
    expect(await backend.introspection.listSchedules()).toMatchObject([
      { jobId: "t.cron", trigger: { kind: "interval", everyMs: 60_000 } },
    ]);
    expect(schedules.has("t.cron")).toBe(true);

    await backend.introspection.pause?.("t.paused");
    expect(await backend.introspection.listPaused()).toEqual(["t.paused"]);
    await backend.startWorkers("worker");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(executed).toEqual([]);
    await backend.introspection.resume?.("t.paused");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(executed).toEqual(["t.paused"]);
    await expect(backend.introspection.pause?.("t.unknown")).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
    });
    await backend.quit();

    const { store: plain } = memoryStore();
    const { setPaused: _ignored, ...withoutControl } = plain;
    const bare = backendOver(withoutControl as JobRunStore);
    expect(bare.introspection.pause).toBeUndefined();
    expect(await bare.introspection.listPaused()).toEqual([]);
  });

  it("surfaces a dedupe insert that keeps losing the race as a backend error", async () => {
    const { store } = memoryStore();
    const racing: JobRunStore = {
      ...store,
      findDeduplicated: async () => undefined,
      insert: async () => false,
    };
    const backend = backendOver(racing);
    backend.attach({ jobs: [job("t.race")], execute: async () => ({ ok: true, data: 1 }) });
    await expect(backend.enqueue("t.race", {}, { dedupeKey: "x" })).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
    });
    await expect(backend.enqueue("t.race", {})).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
    });
  });

  it("claims, executes, retries with backoff, dead-letters and supports retry/discard", async () => {
    const { store, rows } = memoryStore();
    const calls: JobRunExecution[] = [];
    let failures = 4;
    const backend = backendOver(store);
    backends.push(backend);
    backend.attach({
      jobs: [job("t.flaky", { retry: { attempts: 3, backoff: { initialMs: 1 } } })],
      execute: async (_jobId, _input, run) => {
        calls.push(run);
        if (failures > 0) {
          failures -= 1;
          return { ok: false, retryable: true, error: `boom ${run.attempt}` };
        }
        return { ok: true, data: run.attempt };
      },
    });
    const accepted = await backend.enqueue("t.flaky", { n: 1 });
    if (!accepted.accepted) throw new Error("rejected");
    expect(await backend.startWorkers("worker")).toBe(1);
    expect(await backend.startWorkers("worker")).toBe(1);
    await waitFor(async () => (await backend.listFailed({ limit: 5 })).length === 1, "dead-letter");
    const [failed] = await backend.listFailed({ limit: 5 });
    expect(failed).toMatchObject({ status: "failed", attempts: 3, lastError: "boom 3" });
    expect(failed?.history.map((item) => item.error)).toEqual(["boom 1", "boom 2", "boom 3"]);
    expect(calls.map((call) => call.attempt)).toEqual([1, 2, 3]);

    const retried = await backend.retry(accepted.runId);
    expect(retried?.status).toBe("waiting");
    await waitFor(async () => (await backend.listFailed({ limit: 5 })).length === 1, "again");
    expect(rows[0]?.history).toHaveLength(4);
    expect(await backend.retry("nope")).toBeUndefined();
    await backend.retry(accepted.runId);
    await waitFor(() => rows[0]?.status === "completed", "success on the fifth attempt");
    const health = await backend.health(new Date());
    expect(health.jobs[0]?.lastSuccessAt).toBeDefined();
    expect(await backend.discard(accepted.runId, "no")).toBeUndefined();
  });

  it("dead-letters non-retryable outcomes, thrown executors, and discards with a reason", async () => {
    const { store } = memoryStore();
    const backend = backendOver(store);
    backends.push(backend);
    backend.attach({
      jobs: [job("t.final"), job("t.throws")],
      execute: async (jobId) => {
        if (jobId === "t.throws") throw new TypeError("exploded");
        return { ok: false, retryable: false, error: "VALIDATION: no" };
      },
    });
    const final = await backend.enqueue("t.final", {});
    await backend.enqueue("t.throws", {});
    await backend.startWorkers("worker");
    await waitFor(async () => (await backend.listFailed({ limit: 5 })).length === 1, "final");
    await waitFor(
      async () =>
        (await backend.health(new Date())).jobs.find((entry) => entry.jobId === "t.throws")
          ?.failed === 1,
      "thrown executor to exhaust attempts",
    );
    const failed = await backend.listFailed({ limit: 5 });
    expect(failed.find((run) => run.jobId === "t.throws")?.lastError).toBe("TypeError: exploded");
    if (!final.accepted) throw new Error("rejected");
    expect(await backend.discard(final.runId, "operator")).toMatchObject({
      status: "discarded",
      discardReason: "operator",
    });
  });

  it("delays contended single-runner keys without consuming an attempt and skips in-process active keys", async () => {
    const { store, rows } = memoryStore();
    let held = 1;
    const seen: string[] = [];
    const backend = backendOver(store);
    backends.push(backend);
    backend.attach({
      jobs: [
        job("t.serial", {
          key: (input) => (input as { k: string }).k,
          concurrency: { mode: "single-runner", max: 4 },
          retry: { attempts: 2, backoff: { initialMs: 1 } },
        }),
      ],
      execute: async (_jobId, input, run) => {
        seen.push(`${run.key}:${run.attempt}`);
        if (held > 0) {
          held -= 1;
          return { ok: false, retryable: true, lockHeld: true, error: "held" };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, data: input };
      },
    });
    await backend.enqueue("t.serial", { k: "a" });
    await backend.enqueue("t.serial", { k: "a" });
    await backend.enqueue("t.serial", { k: "b" });
    await backend.startWorkers("worker", { maxInFlight: 2 });
    await waitFor(() => rows.every((row) => row.status === "completed"), "all runs");
    expect(seen.every((entry) => entry.endsWith(":1"))).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
  });

  it("ticks schedules through the store, reconciles non-scheduled jobs and unschedules", async () => {
    const { store, rows, schedules } = memoryStore();
    let now = Date.parse("2026-09-18T10:00:00.000Z");
    const backend = backendOver(store, { clock: () => new Date(now) });
    backends.push(backend);
    backend.attach({
      jobs: [job("t.tick", { trigger: { kind: "interval", everyMs: 1_000 } }), job("t.plain")],
      execute: async () => ({ ok: true, data: undefined }),
    });
    await backend.schedule("t.tick", { kind: "interval", everyMs: 1_000 });
    await backend.schedule("t.plain", { kind: "interval", everyMs: 1_000 });
    const initialNext = schedules.get("t.tick")?.nextAt;
    await backend.schedule("t.tick", { kind: "interval", everyMs: 1_000 });
    expect(schedules.get("t.tick")?.nextAt).toEqual(initialNext);
    await backend.startWorkers("worker");
    expect(schedules.has("t.plain")).toBe(false);
    now += 2_500;
    await waitFor(() => rows.filter((row) => row.jobId === "t.tick").length === 1, "one tick");
    expect(rows[0]?.runId).toBe("t.tick/2026-09-18T10:00:01.000Z");
    expect(schedules.get("t.tick")?.nextAt.toISOString()).toBe("2026-09-18T10:00:03.000Z");
    await backend.unschedule("t.tick");
    expect(schedules.has("t.tick")).toBe(false);
    await expect(
      backend.schedule("t.unknown", { kind: "interval", everyMs: 1 }),
    ).rejects.toMatchObject({ code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID" });
  });

  it("reports a stale lease instead of recording an outcome another claim owns", async () => {
    const { store, rows } = memoryStore();
    const errors: unknown[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = backendOver(store, { onError: (error) => errors.push(error) });
    backends.push(backend);
    backend.attach({
      jobs: [job("t.stale", { concurrency: { leaseMs: 30 } })],
      execute: async () => {
        await gate;
        return { ok: true, data: undefined };
      },
    });
    await backend.enqueue("t.stale", {});
    await backend.startWorkers("worker");
    await waitFor(() => rows[0]?.status === "active", "claim");
    // Another process retook the run after the lease lapsed.
    const row = rows[0] as Row;
    row.claimToken = "someone-else";
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    await waitFor(() => errors.length === 1, "stale report");
    expect(errors[0]).toMatchObject({ code: "SHIP_DRIZZLE_JOB_LEASE_STALE", runId: row.runId });
    // The expired lease was retaken by this loop; only the fresh claim may record completion.
    await waitFor(() => row.status === "completed", "retake");
    expect(row.attempts).toBe(2);
  });

  it("absorbs store failures during polling and heartbeats through onError", async () => {
    const { store } = memoryStore();
    const errors: unknown[] = [];
    let claims = 0;
    const flaky: JobRunStore = {
      ...store,
      claim: async (request, now) => {
        claims += 1;
        if (claims === 1) throw new Error("connection reset");
        return store.claim(request, now);
      },
      heartbeat: async () => {
        throw new Error("heartbeat lost");
      },
    };
    const backend = backendOver(flaky, { onError: (error) => errors.push(error) });
    backends.push(backend);
    backend.attach({
      jobs: [job("t.poll", { concurrency: { leaseMs: 6 } })],
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true, data: undefined };
      },
    });
    await backend.enqueue("t.poll", {});
    await backend.startWorkers("worker");
    await waitFor(() => errors.length >= 2, "poll and heartbeat errors");
    expect((errors[0] as Error).message).toBe("connection reset");
    expect((errors[1] as Error).message).toBe("heartbeat lost");
  });

  it("drains in-flight work on quit and refuses attach while quitting", async () => {
    const { store, rows } = memoryStore();
    let finished = 0;
    const backend = backendOver(store);
    backend.attach({
      jobs: [job("t.slow")],
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        finished += 1;
        return { ok: true, data: undefined };
      },
    });
    await backend.enqueue("t.slow", {});
    await backend.startWorkers("worker");
    await waitFor(() => rows[0]?.status === "active", "claim");
    await backend.quit();
    expect(finished).toBe(1);
    expect(rows[0]?.status).toBe("completed");
    await backend.quit();
  });

  it("applies per-job retention and the default for unknown jobs on cleanup", async () => {
    const { store, rows } = memoryStore();
    const backend = backendOver(store);
    backend.attach({
      jobs: [job("t.short", { retention: { completedMs: 10, deadLetteredMs: 10 } })],
      execute: async () => ({ ok: true, data: undefined }),
    });
    const now = new Date();
    rows.push(
      {
        runId: "t.short/1",
        jobId: "t.short",
        input: {},
        status: "completed",
        attempts: 1,
        history: [],
        createdAt: now,
        availableAt: now,
        completedAt: new Date(now.getTime() - 20),
      },
      {
        runId: "t.other/1",
        jobId: "t.other",
        input: {},
        status: "failed",
        attempts: 1,
        history: [],
        createdAt: now,
        availableAt: now,
        failedAt: new Date(now.getTime() - 20),
      },
    );
    expect(await backend.cleanup(now)).toEqual({ completedDeleted: 1, deadLetteredDeleted: 0 });
  });
});

describe("createDrizzleJobBackend", () => {
  const database = { transaction: async () => undefined } as unknown as NodePgDatabase<
    Record<string, never>
  >;

  it("creates a frozen backend with default tables, an advisory lock provider and metrics", () => {
    const backend = createDrizzleJobBackend({ database, pollIntervalMs: 50, queueDepthLimit: 7 });
    expect(backend).toMatchObject({
      kind: "ship.job-backend",
      adapter: "drizzle",
      concurrencyBudget: { maxInFlight: 16, maxQueueDepth: 7 },
    });
    expect(Object.isFrozen(backend)).toBe(true);
    expect(backend.lockProvider).toMatchObject({ kind: "ship.lock-provider", adapter: "drizzle" });
    expect(backend.table).toBeDefined();
    expect(backend.stateTable).toBeDefined();
    expect(backend.metrics.meter).toBeDefined();
    const table = shipJobRunsTable("custom_runs");
    const stateTable = shipJobStateTable("custom_state");
    const lockProvider = {
      kind: "ship.lock-provider" as const,
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const custom = createDrizzleJobBackend({ database, table, stateTable, lockProvider });
    expect(custom.table).toBe(table);
    expect(custom.stateTable).toBe(stateTable);
    expect(custom.lockProvider).toBe(lockProvider);
  });

  it.each([
    ["non-object", null, "options"],
    ["missing database", {}, "database"],
    ["bad table", { database, table: "runs" }, "table"],
    ["bad state table", { database, stateTable: 1 }, "stateTable"],
    ["bad lock provider", { database, lockProvider: {} }, "lockProvider"],
    ["bad poll interval", { database, pollIntervalMs: 0 }, "pollIntervalMs"],
    ["bad depth", { database, queueDepthLimit: -1 }, "queueDepthLimit"],
    ["bad in-flight", { database, maxInFlight: 1.5 }, "maxInFlight"],
    ["bad onError", { database, onError: "log" }, "onError"],
    ["bad clock", { database, clock: 1 }, "clock"],
  ])("rejects %s options", (_name, options, field) => {
    expect(() => (createDrizzleJobBackend as (value: unknown) => unknown)(options)).toThrowError(
      expect.objectContaining({ code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID", field }),
    );
  });

  it("rejects unsafe table names", () => {
    expect(() => shipJobRunsTable("Ship-Runs")).toThrowError(
      expect.objectContaining({ code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID", field: "table" }),
    );
    expect(() => shipJobStateTable("state;drop")).toThrowError(
      expect.objectContaining({ code: "SHIP_DRIZZLE_JOB_BACKEND_INVALID" }),
    );
  });
});
