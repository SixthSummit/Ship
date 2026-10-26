import { createHash } from "node:crypto";
import type { MeterProvider } from "@opentelemetry/api";
import type {
  JobAttemptFailure,
  JobBackend,
  JobCleanupResult,
  JobConcurrencyBudget,
  JobEnqueueOptions,
  JobEnqueueResult,
  JobHealth,
  JobHealthEntry,
  JobIntervalTrigger,
  JobIntrospection,
  JobResultObservation,
  JobRun,
  JobRunQuery,
  JobRunStatus,
  JobRuntimeBinding,
  JobRuntimeDeclaration,
  JobScheduleState,
  JobScheduleTrigger,
  JobWorkerMode,
} from "@sixthsummit/ship-core";
import { backoffDelay, DEFAULT_JOB_RETENTION } from "@sixthsummit/ship-core";
import {
  type ConnectionOptions,
  DelayedError,
  Job,
  type JobsOptions,
  Queue,
  UnrecoverableError,
  Worker,
  type WorkerOptions,
} from "bullmq";
import { createJobMetrics, type JobMetrics } from "./metrics.js";

const SCHEDULER_ID = "schedule";
const BACKOFF_TYPE = "ship";
const DEFAULT_PREFIX = "ship";
const DEFAULT_MAX_QUEUE_DEPTH = 10_000;
const DEFAULT_MAX_IN_FLIGHT = 16;
const CLEAN_BATCH = 1_000;
const TERMINAL_STATES = new Set(["completed", "failed"]);
const RESULT_POLL_MS = 50;

export interface BullmqWorkerTuning {
  /** How long a run may go without a lock renewal before it counts as stalled. */
  readonly lockDuration?: number;
  readonly stalledInterval?: number;
  readonly maxStalledCount?: number;
  readonly drainDelay?: number;
}

export interface BullmqJobBackendOptions {
  readonly connection: ConnectionOptions;
  /** BullMQ key prefix shared by every queue this backend owns. Defaults to `ship`. */
  readonly prefix?: string;
  /** Runs waiting, delayed or prioritized per job before `enqueue` returns `queue-full`. */
  readonly maxQueueDepth?: number;
  /** Process-wide in-flight cap enforced across every worker. */
  readonly maxInFlight?: number;
  readonly worker?: BullmqWorkerTuning;
  /** Defaults to the global OpenTelemetry meter provider. */
  readonly meterProvider?: MeterProvider;
  /** Receives worker-level errors (connection loss, stalled-check failures). */
  readonly onError?: (error: unknown, context: { readonly jobId: string }) => void;
  readonly clock?: () => Date;
}

export interface BullmqJobBackend extends JobBackend {
  readonly adapter: "bullmq";
  readonly prefix: string;
  /** The BullMQ queue behind a job id, created on first use. */
  queue(jobId: string): Queue<BullmqJobData>;
  readonly metrics: JobMetrics;
}

export interface BullmqJobData {
  readonly input: unknown;
  readonly key?: string;
  readonly history: readonly {
    readonly attempt: number;
    readonly error: string;
    readonly at: string;
  }[];
}

interface HealthClient {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
}

/**
 * BullMQ implementation of the kernel `JobBackend`: one queue and worker per
 * declared job, job schedulers for cron and interval triggers (upserted, so a
 * boot never duplicates a schedule), bounded depth, a process-wide in-flight
 * budget, dead-letter retention and OpenTelemetry metrics. Delivery is
 * at-least-once: a worker that dies mid-run leaves a stalled job that BullMQ
 * returns to the queue after `lockDuration`.
 */
