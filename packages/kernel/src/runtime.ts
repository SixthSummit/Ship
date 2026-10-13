import { systemActor } from "./actor.js";
import type { CompiledApplication } from "./application.js";
import { createExecutor } from "./executor.js";
import type {
  AnyJob,
  JobBackend,
  JobConcurrencyBudget,
  JobExecutionOutcome,
  JobRuntimeDeclaration,
  JobWorkerMode,
} from "./job.js";
import { isJob, isJobBackend, JOB_INPUT_LOCATION } from "./job.js";
import type { AnyModule } from "./module.js";

const ACTOR_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

export interface JobRuntimeOptions {
  readonly backend: JobBackend;
  /** Overrides `defineApp({ runtime: { workers: { mode } } })`; defaults to `api`. */
  readonly mode?: JobWorkerMode;
  readonly budget?: Partial<JobConcurrencyBudget>;
  /** Id of the system actor every run executes as. Defaults to `ship.jobs.<adapter>`. */
  readonly actorId?: string;
  /** Injectable clock for liveness timestamps; defaults to `new Date()`. */
  readonly clock?: () => Date;
}

/**
 * What this process has observed of one job: the runs it executed and when
 * they last finished. It is process-local by design — the worker that runs a
 * job is the one that answers for its liveness — so an HTTP health surface in
 * that process can project it without a hand-written heartbeat store.
 */
export interface JobLivenessEntry {
  readonly jobId: string;
  /** When a run last began in this process. */
  readonly lastStartedAt?: Date;
  /** When a run last completed successfully in this process. */
  readonly lastCompletedAt?: Date;
  /** When a run last ended in failure (including lock contention) in this process. */
  readonly lastFailedAt?: Date;
  readonly completed: number;
  readonly failed: number;
  /**
   * Milliseconds since the last successful completion, measured from the
   * moment the runtime started when nothing has completed yet. A liveness
   * gate compares it with the interval the job is expected to keep.
   */
  readonly lagMs: number;
}

export interface JobLiveness {
  /** When this runtime attached to its backend. */
  readonly startedAt: Date;
  readonly jobs: readonly JobLivenessEntry[];
}

export interface JobRuntime {
  readonly kind: "ship.job-runtime";
  readonly mode: JobWorkerMode;
  /** Number of workers the backend started for this process. */
  readonly workers: number;
  /** Job ids whose schedule or interval was reconciled at boot. */
  readonly scheduled: readonly string[];
  readonly jobs: readonly JobRuntimeDeclaration[];
  /** Per-job completion and failure times observed by this process, sorted by job id. */
  liveness(now?: Date): JobLiveness;
  /** Stops taking runs, drains in-flight work and closes the backend. */
  stop(): Promise<void>;
}

export type JobRuntimeErrorCode =
  | "SHIP_JOB_RUNTIME_BACKEND_INVALID"
  | "SHIP_JOB_RUNTIME_MODE_INVALID"
  | "SHIP_JOB_RUNTIME_ACTOR_INVALID";

export class JobRuntimeError extends Error {
  readonly code: JobRuntimeErrorCode;

  constructor(code: JobRuntimeErrorCode, message: string) {
    super(message);
    this.name = "JobRuntimeError";
    this.code = code;
  }
}

/** Every job declared in the compiled application, sorted by id. */
export function collectJobs(
  application: CompiledApplication<string, readonly AnyModule[]>,
): readonly AnyJob[] {
  const jobs: AnyJob[] = [];
  for (const module of application.modules) {
    for (const operation of module.operations) {
      if (isJob(operation)) jobs.push(operation);
    }
  }
  return Object.freeze(jobs.sort((left, right) => left.id.localeCompare(right.id)));
}

/**
 * Binds a job backend to a compiled application: every run is executed through
 * the ordinary executor as a `system` actor with no permissions, schedules are
 * reconciled (replace, never duplicate) and workers start according to the
 * process mode. `api` processes enqueue and observe only.
 */
