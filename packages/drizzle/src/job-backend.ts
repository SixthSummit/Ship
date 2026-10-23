import type { MeterProvider } from "@opentelemetry/api";
import type {
  JobBackend,
  JobCleanupResult,
  JobConcurrencyBudget,
  JobEnqueueOptions,
  JobEnqueueResult,
  JobExecutionOutcome,
  JobHealth,
  JobIntervalTrigger,
  JobIntrospection,
  JobRetention,
  JobRun,
  JobRunQuery,
  JobRuntimeBinding,
  JobRuntimeDeclaration,
  JobScheduleTrigger,
  JobWorkerMode,
  LockProvider,
} from "@sixthsummit/ship-core";
import { backoffDelay, DEFAULT_JOB_RETENTION, isLockProvider } from "@sixthsummit/ship-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { advisoryLockProvider } from "./advisory-lock.js";
import { createDrizzleJobMetrics, type JobMetrics } from "./job-metrics.js";
import { nextOccurrence } from "./job-schedule.js";
import {
  type ClaimedRun,
  createDrizzleJobRunStore,
  type JobRunStore,
  type ShipJobControlTable,
  type ShipJobRunsTable,
  type ShipJobStateTable,
  shipJobRunsTable,
  shipJobStateTable,
} from "./job-store.js";
import { DrizzleRepositoryError } from "./repository-error.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_QUEUE_DEPTH_LIMIT = 10_000;
const DEFAULT_MAX_IN_FLIGHT = 16;
const DEDUPE_RETRIES = 3;

export interface DrizzleJobBackendOptions<TSchema extends Record<string, unknown>> {
  readonly database: NodePgDatabase<TSchema>;
  /** Defaults to `shipJobRunsTable()`; pass the same instance used in migrations. */
  readonly table?: ShipJobRunsTable;
  /** Defaults to `shipJobStateTable()`; pass the same instance used in migrations. */
  readonly stateTable?: ShipJobStateTable;
  /**
   * Opt-in operator control state (`shipJobControlTable()`), the durable home
   * of pause/resume. Without it `backend.introspection` exposes no
   * `pause`/`resume` and no existing table changes shape.
   */
  readonly controlTable?: ShipJobControlTable;
  /**
   * The `LockProvider` single-runner jobs should bind (`lockProviderDependency()`).
   * Defaults to `advisoryLockProvider(database)`; exposed as `backend.lockProvider`.
   */
  readonly lockProvider?: LockProvider;
  /** How long a worker sleeps when nothing is claimable. Defaults to 1 s. */
  readonly pollIntervalMs?: number;
  /** Runs waiting or delayed per job before `enqueue` returns `queue-full`. Defaults to 10 000. */
  readonly queueDepthLimit?: number;
  /** Process-wide in-flight cap across every job. Defaults to 16. */
  readonly maxInFlight?: number;
  /** Defaults to the global OpenTelemetry meter provider. */
  readonly meterProvider?: MeterProvider;
  /** Receives poll, heartbeat and stale-lease errors the worker loop absorbs. */
  readonly onError?: (
    error: unknown,
    context: { readonly jobId?: string; readonly runId?: string },
  ) => void;
  readonly clock?: () => Date;
}

export interface DrizzleJobBackend extends JobBackend {
  readonly adapter: "drizzle";
  readonly table: ShipJobRunsTable;
  readonly stateTable: ShipJobStateTable;
  readonly controlTable?: ShipJobControlTable;
  readonly lockProvider: LockProvider;
  readonly metrics: JobMetrics;
  readonly introspection: JobIntrospection;
}

/**
 * PostgreSQL implementation of the kernel `JobBackend` for consumers whose
 * only stateful dependency is Postgres. Runs live in `shipJobRunsTable()`;
 * workers poll and claim due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, hold
 * a lease they heartbeat while the handler runs, and record the outcome only
 * while their fencing token is still current. Schedules are reconciled in
 * `shipJobStateTable()` (replace, never duplicate) and ticked by whichever
 * process locks the row first. Delivery is at-least-once: a process that dies
 * mid-run leaves an active row whose lease expires and is retaken.
 */
