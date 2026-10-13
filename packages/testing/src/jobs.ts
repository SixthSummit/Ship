import type {
  AnyModule,
  ApplicationExecutor,
  CompiledApplication,
  JobAttemptFailure,
  JobBackend,
  JobCleanupResult,
  JobConcurrencyBudget,
  JobEnqueueOptions,
  JobEnqueueResult,
  JobHealth,
  JobHealthEntry,
  JobIntervalTrigger,
  JobRun,
  JobRunStatus,
  JobRuntimeBinding,
  JobRuntimeDeclaration,
  JobScheduleTrigger,
  JobWorkerMode,
  LockLease,
  LockProvider,
  OperationActor,
  OperationExecutionResult,
  OperationId,
} from "@sixthsummit/ship-core";
import {
  backoffDelay,
  createExecutor,
  DEFAULT_JOB_RETENTION,
  JOB_INPUT_LOCATION,
  systemActor,
} from "@sixthsummit/ship-core";

// ---------------------------------------------------------------------------
// In-memory lock provider
// ---------------------------------------------------------------------------

export interface InMemoryLockProvider extends LockProvider {
  readonly adapter: "memory";
  /** Currently held leases, keyed by `jobId:key`. */
  readonly leases: () => ReadonlyMap<string, LockLease>;
  readonly reset: () => void;
}

/** Deterministic process-local lock provider for unit tests. */
export function createInMemoryLockProvider(
  clock: () => Date = () => new Date(),
): InMemoryLockProvider {
  const leases = new Map<string, LockLease>();
  let sequence = 0;
  const id = (jobId: string, key: string) => `${jobId}:${key}`;
  const live = (lease: LockLease | undefined): lease is LockLease =>
    lease !== undefined && lease.expiresAt.getTime() > clock().getTime();

  return Object.freeze({
    kind: "ship.lock-provider" as const,
    adapter: "memory" as const,
    acquire: async (jobId: string, key: string, ttlMs: number) => {
      const existing = leases.get(id(jobId, key));
      if (live(existing)) return undefined;
      sequence += 1;
      const lease = Object.freeze({
        jobId,
        key,
        token: `lease-${sequence}`,
        expiresAt: new Date(clock().getTime() + ttlMs),
      });
      leases.set(id(jobId, key), lease);
      return lease;
    },
    release: async (lease: LockLease) => {
      const existing = leases.get(id(lease.jobId, lease.key));
      if (existing?.token === lease.token) leases.delete(id(lease.jobId, lease.key));
    },
    extend: async (lease: LockLease, ttlMs: number) => {
      const existing = leases.get(id(lease.jobId, lease.key));
      if (existing?.token !== lease.token || !live(existing)) return false;
      leases.set(
        id(lease.jobId, lease.key),
        Object.freeze({ ...existing, expiresAt: new Date(clock().getTime() + ttlMs) }),
      );
      return true;
    },
    leases: () => new Map(leases),
    reset: () => leases.clear(),
  });
}

// ---------------------------------------------------------------------------
// In-memory job backend
// ---------------------------------------------------------------------------

export interface InMemoryJobBackendOptions {
  /** Runs waiting or delayed per job before `enqueue` returns `queue-full`. Defaults to 100. */
  readonly maxQueueDepth?: number;
  /** Process-wide in-flight cap. Defaults to 4. */
  readonly maxInFlight?: number;
  readonly clock?: () => Date;
  /** Worker polling interval once `startWorkers` runs in a worker mode. Defaults to 5 ms. */
  readonly pollMs?: number;
}

export interface InMemoryJobSchedule {
  readonly jobId: string;
  readonly trigger: JobScheduleTrigger | JobIntervalTrigger;
  readonly nextAt: Date;
}

export interface InMemoryDrainResult {
  readonly executed: number;
  readonly completed: number;
  readonly failed: number;
}

export interface InMemoryJobBackend extends JobBackend {
  readonly adapter: "memory";
  /** Snapshot of every run, oldest first. */
  readonly runs: () => readonly JobRun[];
  readonly schedules: () => readonly InMemoryJobSchedule[];
  /** Enqueues every scheduled run due at `now`; returns how many were enqueued. */
  readonly tick: (now?: Date) => Promise<number>;
  /** Ticks schedules, then processes runnable runs until nothing is runnable. */
  readonly drain: (options?: { readonly maxRuns?: number }) => Promise<InMemoryDrainResult>;
  readonly reset: () => void;
}