export async function startJobRuntime(
  application: CompiledApplication<string, readonly AnyModule[]>,
  options: JobRuntimeOptions,
): Promise<JobRuntime> {
  const backend = options.backend;
  if (!isJobBackend(backend)) {
    throw new JobRuntimeError(
      "SHIP_JOB_RUNTIME_BACKEND_INVALID",
      "startJobRuntime requires a JobBackend created by an adapter package",
    );
  }
  const mode = options.mode ?? application.runtime.workers?.mode ?? "api";
  if (mode !== "api" && mode !== "worker" && mode !== "all") {
    throw new JobRuntimeError(
      "SHIP_JOB_RUNTIME_MODE_INVALID",
      `job runtime mode must be api, worker, or all; received ${JSON.stringify(mode)}`,
    );
  }
  const actorId = options.actorId ?? `ship.jobs.${backend.adapter}`;
  if (!ACTOR_ID_PATTERN.test(actorId)) {
    throw new JobRuntimeError(
      "SHIP_JOB_RUNTIME_ACTOR_INVALID",
      `job runtime actor id must be a lowercase dot-separated identifier; received ${JSON.stringify(actorId)}`,
    );
  }
  const executor = createExecutor(application);
  const jobs = collectJobs(application);
  const declarations = Object.freeze(jobs.map((job) => job.job));
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock();
  const observed = new Map<string, MutableLiveness>(
    jobs.map((job) => [job.id, { completed: 0, failed: 0 }]),
  );
  const record = (jobId: string, outcome: JobExecutionOutcome): JobExecutionOutcome => {
    const entry = observed.get(jobId);
    if (entry) {
      if (outcome.ok) {
        entry.lastCompletedAt = clock();
        entry.completed += 1;
      } else {
        entry.lastFailedAt = clock();
        entry.failed += 1;
      }
    }
    return outcome;
  };

  await backend.attach({
    jobs: declarations,
    execute: async (jobId, input, run): Promise<JobExecutionOutcome> => {
      const entry = observed.get(jobId);
      if (entry) entry.lastStartedAt = clock();
      let result: Awaited<ReturnType<typeof executor.run>>;
      try {
        result = await executor.run(jobId as never, { [JOB_INPUT_LOCATION]: input } as never, {
          actor: systemActor({ id: actorId }),
          requestId: run.runId,
        });
      } catch (error) {
        return record(jobId, { ok: false, retryable: true, error: describeError(error) });
      }
      if (result.ok) return record(jobId, { ok: true, data: result.data });
      if (result.error.code === "JOB_LOCK_HELD") {
        return record(jobId, {
          ok: false,
          retryable: true,
          lockHeld: true,
          error: result.error.message,
        });
      }
      return record(jobId, {
        ok: false,
        retryable: false,
        error: `${result.error.code}: ${result.error.message}`,
      });
    },
  });

  const budget = {
    ...(application.runtime.workers?.budget !== undefined
      ? { maxInFlight: application.runtime.workers.budget }
      : {}),
    ...options.budget,
  };
  const scheduled: string[] = [];
  if (mode !== "api") {
    for (const job of jobs) {
      const trigger = job.job.trigger;
      if (trigger.kind !== "schedule" && trigger.kind !== "interval") continue;
      await backend.schedule(job.id, trigger);
      scheduled.push(job.id);
    }
  }
  const workers = await backend.startWorkers(mode, budget);

  return Object.freeze({
    kind: "ship.job-runtime" as const,
    mode,
    workers,
    scheduled: Object.freeze(scheduled),
    jobs: declarations,
    liveness: (now: Date = clock()): JobLiveness =>
      Object.freeze({
        startedAt,
        jobs: Object.freeze(
          [...observed]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([jobId, entry]) =>
              Object.freeze({
                jobId,
                ...(entry.lastStartedAt ? { lastStartedAt: entry.lastStartedAt } : {}),
                ...(entry.lastCompletedAt ? { lastCompletedAt: entry.lastCompletedAt } : {}),
                ...(entry.lastFailedAt ? { lastFailedAt: entry.lastFailedAt } : {}),
                completed: entry.completed,
                failed: entry.failed,
                lagMs: Math.max(0, now.getTime() - (entry.lastCompletedAt ?? startedAt).getTime()),
              }),
            ),
        ),
      }),
    stop: () => backend.quit(),
  });
}

interface MutableLiveness {
  lastStartedAt?: Date;
  lastCompletedAt?: Date;
  lastFailedAt?: Date;
  completed: number;
  failed: number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return typeof error === "string" ? error : "job run failed";
}
