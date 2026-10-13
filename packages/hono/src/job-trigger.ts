import type { AnyJob, InferSchemaOutput, JobEnqueueOptions } from "@sixthsummit/ship-core";
import {
  booleanSchema,
  defineOperation,
  isJob,
  jobBackendDependency,
  jsonValueSchema,
  objectSchema,
  operationError,
  operationFailure,
  registerJobTriggerOperation,
  stringSchema,
} from "@sixthsummit/ship-core";
import { type HttpJsonBodyPolicy, http } from "./transport.js";

const PATH_PATTERN = /^\/[A-Za-z0-9._~\-/]*$/u;

export type HttpJobTriggerDiagnosticCode =
  | "SHIP_HONO_JOB_TRIGGER_JOB_INVALID"
  | "SHIP_HONO_JOB_TRIGGER_KIND_INVALID"
  | "SHIP_HONO_JOB_TRIGGER_OPTIONS_INVALID";

export class HttpJobTriggerError extends Error {
  readonly code: HttpJobTriggerDiagnosticCode;
  readonly jobId?: string;

  constructor(code: HttpJobTriggerDiagnosticCode, message: string, jobId?: string) {
    super(message);
    this.name = "HttpJobTriggerError";
    this.code = code;
    this.jobId = jobId;
  }
}

/** Raised by a trigger operation when the backend reports `queue-full`. */
export const jobQueueFull = operationError({
  code: "JOB_QUEUE_FULL",
  status: 429,
  message: "Job queue is full; retry later",
});

const runDetails = objectSchema({ runId: stringSchema({ minLength: 1 }) });
export const jobResultUnavailable = operationError({
  code: "JOB_RESULT_UNAVAILABLE",
  status: 503,
  message: "Job result observation is unavailable",
});
export const jobResultReadFailed = operationError({
  code: "JOB_RESULT_READ_FAILED",
  status: 503,
  message: "Job result could not be read; inspect the durable run before retrying",
  details: runDetails,
});
export const jobResultPending = operationError({
  code: "JOB_RESULT_PENDING",
  status: 504,
  message: "Job is still running; inspect the durable run before retrying",
  details: runDetails,
});
export const jobResultMissing = operationError({
  code: "JOB_RESULT_MISSING",
  status: 503,
  message: "Job run was not found; inspect its effect before retrying",
  details: runDetails,
});
export const jobResultInvalid = operationError({
  code: "JOB_RESULT_INVALID",
  status: 503,
  message: "Job completed without a JSON result; inspect the durable run",
  details: runDetails,
});
export const jobResultFailed = operationError({
  code: "JOB_RESULT_FAILED",
  status: 502,
  message: "Job failed after its backend retry policy",
  details: runDetails,
});

const acceptedSchema = objectSchema({
  accepted: booleanSchema(),
  runId: stringSchema({ minLength: 1 }),
  deduplicated: booleanSchema(),
});

export interface HttpJobTriggerOptions<TInput = unknown> {
  /** Defaults to `/jobs/<jobId>`. */
  readonly path?: string;
  readonly requestBody?: HttpJsonBodyPolicy;
  /** Derives a dedupe key from the validated body so repeated deliveries collapse into one run. */
  readonly dedupeKey?: (input: TInput) => string;
  readonly delayMs?: number;
}

/**
 * Projects a `trigger: { kind: "http" }` job onto `POST <path>`. The trigger is
 * an ordinary operation: the executor enforces `trigger.access` on the caller,
 * validates the body against the job's input schema and enqueues the run
 * through the bound `JobBackend`. Credentials are resolved by the application's
 * `ActorResolver`; see `jobTriggerActorResolver()` for scheduler identities.
 */