export function createBullmqJobBackend(options: BullmqJobBackendOptions): BullmqJobBackend {
  assertOptions(options);
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const clock = options.clock ?? (() => new Date());
  const budget: JobConcurrencyBudget = Object.freeze({
    maxInFlight: options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
    maxQueueDepth: options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
  });
  const metrics = createJobMetrics(options.meterProvider);
  const queues = new Map<string, Queue<BullmqJobData>>();
  const workers = new Map<string, Worker<BullmqJobData>>();
  const declarations = new Map<string, JobRuntimeDeclaration>();
  let binding: JobRuntimeBinding | undefined;
  let semaphore = createSemaphore(budget.maxInFlight);
  let quitting = false;
  let quitted: Promise<void> | undefined;
  let stopObserving: (() => void) | undefined;

  const queue = (jobId: string): Queue<BullmqJobData> => {
    const existing = queues.get(jobId);
    if (existing) return existing;
    // After quit() every queue is closed and dropped; recreating one here would
    // open a fresh Redis connection from late bookkeeping (a metrics
    // collection, a health probe) against a server that is going away.
    if (quitting)
      throw new Error(`BullMQ job backend has quit; queue ${JSON.stringify(jobId)} is closed`);
    const created = new Queue<BullmqJobData>(jobId, { connection: options.connection, prefix });
    created.on("error", (error) => options.onError?.(error, { jobId }));
    queues.set(jobId, created);
    return created;
  };

  const declaration = (jobId: string): JobRuntimeDeclaration => {
    const found = declarations.get(jobId);
    if (!found) throw new Error(`BullMQ job backend knows no job ${JSON.stringify(jobId)}`);
    return found;
  };

  const healthClient = async (jobId: string): Promise<HealthClient> =>
    (await queue(jobId).client) as unknown as HealthClient;
  const healthKey = (field: "last-run" | "last-success") => `${prefix}:ship-jobs:${field}`;

  const jobOptions = (job: JobRuntimeDeclaration): JobsOptions => ({
    attempts: job.retry.attempts,
    backoff: { type: BACKOFF_TYPE },
    removeOnComplete: {
      age: Math.ceil((job.retention ?? DEFAULT_JOB_RETENTION).completedMs / 1_000),
    },
    removeOnFail: false,
  });

  const enqueue = async (
    jobId: string,
    input: unknown,
    enqueueOptions: JobEnqueueOptions = {},
  ): Promise<JobEnqueueResult> => {
    const job = declaration(jobId);
    const target = queue(jobId);
    const bullId = enqueueOptions.dedupeKey
      ? dedupeId(enqueueOptions.dedupeKey, enqueueOptions.reuseTerminalDedupe === true)
      : undefined;
    if (bullId) {
      const existing = await target.getJob(bullId);
      if (existing) {
        const state = await existing.getState();
        if (!TERMINAL_STATES.has(state) || enqueueOptions.reuseTerminalDedupe) {
          return Object.freeze({
            accepted: true as const,
            runId: runIdFor(jobId, existing.id as string),
            deduplicated: true,
          });
        }
        await existing.remove();
      }
    }
    const counts = await target.getJobCounts("waiting", "delayed", "prioritized", "paused");
    const depth =
      (counts.waiting ?? 0) +
      (counts.delayed ?? 0) +
      (counts.prioritized ?? 0) +
      (counts.paused ?? 0);
    if (depth >= budget.maxQueueDepth) {
      return Object.freeze({ accepted: false as const, rejected: "queue-full" as const });
    }
    const data: BullmqJobData = {
      input,
      ...(job.key ? { key: job.key(input) } : {}),
      history: [],
    };
    const added = await target.add(jobId, data, {
      ...jobOptions(job),
      ...(bullId ? { jobId: bullId } : {}),
      ...(enqueueOptions.delayMs ? { delay: enqueueOptions.delayMs } : {}),
    });
    return Object.freeze({
      accepted: true as const,
      runId: runIdFor(jobId, added.id as string),
      deduplicated: false,
    });
  };

  const schedule = async (jobId: string, trigger: JobScheduleTrigger | JobIntervalTrigger) => {
    const job = declaration(jobId);
    await queue(jobId).upsertJobScheduler(
      SCHEDULER_ID,
      trigger.kind === "schedule"
        ? { pattern: trigger.cron, tz: trigger.tz }
        : { every: trigger.everyMs },
      { name: jobId, data: { input: {}, history: [] }, opts: jobOptions(job) },
    );
  };

  const unschedule = async (jobId: string) => {
    await queue(jobId).removeJobScheduler(SCHEDULER_ID);
  };

  const processor = async (job: Job<BullmqJobData>, token?: string): Promise<unknown> => {
    const bound = binding;
    if (!bound) throw new UnrecoverableError("job backend is not attached to an application");
    const jobId = job.name;
    const key = job.data.key ?? "";
    const runId = runIdFor(jobId, job.id as string);
    const attempt = job.attemptsMade + 1;
    await semaphore.acquire();
    const started = Date.now();
    try {
      await recordHealth(jobId, "last-run");
      const outcome = await bound.execute(jobId, job.data.input, {
        runId,
        attempt,
        ...(job.data.key !== undefined ? { key: job.data.key } : {}),
      });
      const duration = Date.now() - started;
      if (outcome.ok) {
        metrics.recordRun(jobId, key, "success", duration);
        await recordHealth(jobId, "last-success");
        return outcome.data;
      }
      if (outcome.lockHeld) {
        metrics.recordRun(jobId, key, "lock-held", duration);
        metrics.recordLockWait(jobId, key, duration);
        const delay = contentionDelay(declaration(jobId));
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }
      metrics.recordRun(jobId, key, "failure", duration);
      await job.updateData({
        ...job.data,
        history: [
          ...job.data.history,
          { attempt, error: outcome.error, at: clock().toISOString() },
        ],
      });
      if (!outcome.retryable) throw new UnrecoverableError(outcome.error);
      throw new Error(outcome.error);
    } finally {
      semaphore.release();
    }
  };

  const recordHealth = async (jobId: string, field: "last-run" | "last-success") => {
    try {
      const client = await healthClient(jobId);
      await client.hset(healthKey(field), jobId, clock().toISOString());
    } catch (error) {
      options.onError?.(error, { jobId });
    }
  };

  const startWorkers = async (
    mode: JobWorkerMode,
    override: Partial<JobConcurrencyBudget> = {},
  ) => {
    if (override.maxInFlight !== undefined && override.maxInFlight !== semaphore.size) {
      semaphore = createSemaphore(override.maxInFlight);
    }
    if (mode === "api") return 0;
    if (quitting) throw new Error("cannot start workers after quit()");
    if (!binding)
      throw new Error("attach the backend with startJobRuntime before starting workers");
    for (const job of [...declarations.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      if (job.trigger.kind !== "schedule" && job.trigger.kind !== "interval") {
        // Reconcile: a job whose trigger changed away from a schedule loses its scheduler.
        await queue(job.id).removeJobScheduler(SCHEDULER_ID);
      }
      if (workers.has(job.id)) continue;
      const workerOptions: WorkerOptions = {
        connection: options.connection,
        prefix,
        concurrency: job.concurrency.max,
        settings: {
          backoffStrategy: (attemptsMade: number) => backoffDelay(job.retry.backoff, attemptsMade),
        },
        ...(options.worker ?? {}),
      };
      const worker = new Worker<BullmqJobData>(job.id, processor, workerOptions);
      worker.on("error", (error) => options.onError?.(error, { jobId: job.id }));
      workers.set(job.id, worker);
    }
    if (!stopObserving) {
      stopObserving = metrics.observeQueues(async () =>
        quitting
          ? []
          : Promise.all(
              [...declarations.keys()].map(async (jobId) => {
                const entry = await healthEntry(jobId, clock());
                return {
                  jobId,
                  depth: entry.waiting + entry.delayed,
                  oldestWaitingAgeMs: entry.lagMs,
                  deadLettered: entry.failed,
                };
              }),
            ),
      );
    }
    return workers.size;
  };

  /**
   * Stops every worker (letting active runs finish), closes every queue and
   * detaches the metrics observer so no Redis traffic outlives the backend.
   * Idempotent: concurrent and repeated calls share one shutdown.
   */
  const quit = (): Promise<void> => {
    if (quitted) return quitted;
    quitting = true;
    quitted = (async () => {
      // Unregister first: a collection that starts after this point must not
      // read from queues that are about to close.
      stopObserving?.();
      stopObserving = undefined;
      await Promise.all(
        [...workers.values()].map((worker) => worker.close().catch(() => undefined)),
      );
      workers.clear();
      await Promise.all([...queues.values()].map((item) => item.close().catch(() => undefined)));
      queues.clear();
    })();
    return quitted;
  };

  const healthEntry = async (jobId: string, now: Date): Promise<JobHealthEntry> => {
    const target = queue(jobId);
    const counts = await target.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
      "prioritized",
    );
    const [oldest] = await target.getWaiting(0, 0);
    const client = await healthClient(jobId);
    const lastRun = await client.hget(healthKey("last-run"), jobId);
    const lastSuccess = await client.hget(healthKey("last-success"), jobId);
    return Object.freeze({
      jobId,
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      lagMs: oldest ? Math.max(0, now.getTime() - oldest.timestamp) : 0,
      ...(lastRun ? { lastRunAt: new Date(lastRun) } : {}),
      ...(lastSuccess ? { lastSuccessAt: new Date(lastSuccess) } : {}),
    });
  };

  const health = async (now: Date): Promise<JobHealth> => {
    const jobIds = [...declarations.keys()].sort();
    return Object.freeze({
      jobs: Object.freeze(await Promise.all(jobIds.map((jobId) => healthEntry(jobId, now)))),
    });
  };

  const listFailed = async ({ limit }: { readonly limit: number }): Promise<readonly JobRun[]> => {
    const runs: JobRun[] = [];
    for (const jobId of [...declarations.keys()].sort()) {
      const failed = await queue(jobId).getFailed(0, Math.max(0, limit - 1));
      for (const job of failed) runs.push(toRun(jobId, job as Job<BullmqJobData>, "failed"));
    }
    return Object.freeze(
      runs
        .sort((left, right) => (left.failedAt?.getTime() ?? 0) - (right.failedAt?.getTime() ?? 0))
        .slice(0, limit),
    );
  };

  const findRun = async (
    runId: string,
  ): Promise<{ jobId: string; job: Job<BullmqJobData> } | undefined> => {
    const separator = runId.indexOf("/");
    if (separator <= 0) return undefined;
    const jobId = runId.slice(0, separator);
    const bullId = runId.slice(separator + 1);
    if (!declarations.has(jobId) || bullId.length === 0) return undefined;
    const job = await Job.fromId<BullmqJobData>(queue(jobId), bullId);
    return job ? { jobId, job } : undefined;
  };

  const waitForResult = async (
    runId: string,
    { timeoutMs }: { readonly timeoutMs: number },
  ): Promise<JobResultObservation> => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new TypeError("waitForResult timeoutMs must be an integer from 1 through 120000");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const found = await findRun(runId);
      if (!found) return { status: "missing", runId };
      const state = await found.job.getState();
      if (state === "completed") {
        const completed = await findRun(runId);
        return completed
          ? { status: "completed", runId, data: completed.job.returnvalue }
          : { status: "missing", runId };
      }
      if (state === "failed") {
        const failed = await findRun(runId);
        return failed
          ? { status: "failed", runId, error: failed.job.failedReason ?? "job failed" }
          : { status: "missing", runId };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "pending", runId };
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(RESULT_POLL_MS, remaining)),
      );
    }
  };

  const retry = async (runId: string) => {
    const found = await findRun(runId);
    if (!found || !(await found.job.isFailed())) return undefined;
    await found.job.retry("failed");
    return toRun(found.jobId, found.job, "waiting");
  };

  const discard = async (runId: string, reason: string) => {
    const found = await findRun(runId);
    if (!found || !(await found.job.isFailed())) return undefined;
    const snapshot = toRun(found.jobId, found.job, "discarded", reason, clock());
    await found.job.remove();
    return snapshot;
  };

  const stateOf = async (job: Job<BullmqJobData>): Promise<JobRunStatus> =>
    runStatus(await job.getState());

  const introspection: JobIntrospection = Object.freeze({
    kind: "ship.job-introspection" as const,
    declarations: () => Object.freeze([...declarations.values()]),
    listRuns: async (query: JobRunQuery): Promise<readonly JobRun[]> => {
      const jobIds = query.jobId ? [query.jobId] : [...declarations.keys()].sort();
      const runs: JobRun[] = [];
      for (const jobId of jobIds) {
        if (!declarations.has(jobId)) continue;
        const bullJobs = await queue(jobId).getJobs(
          query.status ? bullTypes(query.status) : [...ALL_BULL_TYPES],
          0,
          Math.max(0, query.limit - 1),
          false,
        );
        for (const bullJob of bullJobs) {
          const status = await stateOf(bullJob as Job<BullmqJobData>);
          if (query.status && status !== query.status) continue;
          runs.push(toRun(jobId, bullJob as Job<BullmqJobData>, status));
        }
      }
      return Object.freeze(
        runs
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, query.limit),
      );
    },
    getRun: async (runId: string): Promise<JobRun | undefined> => {
      const found = await findRun(runId);
      return found ? toRun(found.jobId, found.job, await stateOf(found.job)) : undefined;
    },
    listSchedules: async (): Promise<readonly JobScheduleState[]> => {
      const schedules: JobScheduleState[] = [];
      for (const job of [...declarations.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        if (job.trigger.kind !== "schedule" && job.trigger.kind !== "interval") continue;
        const scheduler = await queue(job.id).getJobScheduler(SCHEDULER_ID);
        if (!scheduler) continue;
        schedules.push(
          Object.freeze({
            jobId: job.id,
            trigger: job.trigger,
            ...(typeof scheduler.next === "number" ? { nextAt: new Date(scheduler.next) } : {}),
          }),
        );
      }
      return Object.freeze(schedules);
    },
    listPaused: async (): Promise<readonly string[]> => {
      const ids: string[] = [];
      for (const jobId of [...declarations.keys()].sort()) {
        if (await queue(jobId).isPaused()) ids.push(jobId);
      }
      return Object.freeze(ids);
    },
    pause: async (jobId: string) => {
      declaration(jobId);
      await queue(jobId).pause();
    },
    resume: async (jobId: string) => {
      declaration(jobId);
      await queue(jobId).resume();
    },
  });

  const cleanup = async (): Promise<JobCleanupResult> => {
    let completedDeleted = 0;
    let deadLetteredDeleted = 0;
    for (const job of declarations.values()) {
      const retention = job.retention ?? DEFAULT_JOB_RETENTION;
      const target = queue(job.id);
      completedDeleted += (await target.clean(retention.completedMs, CLEAN_BATCH, "completed"))
        .length;
      deadLetteredDeleted += (await target.clean(retention.deadLetteredMs, CLEAN_BATCH, "failed"))
        .length;
    }
    return Object.freeze({ completedDeleted, deadLetteredDeleted });
  };

  return Object.freeze({
    kind: "ship.job-backend" as const,
    adapter: "bullmq" as const,
    prefix,
    concurrencyBudget: budget,
    metrics,
    queue,
    introspection,
    attach: (value: JobRuntimeBinding) => {
      if (quitting) throw new Error("cannot attach a job backend after quit()");
      binding = value;
      declarations.clear();
      for (const job of value.jobs) declarations.set(job.id, job);
    },
    enqueue,
    waitForResult,
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

const ALL_BULL_TYPES = [
  "waiting",
  "prioritized",
  "paused",
  "delayed",
  "active",
  "completed",
  "failed",
] as const;

type BullJobType = (typeof ALL_BULL_TYPES)[number];

/** The BullMQ job types that can hold a run of the given kernel status. */
function bullTypes(status: JobRunStatus): BullJobType[] {
  switch (status) {
    case "waiting":
      return ["waiting", "prioritized", "paused"];
    case "delayed":
      return ["delayed"];
    case "active":
      return ["active"];
    case "completed":
      return ["completed"];
    case "failed":
      return ["failed"];
    default:
      return [];
  }
}

/** Maps a BullMQ job state onto the kernel run status; discarded runs are removed, never listed. */
function runStatus(state: string): JobRunStatus {
  switch (state) {
    case "completed":
    case "failed":
    case "delayed":
    case "active":
      return state;
    default:
      return "waiting";
  }
}

/** Adds bounded jitter so contending runners for one key do not retry in lockstep. */
function contentionDelay(job: JobRuntimeDeclaration): number {
  const base = backoffDelay(job.retry.backoff, 1);
  return base + Math.floor(Math.random() * Math.max(1, base));
}

function runIdFor(jobId: string, bullId: string): string {
  return `${jobId}/${bullId}`;
}

/** Retained result keys require collision-resistant ids; legacy pending-only ids stay compatible. */
function dedupeId(dedupeKey: string, retainTerminal: boolean): string {
  if (retainTerminal) {
    return `result-${createHash("sha256").update(dedupeKey).digest("hex")}`;
  }
  return `dedupe-${dedupeKey.replace(/[^A-Za-z0-9._-]/gu, "-")}`;
}

function toRun(
  jobId: string,
  job: Job<BullmqJobData>,
  status: JobRunStatus,
  discardReason?: string,
  discardedAt?: Date,
): JobRun {
  const history: readonly JobAttemptFailure[] = Object.freeze(
    (job.data.history ?? []).map((item) =>
      Object.freeze({ attempt: item.attempt, error: item.error, at: new Date(item.at) }),
    ),
  );
  const lastError = history.at(-1)?.error ?? (job.failedReason || undefined);
  return Object.freeze({
    runId: runIdFor(jobId, job.id as string),
    jobId,
    input: job.data.input,
    ...(job.data.key !== undefined ? { key: job.data.key } : {}),
    ...(typeof job.opts.jobId === "string" && job.opts.jobId.startsWith("dedupe-")
      ? { dedupeKey: job.opts.jobId.slice("dedupe-".length) }
      : {}),
    status,
    attempts: job.attemptsMade,
    ...(lastError !== undefined ? { lastError } : {}),
    history,
    createdAt: new Date(job.timestamp),
    availableAt: new Date(job.timestamp + (job.opts.delay ?? 0)),
    ...(job.processedOn ? { startedAt: new Date(job.processedOn) } : {}),
    ...(status === "completed" && job.finishedOn ? { completedAt: new Date(job.finishedOn) } : {}),
    ...(status === "failed" && job.finishedOn ? { failedAt: new Date(job.finishedOn) } : {}),
    ...(status === "discarded"
      ? { discardedAt: discardedAt ?? new Date(), ...(discardReason ? { discardReason } : {}) }
      : {}),
  });
}

interface Semaphore {
  readonly size: number;
  acquire(): Promise<void>;
  release(): void;
}

function createSemaphore(size: number): Semaphore {
  let available = size;
  const waiters: (() => void)[] = [];
  return {
    size,
    acquire: () =>
      new Promise<void>((resolve) => {
        if (available > 0) {
          available -= 1;
          resolve();
          return;
        }
        waiters.push(resolve);
      }),
    release: () => {
      const next = waiters.shift();
      if (next) {
        next();
        return;
      }
      available += 1;
    },
  };
}

function assertOptions(options: unknown): asserts options is BullmqJobBackendOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Reflect.get(options, "connection") === undefined
  ) {
    throw new TypeError("createBullmqJobBackend requires a connection");
  }
  for (const field of ["maxQueueDepth", "maxInFlight"] as const) {
    const value = Reflect.get(options, field);
    if (value !== undefined && !(Number.isInteger(value) && (value as number) > 0)) {
      throw new TypeError(`${field} must be a positive integer`);
    }
  }
  const prefix = Reflect.get(options, "prefix");
  if (prefix !== undefined && (typeof prefix !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(prefix))) {
    throw new TypeError("prefix must be a simple identifier");
  }
}