interface MutableRun {
  runId: string;
  jobId: string;
  input: unknown;
  key?: string;
  dedupeKey?: string;
  status: JobRunStatus;
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
}

const TERMINAL: ReadonlySet<JobRunStatus> = new Set(["completed", "failed", "discarded"]);

/**
 * Deterministic in-memory job backend for unit tests and the conformance suite.
 * It implements the same claim, per-key fairness, retry, dead-letter,
 * schedule reconciliation and retention semantics adapters are expected to,
 * without any external service.
 */
export function createInMemoryJobBackend(
  options: InMemoryJobBackendOptions = {},
): InMemoryJobBackend {
  const clock = options.clock ?? (() => new Date());
  const budget: JobConcurrencyBudget = Object.freeze({
    maxInFlight: options.maxInFlight ?? 4,
    maxQueueDepth: options.maxQueueDepth ?? 100,
  });
  const pollMs = options.pollMs ?? 5;
  let runs: MutableRun[] = [];
  let sequence = 0;
  let binding: JobRuntimeBinding | undefined;
  let quitting = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let workerBudget = budget;
  const schedules = new Map<
    string,
    { trigger: JobScheduleTrigger | JobIntervalTrigger; nextAt: Date }
  >();
  const cursors = new Map<string, string>();
  const inFlight = new Set<Promise<void>>();
  const lastRunAt = new Map<string, Date>();
  const lastSuccessAt = new Map<string, Date>();

  const declaration = (jobId: string): JobRuntimeDeclaration => {
    const found = binding?.jobs.find((job) => job.id === jobId);
    if (!found) throw new Error(`in-memory job backend knows no job ${JSON.stringify(jobId)}`);
    return found;
  };

  const enqueue = async (
    jobId: string,
    input: unknown,
    enqueueOptions: JobEnqueueOptions = {},
  ): Promise<JobEnqueueResult> => {
    const job = declaration(jobId);
    if (
      enqueueOptions.dedupeKey !== undefined &&
      runs.some(
        (run) =>
          run.jobId === jobId &&
          run.dedupeKey === enqueueOptions.dedupeKey &&
          !TERMINAL.has(run.status),
      )
    ) {
      const existing = runs.find(
        (run) =>
          run.jobId === jobId &&
          run.dedupeKey === enqueueOptions.dedupeKey &&
          !TERMINAL.has(run.status),
      ) as MutableRun;
      return Object.freeze({ accepted: true as const, runId: existing.runId, deduplicated: true });
    }
    const queued = runs.filter(
      (run) => run.jobId === jobId && (run.status === "waiting" || run.status === "delayed"),
    ).length;
    if (queued >= budget.maxQueueDepth) {
      return Object.freeze({ accepted: false as const, rejected: "queue-full" as const });
    }
    sequence += 1;
    const now = clock();
    const delayMs = enqueueOptions.delayMs ?? 0;
    const run: MutableRun = {
      runId: `${jobId}:${sequence}`,
      jobId,
      input,
      ...(job.key ? { key: job.key(input) } : {}),
      ...(enqueueOptions.dedupeKey !== undefined ? { dedupeKey: enqueueOptions.dedupeKey } : {}),
      status: delayMs > 0 ? "delayed" : "waiting",
      attempts: 0,
      history: [],
      createdAt: now,
      availableAt: new Date(now.getTime() + delayMs),
    };
    runs.push(run);
    return Object.freeze({ accepted: true as const, runId: run.runId, deduplicated: false });
  };

  const schedule = async (jobId: string, trigger: JobScheduleTrigger | JobIntervalTrigger) => {
    declaration(jobId);
    schedules.set(jobId, { trigger, nextAt: nextOccurrence(trigger, clock()) });
  };

  const tick = async (now = clock()): Promise<number> => {
    let enqueued = 0;
    for (const [jobId, entry] of [...schedules].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      let nextAt = entry.nextAt;
      while (nextAt.getTime() <= now.getTime()) {
        const runId = `${jobId}:${nextAt.toISOString()}`;
        if (!runs.some((run) => run.runId === runId)) {
          runs.push({
            runId,
            jobId,
            input: {},
            status: "waiting",
            attempts: 0,
            history: [],
            createdAt: nextAt,
            availableAt: nextAt,
          });
          enqueued += 1;
        }
        nextAt = nextOccurrence(entry.trigger, nextAt);
      }
      schedules.set(jobId, { trigger: entry.trigger, nextAt });
    }
    return enqueued;
  };

  const claimable = (now: Date): MutableRun | undefined => {
    if (!binding) return undefined;
    if (inFlight.size >= workerBudget.maxInFlight) return undefined;
    for (const run of runs) {
      if (run.status === "delayed" && run.availableAt.getTime() <= now.getTime()) {
        run.status = "waiting";
      }
    }
    const jobIds = [
      ...new Set(runs.filter((run) => run.status === "waiting").map((run) => run.jobId)),
    ].sort();
    for (const jobId of jobIds) {
      const job = declaration(jobId);
      const active = runs.filter((run) => run.jobId === jobId && run.status === "active");
      if (active.length >= job.concurrency.max) continue;
      const waiting = runs.filter(
        (run) =>
          run.jobId === jobId &&
          run.status === "waiting" &&
          run.availableAt.getTime() <= now.getTime(),
      );
      if (waiting.length === 0) continue;
      // Round-robin: continue from the key after the one claimed last time.
      const keys = [...new Set(waiting.map((run) => run.key ?? ""))].sort();
      const last = cursors.get(jobId);
      const start = last === undefined ? 0 : keys.findIndex((key) => key > last);
      const offset = start < 0 ? 0 : start;
      for (let step = 0; step < keys.length; step += 1) {
        const key = keys[(offset + step) % keys.length] as string;
        if (
          job.concurrency.mode === "single-runner" &&
          active.some((run) => (run.key ?? "") === key)
        ) {
          continue;
        }
        const candidate = waiting.find((run) => (run.key ?? "") === key);
        if (!candidate) continue;
        cursors.set(jobId, key);
        return candidate;
      }
    }
    return undefined;
  };

  const execute = async (run: MutableRun): Promise<"completed" | "failed" | "retried"> => {
    const job = declaration(run.jobId);
    const bound = binding as JobRuntimeBinding;
    run.status = "active";
    run.attempts += 1;
    run.startedAt = clock();
    lastRunAt.set(run.jobId, run.startedAt);
    const outcome = await bound.execute(run.jobId, run.input, {
      runId: run.runId,
      attempt: run.attempts,
      ...(run.key !== undefined ? { key: run.key } : {}),
    });
    const now = clock();
    if (outcome.ok) {
      run.status = "completed";
      run.completedAt = now;
      lastSuccessAt.set(run.jobId, now);
      return "completed";
    }
    if (outcome.lockHeld) {
      // Contention is not a failed attempt; wait one backoff step and try again.
      run.attempts -= 1;
      run.status = "delayed";
      run.availableAt = new Date(now.getTime() + backoffDelay(job.retry.backoff, 1));
      return "retried";
    }
    run.history.push({ attempt: run.attempts, error: outcome.error, at: now });
    run.lastError = outcome.error;
    if (!outcome.retryable || run.attempts >= job.retry.attempts) {
      run.status = "failed";
      run.failedAt = now;
      return "failed";
    }
    run.status = "delayed";
    run.availableAt = new Date(now.getTime() + backoffDelay(job.retry.backoff, run.attempts));
    return "retried";
  };

  const processOnce = async (): Promise<boolean> => {
    const run = claimable(clock());
    if (!run) return false;
    const pending = execute(run).then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(pending);
    await pending;
    inFlight.delete(pending);
    return true;
  };

  const drain = async (
    drainOptions: { readonly maxRuns?: number } = {},
  ): Promise<InMemoryDrainResult> => {
    const maxRuns = drainOptions.maxRuns ?? 1_000;
    let executed = 0;
    let completed = 0;
    let failed = 0;
    await tick();
    while (true) {
      const run = claimable(clock());
      if (!run) return Object.freeze({ executed, completed, failed });
      if (executed >= maxRuns) {
        throw new Error(`in-memory job backend still had runnable runs after ${maxRuns} runs`);
      }
      const result = await execute(run);
      executed += 1;
      if (result === "completed") completed += 1;
      if (result === "failed") failed += 1;
    }
  };

  const startWorkers = async (
    mode: JobWorkerMode,
    override: Partial<JobConcurrencyBudget> = {},
  ) => {
    workerBudget = Object.freeze({ ...budget, ...override });
    if (mode === "api" || timer !== undefined) return timer === undefined ? 0 : 1;
    quitting = false;
    timer = setInterval(() => {
      if (quitting) return;
      void tick().then(async () => {
        while (!quitting && (await processOnce())) {
          // keep claiming until nothing is runnable
        }
      });
    }, pollMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
    return 1;
  };

  const quit = async () => {
    quitting = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    await Promise.all([...inFlight]);
  };

  const health = async (now: Date): Promise<JobHealth> => {
    for (const run of runs) {
      if (run.status === "delayed" && run.availableAt.getTime() <= now.getTime()) {
        run.status = "waiting";
      }
    }
    const jobIds = [
      ...new Set([...(binding?.jobs ?? []).map((job) => job.id), ...runs.map((run) => run.jobId)]),
    ].sort();
    const entries: JobHealthEntry[] = jobIds.map((jobId) => {
      const own = runs.filter((run) => run.jobId === jobId);
      const waiting = own.filter((run) => run.status === "waiting");
      const oldest = waiting.reduce<Date | undefined>(
        (best, run) => (best === undefined || run.availableAt < best ? run.availableAt : best),
        undefined,
      );
      const lastRun = lastRunAt.get(jobId);
      const lastSuccess = lastSuccessAt.get(jobId);
      return Object.freeze({
        jobId,
        waiting: waiting.length,
        active: own.filter((run) => run.status === "active").length,
        delayed: own.filter((run) => run.status === "delayed").length,
        failed: own.filter((run) => run.status === "failed").length,
        lagMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : 0,
        ...(lastRun ? { lastRunAt: lastRun } : {}),
        ...(lastSuccess ? { lastSuccessAt: lastSuccess } : {}),
      });
    });
    return Object.freeze({ jobs: Object.freeze(entries) });
  };

  const listFailed = async ({ limit }: { readonly limit: number }) =>
    Object.freeze(
      runs
        .filter((run) => run.status === "failed")
        .sort((left, right) => (left.failedAt?.getTime() ?? 0) - (right.failedAt?.getTime() ?? 0))
        .slice(0, limit)
        .map(snapshot),
    );

  const retry = async (runId: string) => {
    const run = runs.find((item) => item.runId === runId);
    if (!run || run.status !== "failed") return undefined;
    run.status = "waiting";
    run.availableAt = clock();
    run.failedAt = undefined;
    return snapshot(run);
  };

  const discard = async (runId: string, reason: string) => {
    const run = runs.find((item) => item.runId === runId);
    if (!run || run.status !== "failed") return undefined;
    run.status = "discarded";
    run.discardedAt = clock();
    run.discardReason = reason;
    return snapshot(run);
  };

  const cleanup = async (now: Date): Promise<JobCleanupResult> => {
    let completedDeleted = 0;
    let deadLetteredDeleted = 0;
    runs = runs.filter((run) => {
      const retention =
        binding?.jobs.find((job) => job.id === run.jobId)?.retention ?? DEFAULT_JOB_RETENTION;
      if (
        run.status === "completed" &&
        run.completedAt &&
        now.getTime() - run.completedAt.getTime() >= retention.completedMs
      ) {
        completedDeleted += 1;
        return false;
      }
      const terminalAt = run.status === "failed" ? run.failedAt : run.discardedAt;
      if (
        (run.status === "failed" || run.status === "discarded") &&
        terminalAt &&
        now.getTime() - terminalAt.getTime() >= retention.deadLetteredMs
      ) {
        deadLetteredDeleted += 1;
        return false;
      }
      return true;
    });
    return Object.freeze({ completedDeleted, deadLetteredDeleted });
  };

  return Object.freeze({
    kind: "ship.job-backend" as const,
    adapter: "memory" as const,
    concurrencyBudget: budget,
    attach: (value: JobRuntimeBinding) => {
      binding = value;
    },
    enqueue,
    schedule,
    unschedule: async (jobId: string) => {
      schedules.delete(jobId);
    },
    startWorkers,
    quit,
    health,
    listFailed,
    retry,
    discard,
    cleanup,
    runs: () => Object.freeze(runs.map(snapshot)),
    schedules: () =>
      Object.freeze(
        [...schedules]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([jobId, entry]) =>
            Object.freeze({ jobId, trigger: entry.trigger, nextAt: entry.nextAt }),
          ),
      ),
    tick,
    drain,
    reset: () => {
      runs = [];
      sequence = 0;
      schedules.clear();
      cursors.clear();
      lastRunAt.clear();
      lastSuccessAt.clear();
    },
  });
}

