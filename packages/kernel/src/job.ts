import type { OperationAccess, SystemAccess } from "./access.js";
import { isOperationAccess, permission, systemAccess } from "./access.js";
import type {
  DependencyBindings,
  DependencyToken,
  EffectDependencyToken,
  ResolveDependencyBindings,
} from "./dependency.js";
import { isDependencyToken } from "./dependency.js";
import {
  arraySchema,
  type FrameworkFieldSchema,
  integerSchema,
  jsonValueSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "./framework-schema.js";
import type { OperationIdempotency } from "./idempotency.js";
import { isOperationIdempotency } from "./idempotency.js";
import type {
  AnyOperation,
  Operation,
  OperationContextForAccess,
  OperationTransactionMode,
  OperationTransport,
  OperationTransportMetadata,
} from "./operation.js";
import { defineOperation } from "./operation.js";
import type { OperationErrorDefinition } from "./operation-error.js";
import { operationError, operationFailure } from "./operation-error.js";
import type { AnyOutbox, OutboxBackend, OutboxBackoff, OutboxRetention } from "./outbox.js";
import { isOutbox } from "./outbox.js";
import type { InferSchemaInput, InferSchemaOutput, RuntimeSchema, SchemaResult } from "./schema.js";
import { isRuntimeSchema } from "./schema.js";

const JOB_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const CRON_PATTERN = /^\S+(?:\s+\S+){4,5}$/u;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

/** Permission that gates the generic job dead-letter and health operations. */
export const JOBS_MANAGE_PERMISSION = "ship.jobs:manage";
/** Provider id every application binds its `JobBackend` to. */
export const JOB_BACKEND_ID = "ship.jobs";
/** Provider id single-runner jobs resolve their `LockProvider` from. */
export const JOB_LOCK_PROVIDER_ID = "ship.jobs.lock";
/** The operation input location that carries a job's payload. */
export const JOB_INPUT_LOCATION = "payload";
/** Default lock lease for single-runner jobs. */
export const DEFAULT_JOB_LEASE_MS = 60_000;
/** Retention applied to completed and dead-lettered runs when a job declares none. */
export const DEFAULT_JOB_RETENTION: JobRetention = Object.freeze({
  completedMs: 7 * 24 * 60 * 60 * 1000,
  deadLetteredMs: 30 * 24 * 60 * 60 * 1000,
});

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

export interface JobScheduleTrigger {
  readonly kind: "schedule";
  /** Five- or six-field cron expression interpreted in `tz`. */
  readonly cron: string;
  /** IANA time zone; required so schedules never depend on the host clock. */
  readonly tz: string;
}

export interface JobIntervalTrigger {
  readonly kind: "interval";
  readonly everyMs: number;
}

export interface JobEnqueueTrigger {
  readonly kind: "enqueue";
}

/**
 * The job is started by an authenticated HTTP call projected by a transport
 * adapter. `access` is the trigger operation's access policy; the job itself
 * always runs under `systemAccess()`.
 */
export interface JobHttpTrigger {
  readonly kind: "http";
  readonly access: OperationAccess;
}

export type JobTrigger =
  | JobScheduleTrigger
  | JobIntervalTrigger
  | JobEnqueueTrigger
  | JobHttpTrigger;

export type JobConcurrencyMode = "single-runner" | "parallel";

export interface JobConcurrency<TInput = unknown> {
  readonly mode: JobConcurrencyMode;
  /** Per-process in-flight cap for this job. Defaults to 1. */
  readonly max?: number;
  /** Derives the lock / fairness key from validated input. Single-runner locks are `(jobId, key)`. */
  readonly key?: (input: TInput) => string;
  /** Required for a keyless single-runner: why one global runner is acceptable. */
  readonly reason?: string;
  /** Lock lease for single-runner jobs; extended while the handler runs. Defaults to 60 s. */
  readonly leaseMs?: number;
}

export interface JobRetry {
  readonly attempts: number;
  readonly backoff: OutboxBackoff;
}

/**
 * Same shape as an outbox retention. `completedMs: 0` or `deadLetteredMs: 0`
 * means "collect on the next cleanup sweep" rather than "keep forever".
 */
export type JobRetention = OutboxRetention;

export type JobTransactionMode = OperationTransactionMode;

export interface JobHandlerArguments<
  TInput extends RuntimeSchema,
  TDependencies extends DependencyBindings,
> {
  readonly input: InferSchemaOutput<TInput>;
  readonly services: ResolveDependencyBindings<TDependencies>;
  /** Jobs always run as `system` actors; `context.requestId` is the durable run id. */
  readonly context: OperationContextForAccess<SystemAccess>;
}

export interface JobDefinition<
  TId extends string,
  TInput extends RuntimeSchema,
  TDependencies extends DependencyBindings,
  TTransaction extends JobTransactionMode,
  TEffects extends readonly EffectDependencyToken[],
> {
  readonly id: TId;
  readonly input: TInput;
  readonly trigger: JobTrigger;
  readonly concurrency: JobConcurrency<InferSchemaOutput<TInput>>;
  readonly retry: JobRetry;
  readonly idempotency?: OperationIdempotency<InferSchemaOutput<TInput>>;
  readonly transaction: TTransaction;
  readonly effects?: TEffects;
  readonly dependencies: TDependencies;
  readonly retention?: JobRetention;
  /**
   * Declared failures the handler may raise with `operationFailure`. A declared
   * failure is a final outcome of the run (never retried) and is reported with
   * its status and code, exactly like an operation error; an undeclared throw
   * is a handler failure that consumes a retry attempt.
   */
  readonly errors?: readonly OperationErrorDefinition[];
  readonly handler: (
    arguments_: JobHandlerArguments<TInput, TDependencies>,
  ) => unknown | Promise<unknown>;
}

export type JobResultSchema = FrameworkFieldSchema<unknown>;

export interface JobTransport extends OperationTransport {
  readonly kind: "job";
  readonly binding: string;
  readonly metadata: OperationTransportMetadata;
}

/** Serializable, graph-projected description of a job. */
export interface JobDeclaration {
  readonly id: string;
  readonly trigger: JobTrigger;
  readonly concurrency: {
    readonly mode: JobConcurrencyMode;
    readonly max: number;
    readonly keyed: boolean;
    readonly reason?: string;
    readonly leaseMs: number;
  };
  readonly retry: JobRetry;
  readonly retention?: JobRetention;
  readonly transaction: JobTransactionMode;
}

/** The runtime view adapters receive: the declaration plus the key function. */
export interface JobRuntimeDeclaration extends JobDeclaration {
  readonly input: RuntimeSchema;
  readonly key?: (input: unknown) => string;
}

export type Job<
  TId extends string,
  TInput extends RuntimeSchema,
  TDependencies extends DependencyBindings,
  TTransaction extends JobTransactionMode,
  TEffects extends readonly EffectDependencyToken[],
> = Operation<
  TId,
  { readonly payload: TInput },
  { readonly 200: JobResultSchema },
  TDependencies,
  readonly [],
  SystemAccess,
  TTransaction,
  200,
  TEffects,
  JobTransport
> & {
  readonly transport: JobTransport;
  readonly job: JobRuntimeDeclaration & { readonly id: TId };
};

export interface AnyJob extends AnyOperation {
  readonly job: JobRuntimeDeclaration;
}

export type JobDefinitionDiagnosticCode =
  | "SHIP_JOB_DEFINITION_INVALID"
  | "SHIP_JOB_ID_INVALID"
  | "SHIP_JOB_INPUT_INVALID"
  | "SHIP_JOB_TRIGGER_INVALID"
  | "SHIP_JOB_SCHEDULE_TZ_REQUIRED"
  | "SHIP_JOB_CONCURRENCY_INVALID"
  | "SHIP_JOB_SINGLE_RUNNER_REASON_REQUIRED"
  | "SHIP_JOB_RETRY_ATTEMPTS_REQUIRED"
  | "SHIP_JOB_RETRY_INVALID"
  | "SHIP_JOB_RETENTION_INVALID"
  | "SHIP_JOB_TRANSACTION_INVALID"
  | "SHIP_JOB_IDEMPOTENCY_INVALID"
  | "SHIP_JOB_HANDLER_INVALID"
  | "SHIP_JOB_ERRORS_INVALID"
  | "SHIP_JOB_MANAGEMENT_OPTIONS_INVALID"
  | "SHIP_JOB_CLEANUP_OPTIONS_INVALID";

export class InvalidJobDefinitionError extends Error {
  readonly code: JobDefinitionDiagnosticCode;
  readonly jobId?: string;
  readonly field?: string;

  constructor(
    code: JobDefinitionDiagnosticCode,
    message: string,
    options: { readonly jobId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidJobDefinitionError";
    this.code = code;
    this.jobId = options.jobId;
    this.field = options.field;
  }
}

const jobResultSchema: JobResultSchema = jsonValueSchema();

/**
 * Declares a job. The result is an ordinary operation (`access: systemAccess()`,
 * input `{ payload }`, transport kind `job`) so it compiles into the same graph
 * and runs through the same executor as every other operation. Backends only
 * decide when and where the executor is invoked.
 */
export function defineJob<
  const TId extends string,
  const TInput extends RuntimeSchema,
  const TDependencies extends DependencyBindings,
  const TTransaction extends JobTransactionMode,
  const TEffects extends readonly EffectDependencyToken[] = readonly [],
>(
  definition: JobDefinition<TId, TInput, TDependencies, TTransaction, TEffects>,
): Job<TId, TInput, TDependencies, TTransaction, TEffects> {
  const job = buildJob(definition, jobResultSchema) as Job<
    TId,
    TInput,
    TDependencies,
    TTransaction,
    TEffects
  >;
  jobOperationRoles.set(job, Object.freeze({ role: "job", jobId: definition.id }));
  return job;
}

function buildJob(definition: unknown, output: FrameworkFieldSchema<unknown>): AnyJob {
  assertJobDefinition(definition);
  const declaration = describeDeclaration(definition);
  const handler = definition.handler as (arguments_: unknown) => unknown;
  const idempotency = definition.idempotency;
  const operation = defineOperation({
    id: definition.id,
    input: { payload: definition.input },
    output: { 200: output },
    successStatus: 200,
    errors: definition.errors ?? [],
    access: systemAccess(),
    transaction: definition.transaction,
    dependencies: definition.dependencies,
    ...(definition.effects ? { effects: definition.effects } : {}),
    transport: jobTransport(declaration),
    ...(idempotency
      ? {
          idempotency: {
            key: (input: { readonly payload: unknown }) =>
              (idempotency.key as (input: unknown) => string)(input.payload),
            windowMs: idempotency.windowMs,
            store: idempotency.store,
          },
        }
      : {}),
    handler: ({ input, services, context }) =>
      handler({ input: (input as { readonly payload: unknown }).payload, services, context }),
  });
  return Object.freeze({
    ...operation,
    job: Object.freeze({
      ...declaration,
      input: definition.input,
      ...(definition.concurrency.key ? { key: definition.concurrency.key } : {}),
    }),
  }) as unknown as AnyJob;
}

export function isJob(value: unknown): value is AnyJob {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.operation" &&
    typeof Reflect.get(value, "job") === "object" &&
    Reflect.get(value, "job") !== null &&
    typeof Reflect.get(Reflect.get(value, "job") as object, "id") === "string" &&
    Reflect.get(Reflect.get(value, "job") as object, "id") === Reflect.get(value, "id")
  );
}

function describeDeclaration(
  definition: JobDefinition<
    string,
    RuntimeSchema,
    DependencyBindings,
    JobTransactionMode,
    readonly EffectDependencyToken[]
  >,
): JobDeclaration {
  const concurrency = definition.concurrency;
  return Object.freeze({
    id: definition.id,
    trigger: freezeTrigger(definition.trigger),
    concurrency: Object.freeze({
      mode: concurrency.mode,
      max: concurrency.max ?? 1,
      keyed: typeof concurrency.key === "function",
      ...(concurrency.reason !== undefined ? { reason: concurrency.reason } : {}),
      leaseMs: concurrency.leaseMs ?? DEFAULT_JOB_LEASE_MS,
    }),
    retry: Object.freeze({
      attempts: definition.retry.attempts,
      backoff: Object.freeze({ ...definition.retry.backoff }),
    }),
    ...(definition.retention ? { retention: Object.freeze({ ...definition.retention }) } : {}),
    transaction: definition.transaction,
  });
}

function freezeTrigger(trigger: JobTrigger): JobTrigger {
  if (trigger.kind === "http") {
    return Object.freeze({ kind: "http", access: trigger.access });
  }
  return Object.freeze({ ...trigger });
}

function jobTransport(declaration: JobDeclaration): JobTransport {
  const trigger: OperationTransportMetadata =
    declaration.trigger.kind === "http"
      ? {
          kind: "http",
          access: {
            kind: declaration.trigger.access.kind,
            ...(declaration.trigger.access.kind === "permissions"
              ? {
                  mode: declaration.trigger.access.mode,
                  permissions: [...declaration.trigger.access.permissions].sort(),
                }
              : {}),
            ...(declaration.trigger.access.kind === "provider"
              ? { provider: declaration.trigger.access.provider }
              : {}),
          },
        }
      : { ...declaration.trigger };
  return Object.freeze({
    kind: "job" as const,
    binding: declaration.id,
    metadata: Object.freeze({
      trigger,
      concurrency: {
        mode: declaration.concurrency.mode,
        max: declaration.concurrency.max,
        keyed: declaration.concurrency.keyed,
        ...(declaration.concurrency.reason !== undefined
          ? { reason: declaration.concurrency.reason }
          : {}),
        leaseMs: declaration.concurrency.leaseMs,
      },
      retry: {
        attempts: declaration.retry.attempts,
        backoff: {
          initialMs: declaration.retry.backoff.initialMs,
          ...(declaration.retry.backoff.multiplier !== undefined
            ? { multiplier: declaration.retry.backoff.multiplier }
            : {}),
          ...(declaration.retry.backoff.maxMs !== undefined
            ? { maxMs: declaration.retry.backoff.maxMs }
            : {}),
        },
      },
      ...(declaration.retention
        ? {
            retention: {
              completedMs: declaration.retention.completedMs,
              deadLetteredMs: declaration.retention.deadLetteredMs,
            },
          }
        : {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Dependency tokens
// ---------------------------------------------------------------------------

export interface JobBackendDependencyToken extends DependencyToken<JobBackend, JobBackend> {
  readonly scope: "job";
  readonly role: "backend";
}

export interface JobEnqueueDependencyToken<TInput extends RuntimeSchema = RuntimeSchema>
  extends DependencyToken<JobBackend, JobEnqueuer<TInput>> {
  readonly scope: "job";
  readonly role: "enqueue";
  readonly job: AnyJob;
}

export interface LockProviderDependencyToken extends DependencyToken<LockProvider, LockProvider> {
  readonly scope: "job";
  readonly role: "lock";
}

/** The raw backend token for management, cleanup, trigger and custom tooling operations. */
export function jobBackendDependency(): JobBackendDependencyToken {
  return Object.freeze({
    kind: "ship.dependency" as const,
    id: JOB_BACKEND_ID,
    scope: "job" as const,
    role: "backend" as const,
  });
}

/**
 * Declares that an operation or job enqueues `job`. The resolved value is a
 * typed enqueuer for that one job, so the graph shows every job-to-job edge
 * and a handler cannot start work it did not declare.
 */
export function jobDependency<TJob extends AnyJob>(
  job: TJob,
): JobEnqueueDependencyToken<TJob["input"]["payload"]> {
  if (!isJob(job)) {
    throw new InvalidJobDefinitionError(
      "SHIP_JOB_DEFINITION_INVALID",
      "jobDependency() requires a job created by defineJob()",
    );
  }
  return Object.freeze({
    kind: "ship.dependency" as const,
    id: job.id,
    scope: "job" as const,
    role: "enqueue" as const,
    job,
  }) as JobEnqueueDependencyToken<TJob["input"]["payload"]>;
}

/** The lock provider token single-runner jobs resolve at run time. */
export function lockProviderDependency(): LockProviderDependencyToken {
  return Object.freeze({
    kind: "ship.dependency" as const,
    id: JOB_LOCK_PROVIDER_ID,
    scope: "job" as const,
    role: "lock" as const,
  });
}

export function isJobDependencyToken(value: DependencyToken): value is DependencyToken & {
  readonly scope: "job";
  readonly role: "backend" | "enqueue" | "lock";
} {
  return isDependencyToken(value) && value.scope === "job";
}

export function isJobEnqueueDependencyToken(
  value: DependencyToken,
): value is JobEnqueueDependencyToken {
  return (
    isJobDependencyToken(value) && value.role === "enqueue" && isJob(Reflect.get(value, "job"))
  );
}

// ---------------------------------------------------------------------------
// Backend and lock contracts
// ---------------------------------------------------------------------------

export type JobRunStatus = "waiting" | "delayed" | "active" | "completed" | "failed" | "discarded";

export interface JobAttemptFailure {
  readonly attempt: number;
  readonly error: string;
  readonly at: Date;
}

export interface JobRun {
  readonly runId: string;
  readonly jobId: string;
  readonly input: unknown;
  readonly key?: string;
  readonly dedupeKey?: string;
  readonly status: JobRunStatus;
  /** Number of attempts started so far. */
  readonly attempts: number;
  readonly lastError?: string;
  /** One entry per failed attempt, oldest first. */
  readonly history: readonly JobAttemptFailure[];
  readonly createdAt: Date;
  readonly availableAt: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly failedAt?: Date;
  readonly discardedAt?: Date;
  readonly discardReason?: string;
}

export interface JobEnqueueOptions {
  /** A repeated key is a no-op while a run with that key is not yet terminal. */
  readonly dedupeKey?: string;
  /** Return the retained terminal run for this key instead of replaying it. */
  readonly reuseTerminalDedupe?: boolean;
  readonly delayMs?: number;
}

export type JobEnqueueResult =
  | { readonly accepted: true; readonly runId: string; readonly deduplicated: boolean }
  | { readonly accepted: false; readonly rejected: "queue-full" };

export interface JobConcurrencyBudget {
  /** Process-wide cap on in-flight runs across every job. */
  readonly maxInFlight: number;
  /** Runs waiting or delayed per job before `enqueue` returns `queue-full`. */
  readonly maxQueueDepth: number;
}

export type JobWorkerMode = "api" | "worker" | "all";

export interface JobHealthEntry {
  readonly jobId: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly lastRunAt?: Date;
  readonly lastSuccessAt?: Date;
  /** Age of the oldest waiting run, in milliseconds; 0 when nothing waits. */
  readonly lagMs: number;
}

export interface JobHealth {
  readonly jobs: readonly JobHealthEntry[];
}

export interface JobCleanupResult {
  readonly completedDeleted: number;
  readonly deadLetteredDeleted: number;
}

export interface JobRunExecution {
  readonly runId: string;
  readonly attempt: number;
  readonly key?: string;
}

export type JobExecutionOutcome =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: string;
      /** Validation and access failures are final; handler failures and lock contention retry. */
      readonly retryable: boolean;
      readonly lockHeld?: boolean;
    };

/** What a backend receives from `startJobRuntime` before it can run anything. */
export interface JobRuntimeBinding {
  readonly jobs: readonly JobRuntimeDeclaration[];
  readonly execute: (
    jobId: string,
    input: unknown,
    run: JobRunExecution,
  ) => Promise<JobExecutionOutcome>;
}

/** A bounded observation of a durable run; pending and missing are never safe to replay blindly. */
export type JobResultObservation =
  | { readonly status: "completed"; readonly runId: string; readonly data: unknown }
  | { readonly status: "failed"; readonly runId: string; readonly error: string }
  | { readonly status: "pending"; readonly runId: string }
  | { readonly status: "missing"; readonly runId: string };

/**
 * Adapter contract for durable job execution. Delivery is at-least-once: a run
 * whose process dies after the handler's external work but before completion
 * is recorded will run again after its lease expires.
 */
export interface JobBackend {
  readonly kind: "ship.job-backend";
  readonly adapter: string;
  readonly concurrencyBudget: JobConcurrencyBudget;
  attach(binding: JobRuntimeBinding): void | Promise<void>;
  enqueue(jobId: string, input: unknown, options?: JobEnqueueOptions): Promise<JobEnqueueResult>;
  /** Optional capability for HTTP callers needing a bounded synchronous result. */
  waitForResult?(
    runId: string,
    options: { readonly timeoutMs: number },
  ): Promise<JobResultObservation>;
  /** Replaces any existing schedule for the job; never registers a duplicate. */
  schedule(jobId: string, trigger: JobScheduleTrigger | JobIntervalTrigger): Promise<void>;
  unschedule(jobId: string): Promise<void>;
  /** Returns the number of workers started; `api` mode starts none. */
  startWorkers(mode: JobWorkerMode, budget?: Partial<JobConcurrencyBudget>): Promise<number>;
  /** Stops taking new runs, drains in-flight ones, then closes connections. */
  quit(): Promise<void>;
  health(now: Date): Promise<JobHealth>;
  listFailed(options: { readonly limit: number }): Promise<readonly JobRun[]>;
  /** Returns the run moved back to waiting, or undefined when it is not failed. */
  retry(runId: string): Promise<JobRun | undefined>;
  /** Returns the discarded run, or undefined when it is not failed. */
  discard(runId: string, reason: string): Promise<JobRun | undefined>;
  cleanup(now: Date): Promise<JobCleanupResult>;
  /**
   * Optional operator-facing introspection (run listing, schedules, pause).
   * Adapters that omit it still satisfy the contract; an ops console reports
   * the missing capability instead of failing.
   */
  readonly introspection?: JobIntrospection;
}

// ---------------------------------------------------------------------------
// Introspection (optional backend capability read by operator tooling)
// ---------------------------------------------------------------------------

export interface JobRunQuery {
  /** Restrict to one declared job. */
  readonly jobId?: string;
  /** Restrict to one run status; every status when omitted. */
  readonly status?: JobRunStatus;
  readonly limit: number;
}

/** A reconciled schedule as the backend holds it. */
export interface JobScheduleState {
  readonly jobId: string;
  readonly trigger: JobScheduleTrigger | JobIntervalTrigger;
  /** The next occurrence the backend will enqueue, when it is known. */
  readonly nextAt?: Date;
}

/**
 * Backend-neutral introspection contract an operator console reads. Every
 * method is a read except `pause` and `resume`, which a backend exposes only
 * when it can hold the paused state where its workers will see it: a paused
 * job keeps accepting runs and keeps ticking its schedule, but no worker
 * claims its waiting runs until it is resumed.
 */
export interface JobIntrospection {
  readonly kind: "ship.job-introspection";
  /** Declarations the backend was attached with; empty before `attach`. */
  declarations(): readonly JobRuntimeDeclaration[];
  /** Runs matching the query, most recently created first. */
  listRuns(query: JobRunQuery): Promise<readonly JobRun[]>;
  getRun(runId: string): Promise<JobRun | undefined>;
  listSchedules(): Promise<readonly JobScheduleState[]>;
  /** Ids of jobs whose claims are currently paused. */
  listPaused(): Promise<readonly string[]>;
  pause?(jobId: string): Promise<void>;
  resume?(jobId: string): Promise<void>;
}

export function isJobIntrospection(value: unknown): value is JobIntrospection {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.job-introspection" &&
    ["declarations", "listRuns", "getRun", "listSchedules", "listPaused"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}

/** The backend's introspection capability, or undefined when the adapter does not provide one. */
export function jobIntrospection(backend: JobBackend): JobIntrospection | undefined {
  const value = backend.introspection;
  return isJobIntrospection(value) ? value : undefined;
}

export function isJobBackend(value: unknown): value is JobBackend {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.job-backend" &&
    typeof Reflect.get(value, "adapter") === "string" &&
    typeof Reflect.get(value, "concurrencyBudget") === "object" &&
    [
      "attach",
      "enqueue",
      "schedule",
      "unschedule",
      "startWorkers",
      "quit",
      "health",
      "listFailed",
      "retry",
      "discard",
      "cleanup",
    ].every((method) => typeof Reflect.get(value, method) === "function")
  );
}

export interface LockLease {
  readonly jobId: string;
  readonly key: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Mutual exclusion for single-runner jobs, keyed by `(jobId, key)`. `acquire`
 * returns undefined without waiting when the lease is held elsewhere.
 */
export interface LockProvider {
  readonly kind: "ship.lock-provider";
  acquire(jobId: string, key: string, ttlMs: number): Promise<LockLease | undefined>;
  release(lease: LockLease): Promise<void>;
  /** Extends a held lease; returns false when the lease was lost. */
  extend?(lease: LockLease, ttlMs: number): Promise<boolean>;
}

export function isLockProvider(value: unknown): value is LockProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.lock-provider" &&
    typeof Reflect.get(value, "acquire") === "function" &&
    typeof Reflect.get(value, "release") === "function"
  );
}

// ---------------------------------------------------------------------------
// Enqueuer (constructed by the executor for jobDependency tokens)
// ---------------------------------------------------------------------------

export interface JobEnqueuer<TInput extends RuntimeSchema = RuntimeSchema> {
  readonly kind: "ship.job-enqueuer";
  readonly jobId: string;
  enqueue(input: InferSchemaInput<TInput>, options?: JobEnqueueOptions): Promise<JobEnqueueResult>;
}

export type JobEnqueueErrorCode = "SHIP_JOB_INPUT_INVALID" | "SHIP_JOB_ENQUEUE_OPTIONS_INVALID";

export class JobEnqueueError extends Error {
  readonly code: JobEnqueueErrorCode;
  readonly jobId: string;
  readonly issues?: readonly { readonly message: string; readonly path: readonly PropertyKey[] }[];

  constructor(
    code: JobEnqueueErrorCode,
    message: string,
    options: {
      readonly jobId: string;
      readonly issues?: readonly {
        readonly message: string;
        readonly path: readonly PropertyKey[];
      }[];
    },
  ) {
    super(message);
    this.name = "JobEnqueueError";
    this.code = code;
    this.jobId = options.jobId;
    this.issues = options.issues;
  }
}

/** @internal Constructed by the executor for each `jobDependency()` binding. */
export function createJobEnqueuer<TInput extends RuntimeSchema>(
  job: AnyJob,
  backend: JobBackend,
): JobEnqueuer<TInput> {
  return Object.freeze({
    kind: "ship.job-enqueuer" as const,
    jobId: job.id,
    enqueue: async (input: unknown, options: JobEnqueueOptions = {}) => {
      assertEnqueueOptions(job.id, options);
      const validated = await validateJobInput(job, input);
      return backend.enqueue(job.id, validated, options);
    },
  }) as JobEnqueuer<TInput>;
}

export async function validateJobInput(job: AnyJob, input: unknown): Promise<unknown> {
  const result = (await job.job.input["~standard"].validate(input)) as SchemaResult<unknown>;
  if ("issues" in result && result.issues !== undefined) {
    throw new JobEnqueueError(
      "SHIP_JOB_INPUT_INVALID",
      `job ${JSON.stringify(job.id)} input does not match its declared schema`,
      {
        jobId: job.id,
        issues: result.issues.map((item) => ({
          message: item.message,
          path: (item.path ?? []).map((segment) =>
            typeof segment === "object" && segment !== null ? segment.key : segment,
          ),
        })),
      },
    );
  }
  return result.value;
}

function assertEnqueueOptions(
  jobId: string,
  options: unknown,
): asserts options is JobEnqueueOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    (Reflect.get(options, "dedupeKey") !== undefined &&
      (typeof Reflect.get(options, "dedupeKey") !== "string" ||
        Reflect.get(options, "dedupeKey").length === 0)) ||
    (Reflect.get(options, "delayMs") !== undefined &&
      !isNonNegativeInteger(Reflect.get(options, "delayMs")))
  ) {
    throw new JobEnqueueError(
      "SHIP_JOB_ENQUEUE_OPTIONS_INVALID",
      "job enqueue options must provide a non-empty dedupeKey and a non-negative integer delayMs when present",
      { jobId },
    );
  }
}

// ---------------------------------------------------------------------------
// Operation roles (read by the application compiler and tooling)
// ---------------------------------------------------------------------------

export type JobOperationRole =
  | { readonly role: "job"; readonly jobId: string }
  | { readonly role: "trigger"; readonly jobId: string }
  | { readonly role: "cleanup"; readonly jobId: string; readonly outboxIds: readonly string[] }
  | {
      readonly role: "management";
      readonly action: "list-failed" | "retry" | "discard" | "health";
    };

const jobOperationRoles = new WeakMap<object, JobOperationRole>();

/** Identifies job-related operations for graph projection and diagnostics. */
export function describeJobOperation(operation: AnyOperation): JobOperationRole | undefined {
  return jobOperationRoles.get(operation);
}

/**
 * Registers a transport-projected trigger operation for `job`. Adapters call
 * this so the compiler can see that an `http` trigger is actually bound.
 */
export function registerJobTriggerOperation(operation: AnyOperation, job: AnyJob): void {
  jobOperationRoles.set(operation, Object.freeze({ role: "trigger", jobId: job.id }));
}

// ---------------------------------------------------------------------------
// Management operations
// ---------------------------------------------------------------------------

const attemptFailureSchema = objectSchema({
  attempt: integerSchema({ minimum: 1 }),
  error: stringSchema(),
  at: stringSchema({ minLength: 1 }),
});

const runViewSchema = objectSchema({
  runId: stringSchema({ minLength: 1 }),
  jobId: stringSchema({ minLength: 1 }),
  input: jsonValueSchema(),
  status: stringSchema({ minLength: 1 }),
  attempts: integerSchema({ minimum: 0 }),
  history: arraySchema(attemptFailureSchema),
  createdAt: stringSchema({ minLength: 1 }),
  availableAt: stringSchema({ minLength: 1 }),
  key: optionalSchema(stringSchema()),
  dedupeKey: optionalSchema(stringSchema({ minLength: 1 })),
  lastError: optionalSchema(stringSchema()),
  startedAt: optionalSchema(stringSchema({ minLength: 1 })),
  completedAt: optionalSchema(stringSchema({ minLength: 1 })),
  failedAt: optionalSchema(stringSchema({ minLength: 1 })),
  discardedAt: optionalSchema(stringSchema({ minLength: 1 })),
  discardReason: optionalSchema(stringSchema()),
});

export type JobRunView = InferSchemaOutput<typeof runViewSchema>;

const listQuerySchema = objectSchema({
  limit: optionalSchema(integerSchema({ minimum: 1, maximum: MAX_LIST_LIMIT })),
});
const listOutputSchema = objectSchema({ runs: arraySchema(runViewSchema) });
const runIdBodySchema = objectSchema({ runId: stringSchema({ minLength: 1 }) });
const discardBodySchema = objectSchema({
  runId: stringSchema({ minLength: 1 }),
  reason: stringSchema({ minLength: 1 }),
});
const runOutputSchema = objectSchema({ run: runViewSchema });
const healthEntrySchema = objectSchema({
  jobId: stringSchema({ minLength: 1 }),
  waiting: integerSchema({ minimum: 0 }),
  active: integerSchema({ minimum: 0 }),
  delayed: integerSchema({ minimum: 0 }),
  failed: integerSchema({ minimum: 0 }),
  lagMs: integerSchema({ minimum: 0 }),
  lastRunAt: optionalSchema(stringSchema({ minLength: 1 })),
  lastSuccessAt: optionalSchema(stringSchema({ minLength: 1 })),
});
const healthOutputSchema = objectSchema({ jobs: arraySchema(healthEntrySchema) });

export const jobRunNotFound = operationError({
  code: "JOB_RUN_NOT_FOUND",
  status: 404,
  message: "Failed job run not found",
});

export interface JobManagementOptions<TPrefix extends string = "jobs"> {
  /** Operation id prefix and owning module id. Defaults to `jobs`. */
  readonly prefix?: TPrefix;
  readonly clock?: () => Date;
}

/**
 * Generates the generic dead-letter and health operations
 * (`<prefix>.list-failed`, `<prefix>.retry`, `<prefix>.discard`,
 * `<prefix>.health`), each gated by `ship.jobs:manage`.
 */
export function defineJobManagement<const TPrefix extends string = "jobs">(
  options: JobManagementOptions<TPrefix> = {},
) {
  assertManagementOptions(options);
  const prefix = (options.prefix ?? "jobs") as TPrefix;
  const clock = options.clock ?? (() => new Date());
  const backend = jobBackendDependency();

  const listFailed = defineOperation({
    id: `${prefix}.list-failed` as const,
    input: { query: listQuerySchema },
    output: { 200: listOutputSchema },
    successStatus: 200,
    errors: [],
    access: permission(JOBS_MANAGE_PERMISSION),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const runs = await services.jobs.listFailed({
        limit: input.query.limit ?? DEFAULT_LIST_LIMIT,
      });
      return { runs: runs.map(runView) };
    },
  });
  jobOperationRoles.set(listFailed, Object.freeze({ role: "management", action: "list-failed" }));

  const retry = defineOperation({
    id: `${prefix}.retry` as const,
    input: { body: runIdBodySchema },
    output: { 200: runOutputSchema },
    successStatus: 200,
    errors: [jobRunNotFound],
    access: permission(JOBS_MANAGE_PERMISSION),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const run = await services.jobs.retry(input.body.runId);
      if (!run) throw operationFailure(jobRunNotFound);
      return { run: runView(run) };
    },
  });
  jobOperationRoles.set(retry, Object.freeze({ role: "management", action: "retry" }));

  const discard = defineOperation({
    id: `${prefix}.discard` as const,
    input: { body: discardBodySchema },
    output: { 200: runOutputSchema },
    successStatus: 200,
    errors: [jobRunNotFound],
    access: permission(JOBS_MANAGE_PERMISSION),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const run = await services.jobs.discard(input.body.runId, input.body.reason);
      if (!run) throw operationFailure(jobRunNotFound);
      return { run: runView(run) };
    },
  });
  jobOperationRoles.set(discard, Object.freeze({ role: "management", action: "discard" }));

  const health = defineOperation({
    id: `${prefix}.health` as const,
    input: {},
    output: { 200: healthOutputSchema },
    successStatus: 200,
    errors: [],
    access: permission(JOBS_MANAGE_PERMISSION),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ services }) => {
      const result = await services.jobs.health(clock());
      return {
        jobs: result.jobs.map((entry) => ({
          jobId: entry.jobId,
          waiting: entry.waiting,
          active: entry.active,
          delayed: entry.delayed,
          failed: entry.failed,
          lagMs: entry.lagMs,
          ...(entry.lastRunAt ? { lastRunAt: entry.lastRunAt.toISOString() } : {}),
          ...(entry.lastSuccessAt ? { lastSuccessAt: entry.lastSuccessAt.toISOString() } : {}),
        })),
      };
    },
  });
  jobOperationRoles.set(health, Object.freeze({ role: "management", action: "health" }));

  return Object.freeze({
    kind: "ship.job-management" as const,
    listFailed,
    retry,
    discard,
    health,
    /** All generated operations, ready to spread into a module's operations. */
    operations: Object.freeze([listFailed, retry, discard, health] as const),
  });
}