export function createDrizzleJobBackend<TSchema extends Record<string, unknown>>(
  options: DrizzleJobBackendOptions<TSchema>,
): DrizzleJobBackend {
  assertOptions(options);
  const table = options.table ?? shipJobRunsTable();
  const stateTable = options.stateTable ?? shipJobStateTable();
  const database = options.database as unknown as NodePgDatabase<Record<string, unknown>>;
  const clock = options.clock ?? (() => new Date());
  const lockProvider = options.lockProvider ?? advisoryLockProvider(database, { clock });
  const metrics = createDrizzleJobMetrics(options.meterProvider);
  const store = createDrizzleJobRunStore(database, table, stateTable, options.controlTable);
  const core = createJobBackendOverStore(store, {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxQueueDepth: options.queueDepthLimit ?? DEFAULT_QUEUE_DEPTH_LIMIT,
    maxInFlight: options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
    metrics,
    clock,
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return Object.freeze({
    ...core,
    adapter: "drizzle" as const,
    table,
    stateTable,
    ...(options.controlTable ? { controlTable: options.controlTable } : {}),
    lockProvider,
    metrics,
    introspection: core.introspection as JobIntrospection,
  });
}

export interface JobBackendCoreOptions {
  readonly pollIntervalMs: number;
  readonly maxQueueDepth: number;
  readonly maxInFlight: number;
  readonly metrics: JobMetrics;
  readonly clock: () => Date;
  readonly onError?: (
    error: unknown,
    context: { readonly jobId?: string; readonly runId?: string },
  ) => void;
}

/**
 * @internal The worker loop, scheduling and retry policy over a `JobRunStore`;
 * `createDrizzleJobBackend` composes it with the Drizzle store.
 */
export function createJobBackendOverStore(
  store: JobRunStore,
  options: JobBackendCoreOptions,
): JobBackend & { readonly introspection: JobIntrospection } {
  const { metrics, clock } = options;
  const budget: JobConcurrencyBudget = Object.freeze({
    maxInFlight: options.maxInFlight,
    maxQueueDepth: options.maxQueueDepth,
  });
  const declarations = new Map<string, JobRuntimeDeclaration>();
  const inFlight = new Set<Promise<void>>();
  const activeByJob = new Map<string, number>();
  const activeKeys = new Map<string, Map<string, number>>();
  let binding: JobRuntimeBinding | undefined;
  let workerBudget = budget;
  let quitting = false;
  let loop: Promise<void> | undefined;
  let wakeRequested = false;
  let wakeSleeper: (() => void) | undefined;
  let observing = false;

  const report = (error: unknown, context: { jobId?: string; runId?: string }) => {
    options.onError?.(error, context);
  };

  const declaration = (jobId: string): JobRuntimeDeclaration => {
    const found = declarations.get(jobId);
    if (!found) {
      throw new DrizzleRepositoryError(
        "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
        `PostgreSQL job backend knows no job ${JSON.stringify(jobId)}; attach it with startJobRuntime first`,
        { jobId },
      );
    }
    return found;
  };

  const wake = () => {
    wakeRequested = true;
    wakeSleeper?.();
  };

  const sleep = () =>
    new Promise<void>((resolve) => {
      if (wakeRequested) {
        wakeRequested = false;
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wakeSleeper = undefined;
        resolve();
      }, options.pollIntervalMs);
      unref(timer);
      wakeSleeper = () => {
        clearTimeout(timer);
        wakeSleeper = undefined;
        wakeRequested = false;
        resolve();
      };
    });

  const enqueue = async (
    jobId: string,
    input: unknown,
    enqueueOptions: JobEnqueueOptions = {},
  ): Promise<JobEnqueueResult> => {
    const job = declaration(jobId);
    const dedupeKey = enqueueOptions.dedupeKey;
    for (let attempt = 0; attempt < DEDUPE_RETRIES; attempt += 1) {
      if (dedupeKey !== undefined) {
        const existing = await store.findDeduplicated(jobId, dedupeKey);
        if (existing !== undefined) {
          return Object.freeze({ accepted: true as const, runId: existing, deduplicated: true });
        }
      }
      if ((await store.countQueued(jobId)) >= budget.maxQueueDepth) {
        return Object.freeze({ accepted: false as const, rejected: "queue-full" as const });
      }
      const now = clock();
      const runId = `${jobId}/${globalThis.crypto.randomUUID()}`;
      const inserted = await store.insert({
        runId,
        jobId,
        input,
        ...(job.key ? { key: job.key(input) } : {}),
        ...(dedupeKey !== undefined ? { dedupeKey } : {}),
        createdAt: now,
        availableAt: new Date(now.getTime() + (enqueueOptions.delayMs ?? 0)),
      });
      if (inserted) {
        if (loop) wake();
        return Object.freeze({ accepted: true as const, runId, deduplicated: false });
      }
      if (dedupeKey === undefined) break;
    }
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
      `job ${JSON.stringify(jobId)} run could not be recorded`,
      { jobId },
    );
  };

  const schedule = async (jobId: string, trigger: JobScheduleTrigger | JobIntervalTrigger) => {
    declaration(jobId);
    await store.upsertSchedule(jobId, trigger, nextOccurrence(trigger, clock()));
  };

  const unschedule = async (jobId: string) => {
    await store.deleteSchedule(jobId);
  };

  const active = (jobId: string) => activeByJob.get(jobId) ?? 0;

  const track = (run: ClaimedRun, delta: 1 | -1) => {
    activeByJob.set(run.jobId, active(run.jobId) + delta);
    const key = run.key ?? "";
    let keys = activeKeys.get(run.jobId);
    if (!keys) {
      keys = new Map();
      activeKeys.set(run.jobId, keys);
    }
    const next = (keys.get(key) ?? 0) + delta;
    if (next <= 0) keys.delete(key);
    else keys.set(key, next);
  };

  const pollOnce = async (): Promise<boolean> => {
    const bound = binding;
    if (!bound || quitting) return false;
    const now = clock();
    const scheduled = [...declarations.values()]
      .filter((job) => job.trigger.kind === "schedule" || job.trigger.kind === "interval")
      .map((job) => job.id);
    if (scheduled.length > 0) await store.tick(scheduled, now, nextOccurrence);
    const paused = store.setPaused ? new Set(await store.listPaused()) : undefined;
    let claimedAny = false;
    for (const job of [...declarations.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      if (quitting) break;
      if (paused?.has(job.id)) continue;
      const capacity = Math.min(
        job.concurrency.max - active(job.id),
        workerBudget.maxInFlight - inFlight.size,
      );
      if (capacity <= 0) continue;
      const single = job.concurrency.mode === "single-runner";
      const claimed = await store.claim(
        {
          jobId: job.id,
          limit: single ? 1 : capacity,
          leaseMs: job.concurrency.leaseMs,
          excludeKeys: single ? [...(activeKeys.get(job.id)?.keys() ?? [])] : [],
        },
        now,
      );
      for (const run of claimed) {
        claimedAny = true;
        start(run, job, bound);
      }
    }
    return claimedAny;
  };

  const start = (run: ClaimedRun, job: JobRuntimeDeclaration, bound: JobRuntimeBinding) => {
    track(run, 1);
    const pending: Promise<void> = execute(run, job, bound)
      .catch((error: unknown) => report(error, { jobId: run.jobId, runId: run.runId }))
      .finally(() => {
        track(run, -1);
        inFlight.delete(pending);
        wake();
      });
    inFlight.add(pending);
  };

  const execute = async (run: ClaimedRun, job: JobRuntimeDeclaration, bound: JobRuntimeBinding) => {
    const key = run.key ?? "";
    const heartbeat = startHeartbeat(run, job.concurrency.leaseMs);
    const started = Date.now();
    let outcome: JobExecutionOutcome;
    try {
      outcome = await bound.execute(run.jobId, run.input, {
        runId: run.runId,
        attempt: run.attempts,
        ...(run.key !== undefined ? { key: run.key } : {}),
      });
    } catch (error) {
      outcome = { ok: false, retryable: true, error: describeError(error) };
    } finally {
      heartbeat.stop();
    }
    const duration = Date.now() - started;
    const now = clock();
    let recorded: boolean;
    if (outcome.ok) {
      metrics.recordRun(run.jobId, key, "success", duration);
      recorded = await store.complete(run.runId, run.jobId, run.claimToken, now);
    } else if (outcome.lockHeld) {
      metrics.recordRun(run.jobId, key, "lock-held", duration);
      metrics.recordLockWait(run.jobId, key, duration);
      recorded = await store.reschedule(
        run.runId,
        run.claimToken,
        new Date(now.getTime() + contentionDelay(job)),
      );
    } else {
      metrics.recordRun(run.jobId, key, "failure", duration);
      const deadLetter = !outcome.retryable || run.attempts >= job.retry.attempts;
      recorded = await store.fail(
        run.runId,
        run.claimToken,
        { attempt: run.attempts, error: outcome.error, at: now },
        deadLetter
          ? { deadLetter: true }
          : { retryAt: new Date(now.getTime() + backoffDelay(job.retry.backoff, run.attempts)) },
      );
    }
    if (!recorded) {
      report(
        new DrizzleRepositoryError(
          "SHIP_DRIZZLE_JOB_LEASE_STALE",
          `run ${JSON.stringify(run.runId)} of job ${JSON.stringify(run.jobId)} finished after its lease expired and another claim took it; its outcome was not recorded`,
          { jobId: run.jobId, runId: run.runId },
        ),
        { jobId: run.jobId, runId: run.runId },
      );
    }
  };

  const startHeartbeat = (run: ClaimedRun, leaseMs: number): { stop(): void } => {
    const interval = Math.max(1, Math.floor(leaseMs / 3));
    const timer = setInterval(() => {
      void store
        .heartbeat(run.runId, run.claimToken, new Date(clock().getTime() + leaseMs))
        .then((extended) => {
          if (!extended) clearInterval(timer);
        })
        .catch((error: unknown) => report(error, { jobId: run.jobId, runId: run.runId }));
    }, interval);
    unref(timer);
    return { stop: () => clearInterval(timer) };
  };

  const startWorkers = async (
    mode: JobWorkerMode,
    override: Partial<JobConcurrencyBudget> = {},
  ) => {
    workerBudget = Object.freeze({ ...budget, ...override });
    if (mode === "api") return 0;
    if (!binding) {
      throw new DrizzleRepositoryError(
        "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
        "attach the backend with startJobRuntime before starting workers",
      );
    }
    for (const job of declarations.values()) {
      if (job.trigger.kind !== "schedule" && job.trigger.kind !== "interval") {
        // Reconcile: a job whose trigger changed away from a schedule loses its schedule.
        await store.deleteSchedule(job.id);
      }
    }
    if (!observing) {
      observing = true;
      metrics.observeQueues(async () =>
        (await store.health([...declarations.keys()], clock())).map((entry) => ({
          jobId: entry.jobId,
          depth: entry.waiting + entry.delayed,
          oldestWaitingAgeMs: entry.lagMs,
          deadLettered: entry.failed,
        })),
      );
    }
    if (loop) return 1;
    quitting = false;
    loop = (async () => {
      while (!quitting) {
        let claimed = false;
        try {
          claimed = await pollOnce();
        } catch (error) {
          report(error, {});
        }
        if (!claimed && !quitting) await sleep();
      }
    })();
    return 1;
  };

  const quit = async () => {
    quitting = true;
    wake();
    await loop;
    loop = undefined;
    await Promise.allSettled([...inFlight]);
  };

  const health = async (now: Date): Promise<JobHealth> =>
    Object.freeze({ jobs: await store.health([...declarations.keys()], now) });

  const listFailed = async ({ limit }: { readonly limit: number }): Promise<readonly JobRun[]> =>
    store.listFailed(limit);

  const retry = async (runId: string) => {
    const run = await store.retry(runId, clock());
    if (run && loop) wake();
    return run;
  };

  const discard = async (runId: string, reason: string) => store.discard(runId, reason, clock());

  const cleanup = async (now: Date): Promise<JobCleanupResult> => {
    const retention = new Map<string, JobRetention>();
    for (const job of declarations.values()) {
      retention.set(job.id, job.retention ?? DEFAULT_JOB_RETENTION);
    }
    return store.cleanup(retention, DEFAULT_JOB_RETENTION, now);
  };

  const setPaused = store.setPaused?.bind(store);
  const introspection: JobIntrospection = Object.freeze({
    kind: "ship.job-introspection" as const,
    declarations: () => Object.freeze([...declarations.values()]),
    listRuns: (query: JobRunQuery) => store.listRuns(query, clock()),
    getRun: (runId: string) => store.getRun(runId, clock()),
    listSchedules: () => store.listSchedules(),
    listPaused: () => store.listPaused(),
    ...(setPaused
      ? {
          pause: async (jobId: string) => {
            declaration(jobId);
            await setPaused(jobId, true, clock());
          },
          resume: async (jobId: string) => {
            declaration(jobId);
            await setPaused(jobId, false, clock());
            if (loop) wake();
          },
        }
      : {}),
  });

  return Object.freeze({
    kind: "ship.job-backend" as const,
    adapter: "drizzle" as const,
    concurrencyBudget: budget,
    introspection,
    attach: (value: JobRuntimeBinding) => {
      if (quitting && loop) {
        throw new DrizzleRepositoryError(
          "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
          "cannot attach a job backend while it is quitting",
        );
      }
      binding = value;
      declarations.clear();
      for (const job of value.jobs) declarations.set(job.id, job);
    },
    enqueue,
    schedule,
    unschedule,
    startWorkers,
    quit,
    health,
    listFailed,
    retry,
    discard,
    cleanup,
  });
}

/** Adds bounded jitter so contending runners for one key do not retry in lockstep. */
function contentionDelay(job: JobRuntimeDeclaration): number {
  const base = backoffDelay(job.retry.backoff, 1);
  return base + Math.floor(Math.random() * Math.max(1, base));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : "job run failed";
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
}

function assertOptions(
  options: unknown,
): asserts options is DrizzleJobBackendOptions<Record<string, unknown>> {
  if (typeof options !== "object" || options === null) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
      "createDrizzleJobBackend options must be an object",
      { field: "options" },
    );
  }
  const database = Reflect.get(options, "database");
  if (
    typeof database !== "object" ||
    database === null ||
    typeof Reflect.get(database, "transaction") !== "function"
  ) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
      "createDrizzleJobBackend requires a Drizzle database with transaction(callback)",
      { field: "database" },
    );
  }
  for (const field of ["table", "stateTable", "controlTable"] as const) {
    const value = Reflect.get(options, field);
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      throw new DrizzleRepositoryError(
        "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
        `${field} must be created with shipJobRunsTable() / shipJobStateTable() / shipJobControlTable()`,
        { field },
      );
    }
  }
  const lockProvider = Reflect.get(options, "lockProvider");
  if (lockProvider !== undefined && !isLockProvider(lockProvider)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
      "lockProvider must be a LockProvider",
      { field: "lockProvider" },
    );
  }
  for (const field of ["pollIntervalMs", "queueDepthLimit", "maxInFlight"] as const) {
    const value = Reflect.get(options, field);
    if (value !== undefined && !(Number.isInteger(value) && (value as number) > 0)) {
      throw new DrizzleRepositoryError(
        "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
        `${field} must be a positive integer`,
        { field },
      );
    }
  }
  for (const field of ["onError", "clock"] as const) {
    const value = Reflect.get(options, field);
    if (value !== undefined && typeof value !== "function") {
      throw new DrizzleRepositoryError(
        "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
        `${field} must be a function`,
        { field },
      );
    }
  }
}