function snapshot(run: MutableRun): JobRun {
  return Object.freeze({
    runId: run.runId,
    jobId: run.jobId,
    input: run.input,
    ...(run.key !== undefined ? { key: run.key } : {}),
    ...(run.dedupeKey !== undefined ? { dedupeKey: run.dedupeKey } : {}),
    status: run.status,
    attempts: run.attempts,
    ...(run.lastError !== undefined ? { lastError: run.lastError } : {}),
    history: Object.freeze(run.history.map((item) => Object.freeze({ ...item }))),
    createdAt: run.createdAt,
    availableAt: run.availableAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.failedAt ? { failedAt: run.failedAt } : {}),
    ...(run.discardedAt ? { discardedAt: run.discardedAt } : {}),
    ...(run.discardReason !== undefined ? { discardReason: run.discardReason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** The first occurrence strictly after `from` for an interval or cron trigger. */
export function nextOccurrence(trigger: JobScheduleTrigger | JobIntervalTrigger, from: Date): Date {
  if (trigger.kind === "interval") return new Date(from.getTime() + trigger.everyMs);
  const fields = parseCron(trigger.cron);
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const limit = start + 366 * 24 * 60 * 60_000;
  let candidate = start;
  while (candidate < limit) {
    const parts = localParts(new Date(candidate), trigger.tz);
    const toNextHour = (60 - parts.minute) * 60_000;
    if (
      !fields.dayOfMonth.has(parts.day) ||
      !fields.month.has(parts.month) ||
      !fields.dayOfWeek.has(parts.weekday)
    ) {
      candidate += toNextHour;
    } else if (!fields.hour.has(parts.hour)) {
      candidate += toNextHour;
    } else if (!fields.minute.has(parts.minute)) {
      candidate += 60_000;
    } else {
      return new Date(candidate);
    }
  }
  throw new Error(
    `cron expression ${JSON.stringify(trigger.cron)} has no occurrence within a year`,
  );
}

interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/u);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.length === 6 ? parts.slice(1) : parts;
  return {
    minute: parseField(minute as string, 0, 59),
    hour: parseField(hour as string, 0, 23),
    dayOfMonth: parseField(dayOfMonth as string, 1, 31),
    month: parseField(month as string, 1, 12),
    dayOfWeek: new Set([...parseField(dayOfWeek as string, 0, 7)].map((day) => day % 7)),
  };
}

function parseField(field: string, minimum: number, maximum: number): ReadonlySet<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let low = minimum;
    let high = maximum;
    if (range !== "*") {
      const [lowText, highText] = (range as string).split("-");
      low = Number(lowText);
      high = highText === undefined ? (stepText === undefined ? low : maximum) : Number(highText);
    }
    if (!Number.isInteger(low) || !Number.isInteger(high) || !Number.isInteger(step) || step <= 0) {
      throw new Error(`unsupported cron field ${JSON.stringify(field)}`);
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(
  date: Date,
  tz: string,
): { minute: number; hour: number; day: number; month: number; weekday: number } {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
    });
    formatters.set(tz, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday as string),
  };
}