export function httpJobTrigger<TJob extends AnyJob>(
  job: TJob,
  options: HttpJobTriggerOptions<InferSchemaOutput<TJob["input"]["payload"]>> = {},
) {
  if (!isJob(job)) {
    throw new HttpJobTriggerError(
      "SHIP_HONO_JOB_TRIGGER_JOB_INVALID",
      "httpJobTrigger requires a job created by defineJob()",
    );
  }
  const trigger = job.job.trigger;
  if (trigger.kind !== "http") {
    throw new HttpJobTriggerError(
      "SHIP_HONO_JOB_TRIGGER_KIND_INVALID",
      `job ${JSON.stringify(job.id)} declares a ${trigger.kind} trigger; only http-triggered jobs can be projected onto HTTP`,
      job.id,
    );
  }
  assertOptions(job.id, options);
  const path = options.path ?? `/jobs/${job.id}`;
  const dedupeKey = options.dedupeKey;
  const delayMs = options.delayMs;
  const payload = job.input.payload as TJob["input"]["payload"];

  const operation = defineOperation({
    id: `${job.id}.trigger` as `${TJob["id"]}.trigger`,
    transport: http.post(path, {
      ...(options.requestBody ? { requestBody: options.requestBody } : {}),
    }),
    input: { body: payload },
    output: { 202: acceptedSchema },
    successStatus: 202,
    errors: [jobQueueFull],
    access: trigger.access,
    transaction: "none",
    dependencies: { jobs: jobBackendDependency() },
    handler: async ({ input, services }) => {
      const enqueueOptions: JobEnqueueOptions = {
        ...(dedupeKey ? { dedupeKey: dedupeKey(input.body as never) } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
      };
      const result = await services.jobs.enqueue(job.id, input.body, enqueueOptions);
      if (!result.accepted) throw operationFailure(jobQueueFull);
      return { accepted: true, runId: result.runId, deduplicated: result.deduplicated };
    },
  });
  registerJobTriggerOperation(operation, job);
  return operation;
}

export type HttpJobTrigger<TJob extends AnyJob> = ReturnType<typeof httpJobTrigger<TJob>>;

/**
 * Enqueues the same durable HTTP job as `httpJobTrigger`, then waits a bounded
 * time for its retained result. A timeout returns the run id and leaves the
 * backend's retry and retention policy untouched. Use this only when the HTTP
 * caller requires the handler's result in its POST response. A dedupeKey must
 * identify one upstream delivery (including retries); its retained terminal
 * result is reused until the job's completed-result retention expires.
 */
export function httpJobResultTrigger<TJob extends AnyJob>(
  job: TJob,
  options: HttpJobTriggerOptions<InferSchemaOutput<TJob["input"]["payload"]>> & {
    readonly timeoutMs: number;
  },
) {
  if (!isJob(job)) {
    throw new HttpJobTriggerError(
      "SHIP_HONO_JOB_TRIGGER_JOB_INVALID",
      "httpJobResultTrigger requires a job created by defineJob()",
    );
  }
  const trigger = job.job.trigger;
  if (trigger.kind !== "http") {
    throw new HttpJobTriggerError(
      "SHIP_HONO_JOB_TRIGGER_KIND_INVALID",
      `job ${JSON.stringify(job.id)} declares a ${trigger.kind} trigger; only http-triggered jobs can be projected onto HTTP`,
      job.id,
    );
  }
  assertOptions(job.id, options);
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000
  ) {
    throw new HttpJobTriggerError(
      "SHIP_HONO_JOB_TRIGGER_OPTIONS_INVALID",
      "result trigger requires timeoutMs from 1 through 120000",
      job.id,
    );
  }
  const operation = defineOperation({
    id: `${job.id}.trigger` as `${TJob["id"]}.trigger`,
    transport: http.post(options.path ?? `/jobs/${job.id}`, {
      ...(options.requestBody ? { requestBody: options.requestBody } : {}),
    }),
    input: { body: job.input.payload as TJob["input"]["payload"] },
    output: { 200: jsonValueSchema() },
    successStatus: 200,
    errors: [
      jobQueueFull,
      jobResultUnavailable,
      jobResultReadFailed,
      jobResultPending,
      jobResultMissing,
      jobResultInvalid,
      jobResultFailed,
    ],
    access: trigger.access,
    transaction: "none",
    dependencies: { jobs: jobBackendDependency() },
    handler: async ({ input, services }) => {
      // Check before enqueueing; an unsupported backend must not orphan a run.
      if (!services.jobs.waitForResult) throw operationFailure(jobResultUnavailable);
      const result = await services.jobs.enqueue(job.id, input.body, {
        ...(options.dedupeKey
          ? { dedupeKey: options.dedupeKey(input.body as never), reuseTerminalDedupe: true }
          : {}),
        ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      });
      if (!result.accepted) throw operationFailure(jobQueueFull);
      let observed;
      try {
        observed = await services.jobs.waitForResult(result.runId, {
          timeoutMs: options.timeoutMs,
        });
      } catch {
        throw operationFailure(jobResultReadFailed, { details: { runId: result.runId } });
      }
      if (observed.status === "pending") {
        throw operationFailure(jobResultPending, { details: { runId: result.runId } });
      }
      if (observed.status === "missing") {
        throw operationFailure(jobResultMissing, { details: { runId: result.runId } });
      }
      if (observed.status === "failed") {
        throw operationFailure(jobResultFailed, { details: { runId: result.runId } });
      }
      if (observed.data === undefined) {
        throw operationFailure(jobResultInvalid, { details: { runId: result.runId } });
      }
      return observed.data;
    },
  });
  registerJobTriggerOperation(operation, job);
  return operation;
}

function assertOptions(jobId: string, options: unknown): asserts options is HttpJobTriggerOptions {
  const invalid = (message: string) =>
    new HttpJobTriggerError("SHIP_HONO_JOB_TRIGGER_OPTIONS_INVALID", message, jobId);
  if (typeof options !== "object" || options === null)
    throw invalid("trigger options must be an object");
  const path = Reflect.get(options, "path");
  if (path !== undefined && (typeof path !== "string" || !PATH_PATTERN.test(path))) {
    throw invalid("trigger path must be an absolute HTTP path");
  }
  const dedupeKey = Reflect.get(options, "dedupeKey");
  if (dedupeKey !== undefined && typeof dedupeKey !== "function") {
    throw invalid("trigger dedupeKey must be a function of the validated body");
  }
  const delayMs = Reflect.get(options, "delayMs");
  if (delayMs !== undefined && !(Number.isInteger(delayMs) && (delayMs as number) >= 0)) {
    throw invalid("trigger delayMs must be a non-negative integer");
  }
  const requestBody = Reflect.get(options, "requestBody");
  if (requestBody !== undefined && Reflect.get(requestBody as object, "mode") !== "json") {
    throw invalid("trigger request bodies must use http.body.json()");
  }
}