export type JobManagement = ReturnType<typeof defineJobManagement>;

export function jobRunView(run: JobRun): JobRunView {
  return runView(run);
}

function runView(run: JobRun): JobRunView {
  return Object.freeze({
    runId: run.runId,
    jobId: run.jobId,
    input: run.input,
    status: run.status,
    attempts: run.attempts,
    history: Object.freeze(
      run.history.map((item) =>
        Object.freeze({ attempt: item.attempt, error: item.error, at: item.at.toISOString() }),
      ),
    ),
    createdAt: run.createdAt.toISOString(),
    availableAt: run.availableAt.toISOString(),
    ...(run.key !== undefined ? { key: run.key } : {}),
    ...(run.dedupeKey !== undefined ? { dedupeKey: run.dedupeKey } : {}),
    ...(run.lastError !== undefined ? { lastError: run.lastError } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    ...(run.failedAt ? { failedAt: run.failedAt.toISOString() } : {}),
    ...(run.discardedAt ? { discardedAt: run.discardedAt.toISOString() } : {}),
    ...(run.discardReason !== undefined ? { discardReason: run.discardReason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Framework cleanup job
// ---------------------------------------------------------------------------

const outboxCleanupSchema = objectSchema({
  id: stringSchema({ minLength: 1 }),
  completedDeleted: integerSchema({ minimum: 0 }),
  deadLetteredDeleted: integerSchema({ minimum: 0 }),
});
const cleanupOutputSchema = objectSchema({
  runs: objectSchema({
    completedDeleted: integerSchema({ minimum: 0 }),
    deadLetteredDeleted: integerSchema({ minimum: 0 }),
  }),
  outboxes: arraySchema(outboxCleanupSchema),
});

export interface JobCleanupOptions<TId extends string = "jobs.cleanup"> {
  /** Defaults to `jobs.cleanup`; must be namespaced by the module that composes it. */
  readonly id?: TId;
  readonly trigger: JobScheduleTrigger | JobIntervalTrigger;
  /**
   * Outboxes with declared retention whose completed and dead-lettered records
   * are swept on the same schedule, exactly as `defineOutboxCleanup` would.
   */
  readonly outboxes?: readonly AnyOutbox[];
  readonly clock?: () => Date;
}

/**
 * A keyed single-runner job that deletes job runs past their retention and
 * sweeps the given outboxes through the same backend contract
 * `defineOutboxCleanup` uses. One schedule covers both retention policies.
 */
export function defineJobCleanup<const TId extends string = "jobs.cleanup">(
  options: JobCleanupOptions<TId>,
) {
  assertCleanupOptions(options);
  const id = (options.id ?? "jobs.cleanup") as TId;
  const clock = options.clock ?? (() => new Date());
  const outboxes = Object.freeze([...(options.outboxes ?? [])]);
  const outboxBindings: Record<string, DependencyToken> = {};
  for (const [index, outbox] of outboxes.entries()) {
    outboxBindings[`outbox${index}`] = outbox.backend;
  }
  const definition: JobDefinition<
    string,
    JobResultSchema,
    DependencyBindings,
    "none",
    readonly []
  > = {
    id,
    input: jsonValueSchema(),
    trigger: options.trigger,
    concurrency: { mode: "single-runner", key: () => "cleanup" },
    retry: { attempts: 3, backoff: { initialMs: 1_000, multiplier: 4, maxMs: 60_000 } },
    transaction: "none",
    dependencies: { jobs: jobBackendDependency(), ...outboxBindings },
    handler: async ({ services }) => {
      const now = clock();
      const runs = await (services.jobs as JobBackend).cleanup(now);
      const swept: { id: string; completedDeleted: number; deadLetteredDeleted: number }[] = [];
      for (const [index, outbox] of outboxes.entries()) {
        const backend = Reflect.get(services, `outbox${index}`) as OutboxBackend;
        const retention = outbox.retention as OutboxRetention;
        const result = await backend.cleanup(retention, now);
        swept.push({
          id: outbox.id,
          completedDeleted: result.completedDeleted,
          deadLetteredDeleted: result.deadLetteredDeleted,
        });
      }
      return { runs, outboxes: swept };
    },
  };
  const job = buildJob(definition, cleanupOutputSchema) as Job<
    TId,
    JobResultSchema,
    { readonly jobs: JobBackendDependencyToken },
    "none",
    readonly []
  > & { readonly output: { readonly 200: typeof cleanupOutputSchema } };
  jobOperationRoles.set(
    job,
    Object.freeze({ role: "cleanup", jobId: id, outboxIds: outboxes.map((item) => item.id) }),
  );
  return job;
}

export type JobCleanup = ReturnType<typeof defineJobCleanup>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertJobDefinition(
  definition: unknown,
): asserts definition is JobDefinition<
  string,
  RuntimeSchema,
  DependencyBindings,
  JobTransactionMode,
  readonly EffectDependencyToken[]
> {
  if (typeof definition !== "object" || definition === null) {
    fail("SHIP_JOB_DEFINITION_INVALID", "job definition must be an object");
  }
  const id = Reflect.get(definition, "id");
  const jobId = typeof id === "string" ? id : undefined;
  if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
    fail(
      "SHIP_JOB_ID_INVALID",
      "job id must contain at least two lowercase dot-separated segments",
      jobId,
      "id",
    );
  }
  if (!isRuntimeSchema(Reflect.get(definition, "input"))) {
    fail("SHIP_JOB_INPUT_INVALID", "job input must be a Standard Schema", jobId, "input");
  }
  assertTrigger(Reflect.get(definition, "trigger"), jobId);
  assertConcurrency(Reflect.get(definition, "concurrency"), jobId);
  assertRetry(Reflect.get(definition, "retry"), jobId);
  const transaction = Reflect.get(definition, "transaction");
  if (transaction !== "none" && transaction !== "read" && transaction !== "write") {
    fail(
      "SHIP_JOB_TRANSACTION_INVALID",
      "transaction must be one of none, read, or write",
      jobId,
      "transaction",
    );
  }
  // `0` is a legal retention: the run is collected on the next cleanup sweep.
  const retention = Reflect.get(definition, "retention");
  if (
    retention !== undefined &&
    (typeof retention !== "object" ||
      retention === null ||
      !isNonNegativeInteger(Reflect.get(retention, "completedMs")) ||
      !isNonNegativeInteger(Reflect.get(retention, "deadLetteredMs")))
  ) {
    fail(
      "SHIP_JOB_RETENTION_INVALID",
      "retention must declare non-negative integer completedMs and deadLetteredMs (0 collects on the next cleanup sweep)",
      jobId,
      "retention",
    );
  }
  const idempotency = Reflect.get(definition, "idempotency");
  if (idempotency !== undefined && !isOperationIdempotency(idempotency)) {
    fail(
      "SHIP_JOB_IDEMPOTENCY_INVALID",
      "idempotency must declare key(input), a positive integer windowMs, and an idempotencyStoreDependency() token",
      jobId,
      "idempotency",
    );
  }
  const errors = Reflect.get(definition, "errors");
  if (errors !== undefined && !Array.isArray(errors)) {
    fail(
      "SHIP_JOB_ERRORS_INVALID",
      "errors must be an array of operationError definitions",
      jobId,
      "errors",
    );
  }
  if (typeof Reflect.get(definition, "handler") !== "function") {
    fail("SHIP_JOB_HANDLER_INVALID", "handler must be a function", jobId, "handler");
  }
}

function assertTrigger(trigger: unknown, jobId: string): asserts trigger is JobTrigger {
  if (typeof trigger !== "object" || trigger === null) {
    fail("SHIP_JOB_TRIGGER_INVALID", "trigger must be an object with a kind", jobId, "trigger");
  }
  const kind = Reflect.get(trigger, "kind");
  if (kind === "schedule") {
    const cron = Reflect.get(trigger, "cron");
    if (typeof cron !== "string" || !CRON_PATTERN.test(cron.trim())) {
      fail(
        "SHIP_JOB_TRIGGER_INVALID",
        "schedule trigger cron must be a five- or six-field cron expression",
        jobId,
        "trigger.cron",
      );
    }
    const tz = Reflect.get(trigger, "tz");
    if (typeof tz !== "string" || tz.length === 0) {
      fail(
        "SHIP_JOB_SCHEDULE_TZ_REQUIRED",
        `job ${JSON.stringify(jobId)} declares a schedule without tz; name the IANA time zone the cron expression runs in`,
        jobId,
        "trigger.tz",
      );
    }
    if (!isTimeZone(tz)) {
      fail(
        "SHIP_JOB_TRIGGER_INVALID",
        `schedule trigger tz ${JSON.stringify(tz)} is not a known IANA time zone`,
        jobId,
        "trigger.tz",
      );
    }
    return;
  }
  if (kind === "interval") {
    if (!isPositiveInteger(Reflect.get(trigger, "everyMs"))) {
      fail(
        "SHIP_JOB_TRIGGER_INVALID",
        "interval trigger everyMs must be a positive integer",
        jobId,
        "trigger.everyMs",
      );
    }
    return;
  }
  if (kind === "enqueue") return;
  if (kind === "http") {
    if (!isOperationAccess(Reflect.get(trigger, "access"))) {
      fail(
        "SHIP_JOB_TRIGGER_INVALID",
        "http trigger access must be an access declaration created by the kernel helpers",
        jobId,
        "trigger.access",
      );
    }
    return;
  }
  fail(
    "SHIP_JOB_TRIGGER_INVALID",
    "trigger kind must be schedule, interval, enqueue, or http",
    jobId,
    "trigger.kind",
  );
}

function assertConcurrency(
  concurrency: unknown,
  jobId: string,
): asserts concurrency is JobConcurrency {
  if (typeof concurrency !== "object" || concurrency === null) {
    fail(
      "SHIP_JOB_CONCURRENCY_INVALID",
      "concurrency must declare mode single-runner or parallel",
      jobId,
      "concurrency",
    );
  }
  const mode = Reflect.get(concurrency, "mode");
  const max = Reflect.get(concurrency, "max");
  const key = Reflect.get(concurrency, "key");
  const reason = Reflect.get(concurrency, "reason");
  const leaseMs = Reflect.get(concurrency, "leaseMs");
  if (
    (mode !== "single-runner" && mode !== "parallel") ||
    (max !== undefined && !isPositiveInteger(max)) ||
    (key !== undefined && typeof key !== "function") ||
    (reason !== undefined && (typeof reason !== "string" || reason.trim().length === 0)) ||
    (leaseMs !== undefined && !isPositiveInteger(leaseMs))
  ) {
    fail(
      "SHIP_JOB_CONCURRENCY_INVALID",
      "concurrency must declare mode single-runner or parallel with optional positive max, key(input), non-empty reason and positive leaseMs",
      jobId,
      "concurrency",
    );
  }
  if (mode === "single-runner" && key === undefined && reason === undefined) {
    fail(
      "SHIP_JOB_SINGLE_RUNNER_REASON_REQUIRED",
      `job ${JSON.stringify(jobId)} is a single-runner without a key; declare concurrency.key(input) or justify one global runner with concurrency.reason`,
      jobId,
      "concurrency.reason",
    );
  }
}

function assertRetry(retry: unknown, jobId: string): asserts retry is JobRetry {
  if (typeof retry !== "object" || retry === null) {
    fail("SHIP_JOB_RETRY_INVALID", "retry must declare attempts and backoff", jobId, "retry");
  }
  const attempts = Reflect.get(retry, "attempts");
  if (attempts === undefined) {
    fail(
      "SHIP_JOB_RETRY_ATTEMPTS_REQUIRED",
      `job ${JSON.stringify(jobId)} declares no retry.attempts; bound retries explicitly so failed runs dead-letter instead of retrying forever`,
      jobId,
      "retry.attempts",
    );
  }
  if (!isPositiveInteger(attempts)) {
    fail(
      "SHIP_JOB_RETRY_INVALID",
      "retry.attempts must be a positive integer",
      jobId,
      "retry.attempts",
    );
  }
  const backoff = Reflect.get(retry, "backoff");
  const multiplier =
    typeof backoff === "object" && backoff !== null
      ? Reflect.get(backoff, "multiplier")
      : undefined;
  const maxMs =
    typeof backoff === "object" && backoff !== null ? Reflect.get(backoff, "maxMs") : undefined;
  if (
    typeof backoff !== "object" ||
    backoff === null ||
    !isNonNegativeInteger(Reflect.get(backoff, "initialMs")) ||
    (multiplier !== undefined && !(typeof multiplier === "number" && multiplier >= 1)) ||
    (maxMs !== undefined && !isPositiveInteger(maxMs))
  ) {
    fail(
      "SHIP_JOB_RETRY_INVALID",
      "retry.backoff must declare initialMs with optional multiplier (>= 1) and maxMs",
      jobId,
      "retry.backoff",
    );
  }
}

function assertManagementOptions(options: unknown): asserts options is JobManagementOptions {
  const prefix = typeof options === "object" && options !== null && Reflect.get(options, "prefix");
  const clock = typeof options === "object" && options !== null && Reflect.get(options, "clock");
  if (
    typeof options !== "object" ||
    options === null ||
    (prefix !== undefined && (typeof prefix !== "string" || !/^[a-z][a-z0-9-]*$/u.test(prefix))) ||
    (clock !== undefined && typeof clock !== "function")
  ) {
    throw new InvalidJobDefinitionError(
      "SHIP_JOB_MANAGEMENT_OPTIONS_INVALID",
      "job management options must provide a lowercase single-segment prefix and an optional clock function",
      { field: "options" },
    );
  }
}

function assertCleanupOptions(options: unknown): asserts options is JobCleanupOptions {
  if (typeof options !== "object" || options === null) {
    throw new InvalidJobDefinitionError(
      "SHIP_JOB_CLEANUP_OPTIONS_INVALID",
      "job cleanup options must be an object",
      { field: "options" },
    );
  }
  const id = Reflect.get(options, "id");
  if (id !== undefined && (typeof id !== "string" || !JOB_ID_PATTERN.test(id))) {
    throw new InvalidJobDefinitionError(
      "SHIP_JOB_CLEANUP_OPTIONS_INVALID",
      "job cleanup id must contain at least two lowercase dot-separated segments",
      { field: "id" },
    );
  }
  const trigger = Reflect.get(options, "trigger");
  const kind =
    typeof trigger === "object" && trigger !== null ? Reflect.get(trigger, "kind") : undefined;
  if (kind !== "schedule" && kind !== "interval") {
    throw new InvalidJobDefinitionError(
      "SHIP_JOB_CLEANUP_OPTIONS_INVALID",
      "job cleanup trigger must be a schedule or interval trigger",
      { field: "trigger" },
    );
  }
  const outboxes = Reflect.get(options, "outboxes");
  if (outboxes !== undefined) {
    if (!Array.isArray(outboxes) || !outboxes.every((item) => isOutbox(item))) {
      throw new InvalidJobDefinitionError(
        "SHIP_JOB_CLEANUP_OPTIONS_INVALID",
        "job cleanup outboxes must contain only defineOutbox() results",
        { field: "outboxes" },
      );
    }
    for (const outbox of outboxes as AnyOutbox[]) {
      if (!outbox.retention) {
        throw new InvalidJobDefinitionError(
          "SHIP_JOB_CLEANUP_OPTIONS_INVALID",
          `outbox ${JSON.stringify(outbox.id)} declares no retention; add retention before sweeping it from the cleanup job`,
          { field: "outboxes" },
        );
      }
    }
  }
  const clock = Reflect.get(options, "clock");
  if (clock !== undefined && typeof clock !== "function") {
    throw new InvalidJobDefinitionError(
      "SHIP_JOB_CLEANUP_OPTIONS_INVALID",
      "job cleanup clock must be a function",
      { field: "clock" },
    );
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function fail(
  code: JobDefinitionDiagnosticCode,
  message: string,
  jobId?: string,
  field?: string,
): never {
  throw new InvalidJobDefinitionError(code, message, { jobId, field });
}