// ---------------------------------------------------------------------------
// runJobOnce
// ---------------------------------------------------------------------------

export interface RunJobOnceOptions {
  /** Defaults to a permissionless system actor named `ship.testing.jobs`. */
  readonly actor?: OperationActor;
  readonly requestId?: string;
  /** Reuse an executor so singleton providers persist across runs. */
  readonly executor?: ApplicationExecutor<CompiledApplication<string, readonly AnyModule[]>>;
}

/**
 * Runs one job through the executor exactly as a backend would, as a system
 * actor with no permissions, and returns the executor result. Single-runner
 * jobs still take their lease, so an application must bind a lock provider.
 */
export async function runJobOnce<
  TApp extends CompiledApplication<string, readonly AnyModule[]>,
  TId extends OperationId<TApp>,
>(
  app: TApp,
  jobId: TId,
  input: unknown,
  options: RunJobOnceOptions = {},
): Promise<OperationExecutionResult<TApp["operationById"][TId]>> {
  const executor = options.executor ?? createExecutor(app);
  const actor = options.actor ?? systemActor({ id: "ship.testing.jobs" });
  return (await executor.run(jobId as never, { [JOB_INPUT_LOCATION]: input } as never, {
    actor,
    ...(options.requestId ? { requestId: options.requestId } : {}),
  })) as OperationExecutionResult<TApp["operationById"][TId]>;
}
