import { type ConnectionOptions, type JobsOptions, Queue, Worker } from "bullmq";
import { logger as defaultLogger } from "../../../observability/logger.js";
import { withSpan } from "../../../observability/tracing.js";
import { runWithRequestContext } from "../../context/RequestContext.js";
import { jobRegistry as defaultRegistry, type JobRegistry } from "./defineJob.js";

/**
 * `JobsManager` — wires BullMQ Queues + Workers to the framework's
 * declarative job registry.
 *
 * Producer side (always-on): one `Queue` per unique queue name. The
 * framework exposes `enqueue(queue, name, payload, opts?)` for application
 * code to push work.
 *
 * Worker side (opt-in via `WORKER_MODE`): one `Worker` per unique queue
 * name; the worker dispatches incoming jobs to the right handler by
 * `job.name`. Each handler invocation is wrapped in a fresh
 * `RequestContext` so logger / DrizzleEntityService lifecycle hooks see
 * a coherent context (with `requestId` set to the BullMQ job ID).
 *
 * `WORKER_MODE` selects role:
 *   - `api` (default in template; no workers spin up — only the producer)
 *   - `worker` (workers only — no HTTP server)
 *   - `all` (workers + HTTP — local dev default)
 *
 * On `quit()`: closes all queues + workers. Idempotent. Called from the
 * graceful-shutdown manager (which adds it to the SIGTERM hook chain).
 */

export type WorkerMode = "api" | "worker" | "all";

export interface JobsManagerOptions {
  /** ioredis-compatible connection options or a Redis URL. Required by BullMQ. */
  connection: ConnectionOptions;
  /** Mode for this process. Defaults to `process.env.WORKER_MODE` or "api". */
  mode?: WorkerMode;
  /** Override the framework-wide registry. */
  registry?: JobRegistry;
  /** Override the default logger. */
  logger?: typeof defaultLogger;
}

function resolveMode(explicit?: WorkerMode): WorkerMode {
  if (explicit) return explicit;
  const envMode = process.env.WORKER_MODE;
  if (envMode === "worker" || envMode === "all" || envMode === "api") return envMode;
  return "api";
}

export class JobsManager {
  private connection: ConnectionOptions;
  private mode: WorkerMode;
  private registry: JobRegistry;
  private logger: typeof defaultLogger;

  private queues = new Map<string, Queue>();
  private workers: Worker[] = [];
  private quitting = false;

  constructor(opts: JobsManagerOptions) {
    this.connection = opts.connection;
    this.mode = resolveMode(opts.mode);
    this.registry = opts.registry ?? defaultRegistry;
    this.logger = opts.logger ?? defaultLogger;
  }

  /** Lazily get / create the BullMQ Queue for a queue name. */
  getQueue(queueName: string): Queue {
    let q = this.queues.get(queueName);
    if (!q) {
      q = new Queue(queueName, { connection: this.connection });
      this.queues.set(queueName, q);
    }
    return q;
  }

  /** Push a job onto its queue. */
  async enqueue(
    queueName: string,
    jobName: string,
    payload: unknown,
    opts?: JobsOptions,
  ): Promise<void> {
    // Verify the job is registered — surface typos as boot-time errors
    // rather than silent dead-letter behavior.
    const def = this.registry.find(queueName, jobName);
    if (!def) {
      throw new Error(`enqueue(): no job "${jobName}" registered in queue "${queueName}"`);
    }
    const merged = { ...def.options?.defaultJobOptions, ...opts };
    await this.getQueue(queueName).add(jobName, payload, merged);
  }

  /**
   * Start workers for every distinct queue (when mode includes worker).
   * Idempotent — calling twice is a no-op. Returns the count of workers
   * started (0 in `api` mode).
   */
  async startWorkers(): Promise<number> {
    if (this.mode === "api") return 0;
    if (this.workers.length > 0) return this.workers.length;

    for (const queueName of this.registry.queues()) {
      const handlers = this.registry.byQueue(queueName);
      const concurrency = Math.max(...handlers.map((h) => h.options?.concurrency ?? 1));

      const worker = new Worker(
        queueName,
        async (job) => {
          const handler = this.registry.find(queueName, job.name);
          if (!handler) {
            this.logger.warn(
              { queue: queueName, jobName: job.name, jobId: job.id },
              "jobs.unknown_job",
            );
            throw new Error(`No handler for job "${job.name}" in queue "${queueName}"`);
          }

          return withSpan(
            `job.${queueName}.${job.name}`,
            async () => {
              return runWithRequestContext(
                { requestId: `job:${job.id ?? "unknown"}` },
                async () => {
                  return handler.handler(job.data, {
                    job,
                    context: { requestId: `job:${job.id ?? "unknown"}` },
                  });
                },
              );
            },
            { "job.queue": queueName, "job.name": job.name, "job.id": job.id ?? "" },
          );
        },
        { connection: this.connection, concurrency },
      );

      worker.on("failed", (job, err) => {
        this.logger.error(
          {
            queue: queueName,
            jobName: job?.name,
            jobId: job?.id,
            attemptsMade: job?.attemptsMade,
            err,
          },
          "jobs.failed",
        );
      });

      this.workers.push(worker);
    }

    // Register repeatable jobs
    for (const def of this.registry.list()) {
      if (def.options?.schedule) {
        await this.getQueue(def.queue).add(def.name, undefined, {
          repeat: { pattern: def.options.schedule.cron, tz: def.options.schedule.tz },
          ...def.options.defaultJobOptions,
        });
      }
    }

    return this.workers.length;
  }

  /** Graceful shutdown — drain workers, close queues. Idempotent. */
  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
    this.workers = [];
    this.queues.clear();
  }

  getMode(): WorkerMode {
    return this.mode;
  }

  /**
   * The set of queue names this manager knows about — sourced from the
   * registry (every distinct `queue:` field across `defineJob(...)`
   * declarations). Used by tooling that needs to enumerate queues
   * (Bull-Board admin UI, custom dashboards, debugging endpoints).
   */
  getQueueNames(): string[] {
    return this.registry.queues();
  }
}
