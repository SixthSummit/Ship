import type { JobLiveness, JobLivenessEntry, JobRuntime } from "@sixthsummit/ship-core";
import { Hono } from "hono";

const PATH_PATTERN = /^\/[A-Za-z0-9._~\-/]*$/u;
const DEFAULT_PATH = "/health/jobs";

export type JobLivenessRouteDiagnosticCode = "SHIP_HONO_JOB_LIVENESS_OPTIONS_INVALID";

export class JobLivenessRouteError extends Error {
  readonly code: JobLivenessRouteDiagnosticCode;

  constructor(code: JobLivenessRouteDiagnosticCode, message: string) {
    super(message);
    this.name = "JobLivenessRouteError";
    this.code = code;
  }
}

export interface JobLivenessRouteOptions {
  /** The runtime started with `startJobRuntime` in this process. */
  readonly runtime: Pick<JobRuntime, "liveness">;
  /** Path the route answers on. Defaults to `/health/jobs`. */
  readonly path?: string;
  /**
   * A job whose `lagMs` exceeds this bound marks the process unhealthy (503).
   * One number applies to every job; a record applies per job id and leaves
   * unlisted jobs ungated. Omitted, the route reports and never fails.
   */
  readonly staleAfterMs?: number | Readonly<Record<string, number>>;
  readonly clock?: () => Date;
}

export interface JobLivenessResponseEntry {
  readonly jobId: string;
  readonly lastStartedAt?: string;
  readonly lastCompletedAt?: string;
  readonly lastFailedAt?: string;
  readonly completed: number;
  readonly failed: number;
  readonly lagMs: number;
  /** True when `lagMs` exceeds the bound declared for this job. */
  readonly stale: boolean;
}

export interface JobLivenessResponse {
  readonly ok: boolean;
  readonly startedAt: string;
  readonly jobs: readonly JobLivenessResponseEntry[];
}

/**
 * Projects a job runtime's liveness onto an HTTP health route so a worker
 * process answers "have my jobs completed recently?" without a hand-written
 * heartbeat store. The body lists every job with its last start, completion
 * and failure and the lag since its last success; the status is `503` as soon
 * as one gated job is stale, and the response is never cacheable.
 */
export function jobLivenessRoute(options: JobLivenessRouteOptions): Hono {
  assertOptions(options);
  const path = options.path ?? DEFAULT_PATH;
  const clock = options.clock ?? (() => new Date());
  const app = new Hono();
  app.get(path, (context) => {
    const body = projectJobLiveness(options.runtime.liveness(clock()), options.staleAfterMs);
    return context.json(body, body.ok ? 200 : 503, { "cache-control": "no-store" });
  });
  return app;
}

/** The pure projection the route serves, exposed for other health surfaces. */
export function projectJobLiveness(
  liveness: JobLiveness,
  staleAfterMs?: number | Readonly<Record<string, number>>,
): JobLivenessResponse {
  const jobs = liveness.jobs.map((entry) =>
    projectEntry(entry, boundFor(entry.jobId, staleAfterMs)),
  );
  return Object.freeze({
    ok: jobs.every((entry) => !entry.stale),
    startedAt: liveness.startedAt.toISOString(),
    jobs: Object.freeze(jobs),
  });
}

function projectEntry(
  entry: JobLivenessEntry,
  bound: number | undefined,
): JobLivenessResponseEntry {
  return Object.freeze({
    jobId: entry.jobId,
    ...(entry.lastStartedAt ? { lastStartedAt: entry.lastStartedAt.toISOString() } : {}),
    ...(entry.lastCompletedAt ? { lastCompletedAt: entry.lastCompletedAt.toISOString() } : {}),
    ...(entry.lastFailedAt ? { lastFailedAt: entry.lastFailedAt.toISOString() } : {}),
    completed: entry.completed,
    failed: entry.failed,
    lagMs: entry.lagMs,
    stale: bound !== undefined && entry.lagMs > bound,
  });
}

function boundFor(
  jobId: string,
  staleAfterMs: number | Readonly<Record<string, number>> | undefined,
): number | undefined {
  if (staleAfterMs === undefined) return undefined;
  if (typeof staleAfterMs === "number") return staleAfterMs;
  return Object.hasOwn(staleAfterMs, jobId) ? staleAfterMs[jobId] : undefined;
}

function assertOptions(options: JobLivenessRouteOptions): void {
  const invalid = (message: string): never => {
    throw new JobLivenessRouteError("SHIP_HONO_JOB_LIVENESS_OPTIONS_INVALID", message);
  };
  if (typeof options !== "object" || options === null) invalid("options must be an object");
  if (typeof options.runtime?.liveness !== "function") {
    invalid("runtime must be a job runtime returned by startJobRuntime");
  }
  if (options.path !== undefined && !PATH_PATTERN.test(options.path)) {
    invalid(`path must be an absolute URL path; received ${JSON.stringify(options.path)}`);
  }
  if (options.clock !== undefined && typeof options.clock !== "function") {
    invalid("clock must be a function");
  }
  const bound = options.staleAfterMs;
  if (bound === undefined) return;
  const values = typeof bound === "number" ? [bound] : Object.values(bound ?? {});
  if (
    (typeof bound !== "number" && (typeof bound !== "object" || bound === null)) ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    invalid("staleAfterMs must be a positive safe integer or a record of them keyed by job id");
  }
}
