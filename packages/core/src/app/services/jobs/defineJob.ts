import type { Job, JobsOptions } from "bullmq";
import type { LifecycleHookContext } from "../../services/hooks/LifecycleHooks.js";

/**
 * `defineJob({ queue, name, handler, options?, schedule? })` — declarative
 * background-job definition that auto-registers into the framework
 * `jobRegistry`.
 *
 * Replaces v3's ad-hoc job patterns. Each job lives in
 * `modules/<name>/jobs/<jobName>.job.ts` (convention) and default-exports
 * its definition. The framework's eventual InitJobs bootstrapper walks
 * the module tree, registers every defined job, and starts BullMQ workers
 * for each unique queue when `WORKER_MODE` includes worker.
 *
 * Type safety: the optional generic `TPayload` flows from `defineJob`
 * through `enqueue(queue, name, payload)` to the handler — agents and
 * humans alike get IDE feedback on payload shape.
 *
 * Schedule: `schedule: { cron: '0 * * * *' }` registers a BullMQ
 * repeatable job at workers-startup time. The framework `defineCron(...)`
 * helper (next batch) is a thin wrapper over this with cron-specific
 * ergonomics.
 */

export interface JobHandlerContext {
  /** The underlying BullMQ Job for advanced needs (logger, progress, etc.). */
  job: Job;
  /** Per-run framework context; mirrors the HTTP RequestContext shape so
   *  lifecycle hooks behave the same in jobs as in requests. */
  context: LifecycleHookContext;
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  payload: TPayload,
  ctx: JobHandlerContext,
) => Promise<TResult> | TResult;

export interface JobDefinitionOptions {
  /** BullMQ JobsOptions (attempts, backoff, priority, etc.) applied at enqueue time. */
  defaultJobOptions?: JobsOptions;
  /**
   * Repeatable schedule (cron expression). When set, the framework
   * registers a BullMQ repeatable job alongside the handler at worker
   * startup. Use `defineCron(...)` for the more ergonomic shortcut.
   */
  schedule?: { cron: string; tz?: string };
  /** Worker-side concurrency for this queue. Default 1. */
  concurrency?: number;
}

export interface JobDefinition<TPayload = unknown, TResult = unknown> {
  /** Queue name. Multiple jobs can share a queue; the worker dispatches by `name`. */
  readonly queue: string;
  /** Job name within the queue. Unique per-queue. */
  readonly name: string;
  readonly handler: JobHandler<TPayload, TResult>;
  readonly options?: JobDefinitionOptions;
}

/**
 * Define a job. Auto-registers into the framework `jobRegistry` (via
 * the `register` argument's default). For tests / standalone usage, pass
 * a custom registry to keep state isolated.
 */
export function defineJob<TPayload = unknown, TResult = unknown>(
  def: JobDefinition<TPayload, TResult>,
  register: { add: (def: JobDefinition) => void } | false = jobRegistry,
): JobDefinition<TPayload, TResult> {
  if (register !== false) {
    register.add(def as unknown as JobDefinition);
  }
  return def;
}

/**
 * In-memory registry of every `defineJob`-declared definition. Populated
 * at module-load time when the framework imports the module's job files;
 * read at worker startup to wire BullMQ Workers.
 */
export class JobRegistry {
  private jobs: JobDefinition[] = [];

  add(def: JobDefinition): void {
    const dup = this.jobs.find((j) => j.queue === def.queue && j.name === def.name);
    if (dup) {
      throw new Error(`JobRegistry: duplicate job "${def.name}" in queue "${def.queue}"`);
    }
    this.jobs.push(def);
  }

  list(): readonly JobDefinition[] {
    return [...this.jobs];
  }

  /** All job definitions for one queue. */
  byQueue(queue: string): JobDefinition[] {
    return this.jobs.filter((j) => j.queue === queue);
  }

  /** Distinct queue names across all registered jobs. */
  queues(): string[] {
    return [...new Set(this.jobs.map((j) => j.queue))];
  }

  find(queue: string, name: string): JobDefinition | undefined {
    return this.jobs.find((j) => j.queue === queue && j.name === name);
  }

  size(): number {
    return this.jobs.length;
  }

  clear(): void {
    this.jobs = [];
  }
}

/** Framework-wide registry. */
export const jobRegistry = new JobRegistry();
