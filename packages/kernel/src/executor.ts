import type { OperationActor, OperationActorInput, OperationIdentity } from "./actor.js";
import { isOperationActor, isOperationIdentity, normalizeOperationActor } from "./actor.js";
import type { CompiledApplication } from "./application.js";
import { isAttachmentCapability, isAttachmentDependencyToken } from "./attachment.js";
import type { CacheBackend } from "./cache.js";
import {
  cacheScopeKey,
  canonicalJson,
  createSingleFlight,
  deriveCacheKey,
  isCacheBackend,
  isCacheBackendDependencyToken,
  isCachedOperationResult,
  scopedCacheTag,
} from "./cache.js";
import { CACHE_INVALIDATION_INTENT_ID, cacheInvalidationOutbox } from "./cache-invalidation.js";
import {
  type DependencyBindings,
  type DependencyToken,
  isUnitOfWork,
  isUnitOfWorkDependencyToken,
} from "./dependency.js";
import type { IdempotencyStore, StoredIdempotentResult } from "./idempotency.js";
import { isIdempotencyStore, isStoredIdempotentResult } from "./idempotency.js";
import type { LockLease, LockProvider } from "./job.js";
import {
  createJobEnqueuer,
  isJob,
  isJobBackend,
  isJobDependencyToken,
  isJobEnqueueDependencyToken,
  isLockProvider,
  JOB_BACKEND_ID,
  JOB_INPUT_LOCATION,
  JOB_LOCK_PROVIDER_ID,
} from "./job.js";
import type { AnyModule } from "./module.js";
import type {
  AnyOperation,
  InferOperationOutputs,
  InferOperationRawInput,
  OperationInputSchemas,
  OperationOutputSchemas,
  OperationStream,
} from "./operation.js";
import { isExplicitOperationResponse } from "./operation.js";
import type { OperationErrorDefinition, OperationErrorDetails } from "./operation-error.js";
import { OperationFailure, validateOperationFailureHeaders } from "./operation-error.js";
import { createOutboxWriter, isOutboxBackend, isOutboxDependencyToken } from "./outbox.js";
import type { AnyProvider } from "./provider.js";
import { isChannelPublicationToken } from "./realtime.js";
import {
  createOutboxChannelPublisher,
  findRealtimePublicationOutbox,
} from "./realtime-publication.js";
import type { RuntimeSchema, SchemaIssue } from "./schema.js";
import { isTenantScope } from "./tenant.js";

export interface OperationRunOptions {
  /** An actor without `kind` (built on ship-core 1.0) runs as a human actor. */
  readonly actor?: OperationActorInput;
  readonly identity?: OperationIdentity;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
  /** Receives validated frames from a streaming operation; required for stream operations. */
  readonly stream?: OperationStreamSink;
}

/** Adapter-owned frame receiver. `write` resolves once the frame has been accepted downstream. */
export interface OperationStreamSink {
  readonly write: (frame: unknown) => void | Promise<void>;
}

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code?: string;
}

export interface OperationSuccessResult<TStatus extends number = number, TData = unknown> {
  readonly ok: true;
  readonly status: TStatus;
  readonly data: TData;
  readonly requestId: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Present only on operations that declare a read cache. */
  readonly cache?: "hit" | "miss";
  /** Present when the executor replayed a stored idempotent result instead of running the handler. */
  readonly replayed?: true;
}

export interface OperationErrorPayload<TCode extends string = string, TDetails = unknown> {
  readonly code: TCode;
  readonly message: string;
  readonly details?: TDetails;
}

export interface OperationFailureResult<
  TStatus extends number = number,
  TCode extends string = string,
  TDetails = unknown,
> {
  readonly ok: false;
  readonly status: TStatus;
  readonly error: OperationErrorPayload<TCode, TDetails>;
  readonly requestId: string;
  /** Only headers declared by the matching application error may appear here. */
  readonly headers?: Readonly<Record<string, string>>;
}

export type FrameworkOperationFailure =
  | OperationFailureResult<400, "VALIDATION_ERROR", { readonly issues: readonly ValidationIssue[] }>
  | OperationFailureResult<401, "AUTHENTICATION_ERROR">
  | OperationFailureResult<
      403,
      "AUTHORIZATION_ERROR",
      {
        readonly requiredPermissions: readonly string[];
        readonly requiredActorKind?: "system" | "provider";
      }
    >
  | OperationFailureResult<409, "IDEMPOTENT_IN_FLIGHT", { readonly idempotencyKey: string }>
  | OperationFailureResult<409, "JOB_LOCK_HELD", { readonly jobId: string; readonly key: string }>;

type OperationFromApp<
  TApp extends CompiledApplication<string, readonly AnyModule[]>,
  TId extends keyof TApp["operationById"],
> = TApp["operationById"][TId];

export type OperationId<TApp extends CompiledApplication<string, readonly AnyModule[]>> = Extract<
  keyof TApp["operationById"],
  string
>;

export type OperationRawInput<TOperation> = TOperation extends {
  readonly input: infer TInput extends OperationInputSchemas;
}
  ? InferOperationRawInput<TInput>
  : never;

type OperationSuccessResults<TOperation> = TOperation extends {
  readonly output: infer TOutput extends OperationOutputSchemas;
}
  ? {
      [TStatus in keyof InferOperationOutputs<TOutput>]: TStatus extends number
        ? OperationSuccessResult<TStatus, InferOperationOutputs<TOutput>[TStatus]>
        : never;
    }[keyof InferOperationOutputs<TOutput>]
  : never;

type DeclaredFailureResult<TError> =
  TError extends OperationErrorDefinition<infer TCode, infer TStatus, infer _TDetails>
    ? OperationFailureResult<TStatus, TCode, OperationErrorDetails<TError>>
    : never;

type OperationDeclaredFailures<TOperation> = TOperation extends {
  readonly errors: infer TErrors extends readonly OperationErrorDefinition[];
}
  ? DeclaredFailureResult<TErrors[number]>
  : never;

export type OperationExecutionResult<TOperation> =
  | OperationSuccessResults<TOperation>
  | OperationDeclaredFailures<TOperation>
  | FrameworkOperationFailure;

/**
 * The result `tryRun()` returns where `run()` would have thrown: the same
 * `500 INTERNAL_SERVER_ERROR` envelope the HTTP adapter answers with, plus the
 * typed {@link OperationExecutionError} for logging. `details` carries only
 * the diagnostic code and operation id; the cause never reaches a client.
 */
export interface OperationExecutionFailure
  extends OperationFailureResult<
    500,
    "INTERNAL_SERVER_ERROR",
    { readonly code: OperationExecutionDiagnosticCode; readonly operationId: string }
  > {
  readonly cause: OperationExecutionError;
}

export interface ApplicationExecutor<
  TApp extends CompiledApplication<string, readonly AnyModule[]>,
> {
  /**
   * Executes an operation. Declared outcomes (successes, declared failures,
   * access and validation failures) come back as results. Anything else, an
   * unexpected handler throw, a provider that failed to initialize, an
   * undeclared error, an aborted signal, is a framework defect or an
   * infrastructure fault and is thrown as a typed
   * {@link OperationExecutionError} so it reaches the caller's error path.
   */
  run<TId extends OperationId<TApp>>(
    operationId: TId,
    input: OperationRawInput<OperationFromApp<TApp, TId>>,
    options?: OperationRunOptions,
  ): Promise<OperationExecutionResult<OperationFromApp<TApp, TId>>>;
  /**
   * `run()` for call sites that have no error path of their own, such as a
   * legacy bridge that must answer every call with a result. The typed throw
   * is returned as an {@link OperationExecutionFailure} carrying the HTTP
   * adapter's 500 envelope and the original error; nothing else changes.
   */
  tryRun<TId extends OperationId<TApp>>(
    operationId: TId,
    input: OperationRawInput<OperationFromApp<TApp, TId>>,
    options?: OperationRunOptions,
  ): Promise<OperationExecutionResult<OperationFromApp<TApp, TId>> | OperationExecutionFailure>;
}

/** Shapes a thrown execution error as the 500 envelope the HTTP adapter answers with. */
export function operationExecutionFailure(
  error: OperationExecutionError,
  requestId: string,
): OperationExecutionFailure {
  return Object.freeze({
    ok: false as const,
    status: 500 as const,
    error: Object.freeze({
      code: "INTERNAL_SERVER_ERROR" as const,
      message: "An unexpected error occurred",
      details: Object.freeze({ code: error.code, operationId: error.operationId }),
    }),
    requestId,
    cause: error,
  });
}

export type OperationExecutionDiagnosticCode =
  | "SHIP_OPERATION_NOT_FOUND"
  | "SHIP_OPERATION_ABORTED"
  | "SHIP_OPERATION_CONTEXT_INVALID"
  | "SHIP_PROVIDER_NOT_FOUND"
  | "SHIP_PROVIDER_INITIALIZATION_FAILED"
  | "SHIP_OPERATION_UNIT_OF_WORK_INVALID"
  | "SHIP_OPERATION_UNIT_OF_WORK_SCOPE_MISSING"
  | "SHIP_OPERATION_TRANSACTION_FAILED"
  | "SHIP_OPERATION_INPUT_SCHEMA_FAILED"
  | "SHIP_OPERATION_RESPONSE_STATUS_UNDECLARED"
  | "SHIP_OPERATION_OUTPUT_SCHEMA_FAILED"
  | "SHIP_OPERATION_OUTPUT_INVALID"
  | "SHIP_OPERATION_ERROR_UNDECLARED"
  | "SHIP_OPERATION_ERROR_SCHEMA_FAILED"
  | "SHIP_OPERATION_ERROR_DETAILS_INVALID"
  | "SHIP_OPERATION_ERROR_HEADERS_INVALID"
  | "SHIP_OPERATION_IDEMPOTENCY_KEY_INVALID"
  | "SHIP_OPERATION_IDEMPOTENCY_STORE_INVALID"
  | "SHIP_OPERATION_IDEMPOTENCY_RESULT_MISSING"
  | "SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE"
  | "SHIP_OPERATION_OUTBOX_BACKEND_INVALID"
  | "SHIP_OPERATION_OUTBOX_SCOPE_MISSING"
  | "SHIP_OPERATION_ATTACHMENT_CAPABILITY_INVALID"
  | "SHIP_OPERATION_PUBLICATION_OUTBOX_MISSING"
  | "SHIP_OPERATION_CACHE_BACKEND_INVALID"
  | "SHIP_OPERATION_CACHE_KEY_INVALID"
  | "SHIP_OPERATION_CACHE_TENANT_INVALID"
  | "SHIP_OPERATION_CACHE_ACTOR_INVALID"
  | "SHIP_OPERATION_CACHE_INVALIDATION_BACKEND_INVALID"
  | "SHIP_OPERATION_JOB_BACKEND_INVALID"
  | "SHIP_OPERATION_JOB_LOCK_PROVIDER_INVALID"
  | "SHIP_OPERATION_JOB_KEY_INVALID"
  | "SHIP_OPERATION_HANDLER_FAILED"
  | "SHIP_OPERATION_STREAM_SINK_MISSING"
  | "SHIP_OPERATION_STREAM_FRAME_SCHEMA_FAILED"
  | "SHIP_OPERATION_STREAM_FRAME_INVALID"
  | "SHIP_OPERATION_STREAM_CLOSED";

export class OperationExecutionError extends Error {
  readonly code: OperationExecutionDiagnosticCode;
  readonly operationId: string;
  readonly providerId?: string;
  readonly issues?: readonly ValidationIssue[];

  constructor(
    code: OperationExecutionDiagnosticCode,
    message: string,
    options: {
      readonly operationId: string;
      readonly providerId?: string;
      readonly issues?: readonly ValidationIssue[];
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "OperationExecutionError";
    this.code = code;
    this.operationId = options.operationId;
    this.providerId = options.providerId;
    this.issues = options.issues;
  }
}

export function createExecutor<
  const TApp extends CompiledApplication<string, readonly AnyModule[]>,
>(app: TApp): ApplicationExecutor<TApp> {
  const singletonProviders = new Map<string, Promise<unknown>>();
  const operationVersions = new Map<string, Promise<string>>();
  const localSingleFlight = createSingleFlight();

  const run = async (
    operationId: string,
    rawInput: unknown,
    options: OperationRunOptions = {},
  ): Promise<OperationSuccessResult | OperationFailureResult> => {
    const operation = Reflect.get(app.operationById, operationId) as AnyOperation | undefined;
    if (!operation) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_NOT_FOUND",
        `operation ${JSON.stringify(operationId)} is not part of application ${JSON.stringify(app.id)}`,
        { operationId },
      );
    }

    throwIfAborted(operationId, options.signal);
    if (options.identity !== undefined && !isOperationIdentity(options.identity)) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_CONTEXT_INVALID",
        `operation ${JSON.stringify(operationId)} received an invalid verified identity`,
        { operationId },
      );
    }
    const requestId = options.requestId?.trim() || globalThis.crypto.randomUUID();
    // Normalise before the access check so a kind-less actor is a human actor
    // rather than "unauthenticated". An unrecognisable value stays as given and
    // fails the check exactly as before.
    const actor =
      options.actor === undefined
        ? undefined
        : (normalizeOperationActor(options.actor) ?? (options.actor as OperationActor));
    const accessFailure = checkOperationAccess(operation, actor, requestId);
    if (accessFailure) return accessFailure;

    const parsedInput = await parseInput(operation, rawInput);
    if (!parsedInput.ok) return { ...parsedInput.failure, requestId };
    throwIfAborted(operationId, options.signal);

    const stream = createStreamArguments(operation, options);
    const operationProviders = new Map<string, Promise<unknown>>();
    const context = Object.freeze({
      requestId,
      ...(actor ? { actor } : {}),
      ...(options.identity ? { identity: options.identity } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const lock = await acquireJobLock(
      app,
      operation,
      parsedInput.value,
      operationProviders,
      singletonProviders,
    );
    if (lock?.status === "held") {
      return Object.freeze({
        ok: false as const,
        status: 409 as const,
        error: Object.freeze({
          code: "JOB_LOCK_HELD" as const,
          message: "Another runner holds the lock for this job key",
          details: Object.freeze({ jobId: operation.id, key: lock.key }),
        }),
        requestId,
      });
    }

    try {
      return await runOperation(operation, parsedInput.value, context, operationProviders, stream);
    } finally {
      if (lock?.status === "acquired") await lock.release();
    }
  };

  const runOperation = async (
    operation: AnyOperation,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<{
      requestId: string;
      actor?: OperationActor;
      identity?: OperationIdentity;
      signal?: AbortSignal;
    }>,
    operationProviders: Map<string, Promise<unknown>>,
    stream: StreamArguments | undefined,
  ): Promise<OperationSuccessResult | OperationFailureResult> => {
    const operationId = operation.id;
    const requestId = context.requestId;
    const parsedInput = { value: input };
    try {
      const idempotency = await prepareIdempotency(
        app,
        operation,
        parsedInput.value,
        operationProviders,
        singletonProviders,
      );

      const runOperation = async (): Promise<OperationSuccessResult | OperationFailureResult> => {
        if (operation.transaction === "none") {
          return await runWithIdempotency(operation, idempotency, undefined, requestId, () =>
            invokeOperation(
              app,
              operation,
              parsedInput.value,
              context,
              operationProviders,
              singletonProviders,
              undefined,
              stream,
            ),
          );
        }

        const unitOfWorkToken = Object.values(operation.dependencies).find((token) =>
          isUnitOfWorkDependencyToken(token),
        );
        if (!unitOfWorkToken) {
          throw new OperationExecutionError(
            "SHIP_OPERATION_UNIT_OF_WORK_SCOPE_MISSING",
            `transactional operation ${JSON.stringify(operation.id)} has no unit-of-work dependency after compilation`,
            { operationId: operation.id },
          );
        }
        const controller = await resolveProvider(
          app,
          operation,
          unitOfWorkToken.id,
          operationProviders,
          singletonProviders,
        );
        if (!isUnitOfWork(controller) || controller.id !== unitOfWorkToken.id) {
          throw new OperationExecutionError(
            "SHIP_OPERATION_UNIT_OF_WORK_INVALID",
            `provider ${JSON.stringify(unitOfWorkToken.id)} did not create its declared unit-of-work controller`,
            { operationId: operation.id, providerId: unitOfWorkToken.id },
          );
        }

        try {
          return await controller.run(operation.transaction, (capabilities) =>
            runWithIdempotency(
              operation,
              idempotency,
              capabilities as object,
              requestId,
              async () => {
                const result = await invokeOperation(
                  app,
                  operation,
                  parsedInput.value,
                  context,
                  operationProviders,
                  singletonProviders,
                  new Map([[unitOfWorkToken.id, capabilities]]),
                  stream,
                );
                // Inside the transaction: the purge intent commits with the
                // change it describes, and a rollback leaves no intent.
                await recordCacheInvalidation(
                  app,
                  operation,
                  parsedInput.value,
                  context,
                  capabilities as object,
                  operationProviders,
                  singletonProviders,
                );
                return result;
              },
            ),
          );
        } catch (error) {
          if (error instanceof OperationExecutionError || error instanceof OperationFailure) {
            throw error;
          }
          throw new OperationExecutionError(
            "SHIP_OPERATION_TRANSACTION_FAILED",
            `transaction failed while running operation ${JSON.stringify(operation.id)}`,
            { operationId: operation.id, providerId: unitOfWorkToken.id, cause: error },
          );
        }
      };

      const cache = await prepareCache(
        app,
        operation,
        parsedInput.value,
        context,
        operationProviders,
        singletonProviders,
        operationVersions,
      );
      if (!cache) return await runOperation();

      const stored = await cache.backend.get(cache.key);
      if (isCachedOperationResult(stored)) {
        return Object.freeze({
          ok: true as const,
          status: stored.status,
          data: stored.data,
          requestId,
          ...(stored.headers ? { headers: stored.headers } : {}),
          cache: "hit" as const,
        });
      }
      const gate = cache.backend.singleFlight
        ? cache.backend.singleFlight.bind(cache.backend)
        : localSingleFlight;
      return await gate(cache.key, async () => {
        const result = await runOperation();
        // Only declared successes are stored; a declared failure raises
        // OperationFailure and never reaches this point.
        if (!result.ok) return result;
        await cache.backend.set(
          cache.key,
          {
            status: result.status,
            data: result.data,
            ...(result.headers ? { headers: result.headers } : {}),
          },
          { ttlMs: cache.ttlMs, ...(cache.tags.length > 0 ? { tags: cache.tags } : {}) },
        );
        return Object.freeze({ ...result, cache: "miss" as const });
      });
    } catch (error) {
      if (error instanceof OperationExecutionError) throw error;
      if (error instanceof OperationFailure) {
        return handleDeclaredFailure(operation, error, requestId);
      }
      throw new OperationExecutionError(
        "SHIP_OPERATION_HANDLER_FAILED",
        `operation ${JSON.stringify(operationId)} handler failed`,
        { operationId, cause: error },
      );
    }
  };

  const tryRun = async (
    operationId: string,
    rawInput: unknown,
    options: OperationRunOptions = {},
  ): Promise<OperationSuccessResult | OperationFailureResult | OperationExecutionFailure> => {
    // Settle the request id here so the failure envelope and the run agree on it.
    const requestId = options.requestId?.trim() || globalThis.crypto.randomUUID();
    try {
      return await run(operationId, rawInput, { ...options, requestId });
    } catch (error) {
      if (error instanceof OperationExecutionError) {
        return operationExecutionFailure(error, requestId);
      }
      throw error;
    }
  };

  return Object.freeze({ run, tryRun }) as ApplicationExecutor<TApp>;
}

async function invokeOperation(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  input: Readonly<Record<string, unknown>>,
  context: Readonly<{
    requestId: string;
    actor?: OperationActor;
    identity?: OperationIdentity;
    signal?: AbortSignal;
  }>,
  operationProviders: Map<string, Promise<unknown>>,
  singletonProviders: Map<string, Promise<unknown>>,
  scopedCapabilities?: ReadonlyMap<string, unknown>,
  stream?: StreamArguments,
): Promise<OperationSuccessResult> {
  const services = await resolveBindings(
    app,
    operation,
    operation.dependencies,
    operationProviders,
    singletonProviders,
    scopedCapabilities,
  );
  throwIfAborted(operation.id, context.signal);

  const handler = operation.handler as (arguments_: {
    readonly input: Readonly<Record<string, unknown>>;
    readonly services: Readonly<Record<string, unknown>>;
    readonly context: typeof context;
    readonly stream?: OperationStream;
  }) => unknown | Promise<unknown>;
  let handlerResult: unknown;
  try {
    handlerResult = await handler({
      input,
      services,
      context,
      ...(stream ? { stream: stream.handlerStream } : {}),
    });
  } catch (error) {
    if (error instanceof OperationExecutionError || error instanceof OperationFailure) throw error;
    throw new OperationExecutionError(
      "SHIP_OPERATION_HANDLER_FAILED",
      `operation ${JSON.stringify(operation.id)} handler failed`,
      { operationId: operation.id, cause: error },
    );
  } finally {
    stream?.close();
  }
  throwIfAborted(operation.id, context.signal);
  const result = await validateSuccess(operation, handlerResult, context.requestId);
  throwIfAborted(operation.id, context.signal);
  return result;
}

interface StreamArguments {
  readonly handlerStream: OperationStream;
  readonly close: () => void;
}

function createStreamArguments(
  operation: AnyOperation,
  options: OperationRunOptions,
): StreamArguments | undefined {
  const response = operation.transport?.response;
  if (response?.mode !== "stream") {
    if (options.stream !== undefined) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_CONTEXT_INVALID",
        `operation ${JSON.stringify(operation.id)} received a stream sink but does not declare a streaming response`,
        { operationId: operation.id },
      );
    }
    return undefined;
  }
  const sink = options.stream;
  if (typeof sink?.write !== "function") {
    throw new OperationExecutionError(
      "SHIP_OPERATION_STREAM_SINK_MISSING",
      `streaming operation ${JSON.stringify(operation.id)} requires a stream sink`,
      { operationId: operation.id },
    );
  }
  const signal = options.signal ?? new AbortController().signal;
  let closed = false;
  const emit = async (frame: unknown): Promise<void> => {
    if (closed) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_STREAM_CLOSED",
        `operation ${JSON.stringify(operation.id)} emitted a frame after its handler returned`,
        { operationId: operation.id },
      );
    }
    let result;
    try {
      result = await response.frame["~standard"].validate(frame);
    } catch (error) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_STREAM_FRAME_SCHEMA_FAILED",
        `frame schema threw while validating operation ${JSON.stringify(operation.id)}`,
        { operationId: operation.id, cause: error },
      );
    }
    if ("issues" in result && result.issues !== undefined) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_STREAM_FRAME_INVALID",
        `operation ${JSON.stringify(operation.id)} emitted a frame that does not match its frame schema`,
        { operationId: operation.id, issues: result.issues.map((issue) => normalizeIssue(issue)) },
      );
    }
    await sink.write(result.value);
  };
  return {
    handlerStream: Object.freeze({ emit, signal }),
    close: () => {
      closed = true;
    },
  };
}

export function checkOperationAccess(
  operation: AnyOperation,
  actor: OperationActor | undefined,
  requestId: string,
): FrameworkOperationFailure | undefined {
  if (operation.access.kind === "public" || operation.access.kind === "optional-identity") {
    return undefined;
  }
  if (!isOperationActor(actor)) {
    return {
      ok: false,
      status: 401,
      error: { code: "AUTHENTICATION_ERROR", message: "Authentication required" },
      requestId,
    };
  }
  if (operation.access.kind === "authenticated") return undefined;
  if (operation.access.kind === "system") {
    return actor.kind === "system" ? undefined : kindDenied(operation, requestId);
  }
  if (operation.access.kind === "provider") {
    return actor.kind === "provider" && actor.provider === operation.access.provider
      ? undefined
      : kindDenied(operation, requestId);
  }

  const permissions = actor.permissions ?? new Set<string>();
  const allowed =
    operation.access.mode === "all"
      ? operation.access.permissions.every((permission) => permissions.has(permission))
      : operation.access.permissions.some((permission) => permissions.has(permission));
  if (allowed) return undefined;

  return {
    ok: false,
    status: 403,
    error: {
      code: "AUTHORIZATION_ERROR",
      message: "Permission denied",
      details: { requiredPermissions: operation.access.permissions },
    },
    requestId,
  };
}

function kindDenied(operation: AnyOperation, requestId: string): FrameworkOperationFailure {
  const access = operation.access as { readonly kind: "system" | "provider" };
  return {
    ok: false,
    status: 403,
    error: {
      code: "AUTHORIZATION_ERROR",
      message: `Operation requires a ${access.kind} actor`,
      details: { requiredPermissions: [], requiredActorKind: access.kind },
    },
    requestId,
  };
}

async function parseInput(
  operation: AnyOperation,
  rawInput: unknown,
): Promise<
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly failure: Omit<FrameworkOperationFailure, "requestId"> }
> {
  const issues: ValidationIssue[] = [];
  const parsed: Record<string, unknown> = {};
  const inputRecord = isRecord(rawInput) ? rawInput : {};

  if (!isRecord(rawInput)) {
    issues.push({ path: [], message: "Operation input must be an object", code: "invalid_type" });
  } else {
    for (const key of Object.keys(rawInput).sort()) {
      if (!Object.hasOwn(operation.input, key)) {
        issues.push({
          path: [key],
          message: `Unknown operation input location ${JSON.stringify(key)}`,
          code: "unrecognized_location",
        });
      }
    }
  }

  for (const [name, schema] of Object.entries(operation.input).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    let result;
    try {
      result = await schema["~standard"].validate(Reflect.get(inputRecord, name));
    } catch (error) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_INPUT_SCHEMA_FAILED",
        `input schema ${JSON.stringify(name)} threw while validating operation ${JSON.stringify(operation.id)}`,
        { operationId: operation.id, cause: error },
      );
    }

    if ("issues" in result && result.issues !== undefined) {
      issues.push(...result.issues.map((issue) => normalizeIssue(issue, name)));
    } else {
      parsed[name] = result.value;
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 400,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: { issues: Object.freeze(issues) },
        },
      },
    };
  }

  return { ok: true, value: Object.freeze(parsed) };
}

async function validateSuccess(
  operation: AnyOperation,
  handlerResult: unknown,
  requestId: string,
): Promise<OperationSuccessResult> {
  const explicit = isExplicitOperationResponse(handlerResult);
  const status = explicit ? handlerResult.status : operation.successStatus;
  const body = explicit ? handlerResult.body : handlerResult;
  const schema = Reflect.get(operation.output, status) as RuntimeSchema | undefined;

  if (!schema) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_RESPONSE_STATUS_UNDECLARED",
      `operation ${JSON.stringify(operation.id)} returned undeclared success status ${status}`,
      { operationId: operation.id },
    );
  }

  if (operation.transport?.metadata?.response === "redirect") {
    const location = explicit ? handlerResult.headers?.location : undefined;
    if (body !== undefined || !isSafeRedirectLocation(location)) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_OUTPUT_INVALID",
        `operation ${JSON.stringify(operation.id)} must return an empty redirect with a safe Location header`,
        { operationId: operation.id },
      );
    }
  }

  let result;
  try {
    result = await schema["~standard"].validate(body);
  } catch (error) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_OUTPUT_SCHEMA_FAILED",
      `output schema for status ${status} threw while validating operation ${JSON.stringify(operation.id)}`,
      { operationId: operation.id, cause: error },
    );
  }
  if ("issues" in result && result.issues !== undefined) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_OUTPUT_INVALID",
      `operation ${JSON.stringify(operation.id)} returned data that does not match status ${status}`,
      {
        operationId: operation.id,
        issues: result.issues.map((issue) => normalizeIssue(issue)),
      },
    );
  }
  if (operation.transport?.metadata?.response === "redirect" && result.value !== undefined) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_OUTPUT_INVALID",
      `operation ${JSON.stringify(operation.id)} redirect schema must produce no body`,
      { operationId: operation.id },
    );
  }

  return Object.freeze({
    ok: true,
    status,
    data: result.value,
    requestId,
    ...(explicit && handlerResult.headers ? { headers: handlerResult.headers } : {}),
  });
}

function isSafeRedirectLocation(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return false;
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

async function handleDeclaredFailure(
  operation: AnyOperation,
  failure: OperationFailure,
  requestId: string,
): Promise<OperationFailureResult> {
  const definition = operation.errors.find((candidate) => candidate.code === failure.code);
  if (!definition) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_ERROR_UNDECLARED",
      `operation ${JSON.stringify(operation.id)} raised undeclared error ${JSON.stringify(failure.code)}`,
      { operationId: operation.id, cause: failure },
    );
  }
  if (failure.definition.status !== definition.status) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_ERROR_UNDECLARED",
      `operation ${JSON.stringify(operation.id)} raised error ${JSON.stringify(failure.code)} with an undeclared status`,
      { operationId: operation.id, cause: failure },
    );
  }

  let headers: Readonly<Record<string, string>> | undefined;
  try {
    headers = validateOperationFailureHeaders(definition, failure.headers);
  } catch (error) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_ERROR_HEADERS_INVALID",
      `operation ${JSON.stringify(operation.id)} raised ${JSON.stringify(failure.code)} with invalid headers`,
      { operationId: operation.id, cause: error },
    );
  }

  let details: unknown;
  if (definition.details) {
    let result;
    try {
      result = await definition.details["~standard"].validate(failure.details);
    } catch (error) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_ERROR_SCHEMA_FAILED",
        `details schema for ${JSON.stringify(failure.code)} threw while validating operation ${JSON.stringify(operation.id)}`,
        { operationId: operation.id, cause: error },
      );
    }
    if ("issues" in result && result.issues !== undefined) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_ERROR_DETAILS_INVALID",
        `operation ${JSON.stringify(operation.id)} raised ${JSON.stringify(failure.code)} with invalid details`,
        {
          operationId: operation.id,
          issues: result.issues.map((issue) => normalizeIssue(issue)),
          cause: failure,
        },
      );
    }
    details = result.value;
  }

  return Object.freeze({
    ok: false,
    status: definition.status,
    error: Object.freeze({
      code: definition.code,
      message: failure.message,
      ...(definition.details ? { details } : {}),
    }),
    requestId,
    ...(headers ? { headers } : {}),
  });
}

async function resolveBindings(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  bindings: DependencyBindings,
  operationProviders: Map<string, Promise<unknown>>,
  singletonProviders: Map<string, Promise<unknown>>,
  scopedCapabilities?: ReadonlyMap<string, unknown>,
): Promise<Readonly<Record<string, unknown>>> {
  const services: Record<string, unknown> = {};
  for (const [name, token] of Object.entries(bindings)) {
    if (isUnitOfWorkDependencyToken(token)) {
      if (!scopedCapabilities?.has(token.id)) {
        throw new OperationExecutionError(
          "SHIP_OPERATION_UNIT_OF_WORK_SCOPE_MISSING",
          `transaction capability ${JSON.stringify(token.id)} was requested outside its active unit of work`,
          { operationId: operation.id, providerId: token.id },
        );
      }
      services[name] = scopedCapabilities.get(token.id);
      continue;
    }
    if (isAttachmentDependencyToken(token)) {
      const capability = await resolveProvider(
        app,
        operation,
        token.id,
        operationProviders,
        singletonProviders,
      );
      if (!isAttachmentCapability(capability) || capability.attachmentId !== token.attachmentId) {
        throw new OperationExecutionError(
          "SHIP_OPERATION_ATTACHMENT_CAPABILITY_INVALID",
          `provider ${JSON.stringify(token.id)} did not create an attachment capability for ${JSON.stringify(token.attachmentId)}`,
          { operationId: operation.id, providerId: token.id },
        );
      }
      // The capability joins the running transaction (when there is one) so
      // attach/detach bookkeeping and purge intents commit with the record.
      const scope = scopedCapabilities?.values().next().value;
      services[name] = capability.withScope(
        typeof scope === "object" && scope !== null ? scope : undefined,
      );
      continue;
    }
    if (isJobDependencyToken(token)) {
      if (token.role === "lock") {
        const lockProvider = await resolveProvider(
          app,
          operation,
          token.id,
          operationProviders,
          singletonProviders,
        );
        if (!isLockProvider(lockProvider)) {
          throw new OperationExecutionError(
            "SHIP_OPERATION_JOB_LOCK_PROVIDER_INVALID",
            `provider ${JSON.stringify(token.id)} did not create a lock provider`,
            { operationId: operation.id, providerId: token.id },
          );
        }
        services[name] = lockProvider;
        continue;
      }
      const backend = await resolveProvider(
        app,
        operation,
        JOB_BACKEND_ID,
        operationProviders,
        singletonProviders,
      );
      if (!isJobBackend(backend)) {
        throw new OperationExecutionError(
          "SHIP_OPERATION_JOB_BACKEND_INVALID",
          `provider ${JSON.stringify(JOB_BACKEND_ID)} did not create a job backend`,
          { operationId: operation.id, providerId: JOB_BACKEND_ID },
        );
      }
      services[name] = isJobEnqueueDependencyToken(token)
        ? createJobEnqueuer(token.job, backend)
        : backend;
      continue;
    }
    if (isOutboxDependencyToken(token)) {
      const backend = await resolveProvider(
        app,
        operation,
        token.id,
        operationProviders,
        singletonProviders,
      );
      if (!isOutboxBackend(backend) || backend.outboxId !== token.outbox.id) {
        throw new OperationExecutionError(
          "SHIP_OPERATION_OUTBOX_BACKEND_INVALID",
          `provider ${JSON.stringify(token.id)} did not create an outbox backend for outbox ${JSON.stringify(token.outbox.id)}`,
          { operationId: operation.id, providerId: token.id },
        );
      }
      if (token.role === "backend") {
        services[name] = backend;
        continue;
      }
      const scope = scopedCapabilities?.values().next().value;
      if (typeof scope !== "object" || scope === null) {
        throw new OperationExecutionError(
          "SHIP_OPERATION_OUTBOX_SCOPE_MISSING",
          `outbox writer ${JSON.stringify(token.id)} was requested outside an active write transaction`,
          { operationId: operation.id, providerId: token.id },
        );
      }
      services[name] = createOutboxWriter(token.outbox, backend, scope);
      continue;
    }
    if (isChannelPublicationToken(token) && operation.transaction === "write") {
      services[name] = await resolveOutboxChannelPublisher(
        app,
        operation,
        token,
        scopedCapabilities,
        operationProviders,
        singletonProviders,
      );
      continue;
    }
    services[name] = await resolveProvider(
      app,
      operation,
      token.id,
      operationProviders,
      singletonProviders,
    );
  }
  return Object.freeze(services);
}

/**
 * A write operation publishes through the framework publication outbox: the
 * bound channel token resolves to a publisher that records an intent in the
 * active unit of work instead of the immediate publisher the module provides.
 */
async function resolveOutboxChannelPublisher(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  token: DependencyToken & { readonly channelId: string },
  scopedCapabilities: ReadonlyMap<string, unknown> | undefined,
  operationProviders: Map<string, Promise<unknown>>,
  singletonProviders: Map<string, Promise<unknown>>,
): Promise<unknown> {
  const channel = operation.publishes.find((candidate) => candidate.id === token.channelId);
  const outbox = findRealtimePublicationOutbox(app);
  if (!channel || !outbox) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_PUBLICATION_OUTBOX_MISSING",
      `operation ${JSON.stringify(operation.id)} publishes to ${JSON.stringify(token.channelId)} without a mounted realtime publication module`,
      { operationId: operation.id, providerId: token.id },
    );
  }
  const backend = await resolveProvider(
    app,
    operation,
    outbox.writer.id,
    operationProviders,
    singletonProviders,
  );
  const scope = scopedCapabilities?.values().next().value;
  if (!isOutboxBackend(backend) || backend.outboxId !== outbox.id) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_OUTBOX_BACKEND_INVALID",
      `provider ${JSON.stringify(outbox.writer.id)} did not create the realtime publication outbox backend`,
      { operationId: operation.id, providerId: outbox.writer.id },
    );
  }
  if (typeof scope !== "object" || scope === null) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_OUTBOX_SCOPE_MISSING",
      `publication to ${JSON.stringify(token.channelId)} was requested outside an active write transaction`,
      { operationId: operation.id, providerId: token.id },
    );
  }
  return createOutboxChannelPublisher(channel, createOutboxWriter(outbox, backend, scope));
}

async function resolveProvider(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  providerId: string,
  operationProviders: Map<string, Promise<unknown>>,
  singletonProviders: Map<string, Promise<unknown>>,
): Promise<unknown> {
  const provider = Reflect.get(app.providerById, providerId) as AnyProvider | undefined;
  if (!provider) {
    throw new OperationExecutionError(
      "SHIP_PROVIDER_NOT_FOUND",
      `provider ${JSON.stringify(providerId)} disappeared after application compilation`,
      { operationId: operation.id, providerId },
    );
  }

  const cache = provider.lifetime === "singleton" ? singletonProviders : operationProviders;
  const cached = cache.get(providerId);
  if (cached) return cached;

  const created = (async () => {
    try {
      const services = await resolveBindings(
        app,
        operation,
        provider.dependencies,
        operationProviders,
        singletonProviders,
      );
      const create = provider.create as (arguments_: {
        readonly services: Readonly<Record<string, unknown>>;
      }) => unknown | Promise<unknown>;
      return await create({ services });
    } catch (error) {
      if (error instanceof OperationExecutionError) throw error;
      throw new OperationExecutionError(
        "SHIP_PROVIDER_INITIALIZATION_FAILED",
        `provider ${JSON.stringify(providerId)} failed while running operation ${JSON.stringify(operation.id)}`,
        { operationId: operation.id, providerId, cause: error },
      );
    }
  })();
  cache.set(providerId, created);

  try {
    return await created;
  } catch (error) {
    if (cache.get(providerId) === created) cache.delete(providerId);
    throw error;
  }
}

interface PreparedCache {
  readonly backend: CacheBackend;
  readonly key: string;
  readonly ttlMs: number;
  readonly tags: readonly string[];
}

/**
 * Resolves the declared cache policy into a framework-derived key. The scope
 * component is the actor id, the identifier of an authentic TenantScope, or
 * "public"; a consumer never supplies a raw key.
 */
async function prepareCache(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  input: Readonly<Record<string, unknown>>,
  context: Readonly<{ requestId: string; actor?: OperationActor }>,
  operationProviders: Map<string, Promise<unknown>>,
  singletonProviders: Map<string, Promise<unknown>>,
  versions: Map<string, Promise<string>>,
): Promise<PreparedCache | undefined> {
  const declaration = operation.cache;
  if (!declaration) return undefined;
  // Streams bypass the read cache: frames are delivered to the adapter sink as
  // they are emitted and can never be stored or replayed. compileApp rejects the
  // combination (SHIP_OPERATION_STREAM_CACHE_FORBIDDEN); this guard keeps the
  // executor conservative for any operation graph that bypassed compilation.
  if (operation.transport?.response?.mode === "stream") return undefined;

  const token = Object.values(operation.dependencies).find(isCacheBackendDependencyToken);
  if (!token) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_CACHE_BACKEND_INVALID",
      `cached operation ${JSON.stringify(operation.id)} has no cache backend dependency after compilation`,
      { operationId: operation.id },
    );
  }
  const backend = await resolveProvider(
    app,
    operation,
    token.id,
    operationProviders,
    singletonProviders,
  );
  if (!isCacheBackend(backend)) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_CACHE_BACKEND_INVALID",
      `provider ${JSON.stringify(token.id)} did not create a cache backend`,
      { operationId: operation.id, providerId: token.id },
    );
  }

  let scopeKey: string;
  try {
    if (declaration.scope === "tenant") {
      const tenant = await (
        declaration.tenant as (arguments_: unknown) => unknown | Promise<unknown>
      )({ input, context });
      scopeKey = cacheScopeKey("tenant", tenant as never);
    } else {
      scopeKey = cacheScopeKey(declaration.scope, context.actor);
    }
  } catch (error) {
    if (error instanceof OperationFailure || error instanceof OperationExecutionError) throw error;
    throw new OperationExecutionError(
      "SHIP_OPERATION_CACHE_TENANT_INVALID",
      `operation ${JSON.stringify(operation.id)} could not derive an authentic cache scope`,
      { operationId: operation.id, cause: error },
    );
  }

  let vary: readonly string[] = [];
  if (declaration.vary) {
    const derived = (declaration.vary as (value: unknown, subject: unknown) => unknown)(input, {
      actor: context.actor,
      context,
    });
    if (!Array.isArray(derived) || derived.some((item) => typeof item !== "string")) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_CACHE_KEY_INVALID",
        `operation ${JSON.stringify(operation.id)} cache vary(input) must return an array of strings`,
        { operationId: operation.id, providerId: token.id },
      );
    }
    vary = derived as readonly string[];
  }

  let key: string;
  try {
    key = await deriveCacheKey({
      operationId: operation.id,
      version: await operationVersion(app, operation, versions),
      scopeKey,
      input,
      vary,
    });
  } catch (error) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_CACHE_KEY_INVALID",
      `operation ${JSON.stringify(operation.id)} cache key could not be derived from its validated input`,
      { operationId: operation.id, providerId: token.id, cause: error },
    );
  }

  // An actor- or tenant-scoped entry is indexed under its plain tags and under
  // each tag qualified by its scope key, so a write may purge one subject's
  // entries or every subject's.
  const declaredTags = declaration.tags ?? [];
  const tags =
    declaration.scope === "public"
      ? [...declaredTags]
      : [...declaredTags, ...declaredTags.map((tag) => scopedCacheTag(tag, scopeKey))];
  return {
    backend,
    key,
    ttlMs: declaration.ttlMs,
    tags: Object.freeze(tags),
  };
}

/** Busts every key of an operation whose declaration or schemas changed. */
function operationVersion(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  versions: Map<string, Promise<string>>,
): Promise<string> {
  const existing = versions.get(operation.id);
  if (existing) return existing;
  const node = app.graph.operations.find((candidate) => candidate.id === operation.id);
  const created = deriveCacheKey({
    operationId: operation.id,
    version: app.id,
    scopeKey: "graph",
    input: JSON.parse(canonicalJson(node ?? { id: operation.id })) as unknown,
  });
  versions.set(operation.id, created);
  return created;
}

/**
 * Records one durable purge intent per declared tag inside the active write
 * transaction. Nothing is purged here: the mounted cache-invalidation
 * dispatcher performs the purge after the transaction commits.
 */
async function recordCacheInvalidation(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  input: Readonly<Record<string, unknown>>,
  context: Readonly<{ requestId: string; actor?: OperationActor }>,
  scope: object,
  operationProviders: Map<string, Promise<unknown>>,
  singletonProviders: Map<string, Promise<unknown>>,
): Promise<void> {
  const invalidations = operation.invalidates ?? [];
  if (invalidations.length === 0) return;
  const providerId = cacheInvalidationOutbox.backend.id;
  const backend = await resolveProvider(
    app,
    operation,
    providerId,
    operationProviders,
    singletonProviders,
  );
  if (!isOutboxBackend(backend) || backend.outboxId !== cacheInvalidationOutbox.id) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_CACHE_INVALIDATION_BACKEND_INVALID",
      `provider ${JSON.stringify(providerId)} did not create the cache-invalidation outbox backend`,
      { operationId: operation.id, providerId },
    );
  }
  const writer = createOutboxWriter(cacheInvalidationOutbox, backend, scope);
  for (const invalidation of invalidations) {
    if (invalidation.scope === "global") {
      await writer.enqueue(CACHE_INVALIDATION_INTENT_ID, { tag: invalidation.tag });
      continue;
    }
    const scope =
      invalidation.scope === "actor"
        ? resolveInvalidationActor(operation, invalidation, context)
        : await resolveInvalidationTenant(operation, invalidation, input, context);
    await writer.enqueue(CACHE_INVALIDATION_INTENT_ID, { tag: invalidation.tag, scope });
  }
}

/** The scope key an actor-scoped purge is narrowed to: the write's own actor. */
function resolveInvalidationActor(
  operation: AnyOperation,
  invalidation: { readonly tag: string },
  context: Readonly<{ requestId: string; actor?: OperationActor }>,
): string {
  try {
    return cacheScopeKey("actor", context.actor);
  } catch (error) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_CACHE_ACTOR_INVALID",
      `operation ${JSON.stringify(operation.id)} invalidates tag ${JSON.stringify(invalidation.tag)} per actor but ran without an authenticated actor`,
      { operationId: operation.id, cause: error },
    );
  }
}

/**
 * Derives the scope key a tenant-scoped purge is narrowed to. The declaration
 * must return an authentic TenantScope, exactly as `cache.tenant` must; a raw
 * id or a denied actor fails the write before anything is recorded.
 */
async function resolveInvalidationTenant(
  operation: AnyOperation,
  invalidation: { readonly tag: string; readonly tenant?: unknown },
  input: Readonly<Record<string, unknown>>,
  context: Readonly<{ requestId: string; actor?: OperationActor }>,
): Promise<string> {
  let tenant: unknown;
  try {
    tenant = await (invalidation.tenant as (arguments_: unknown) => unknown | Promise<unknown>)({
      input,
      context,
    });
  } catch (error) {
    if (error instanceof OperationFailure || error instanceof OperationExecutionError) throw error;
    throw new OperationExecutionError(
      "SHIP_OPERATION_CACHE_TENANT_INVALID",
      `operation ${JSON.stringify(operation.id)} could not derive an authentic tenant for invalidated tag ${JSON.stringify(invalidation.tag)}`,
      { operationId: operation.id, cause: error },
    );
  }
  if (!isTenantScope(tenant)) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_CACHE_TENANT_INVALID",
      `operation ${JSON.stringify(operation.id)} invalidates tag ${JSON.stringify(invalidation.tag)} per tenant but returned no authentic TenantScope`,
      { operationId: operation.id },
    );
  }
  return cacheScopeKey("tenant", tenant);
}

type JobLock =
  | { readonly status: "held"; readonly key: string }
  | { readonly status: "acquired"; readonly key: string; readonly release: () => Promise<void> };

/**
 * Single-runner jobs take a `(jobId, key)` lease from the bound lock provider
 * before the handler runs and extend it while the handler is in flight, so a
 * second runner on any process observes `JOB_LOCK_HELD` instead of running.
 */
async function acquireJobLock(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  input: Readonly<Record<string, unknown>>,
  operationProviders: Map<string, Promise<unknown>>,
  singletonProviders: Map<string, Promise<unknown>>,
): Promise<JobLock | undefined> {
  if (!isJob(operation) || operation.job.concurrency.mode !== "single-runner") return undefined;
  const key = jobKey(operation, input);
  const provider = await resolveProvider(
    app,
    operation,
    JOB_LOCK_PROVIDER_ID,
    operationProviders,
    singletonProviders,
  );
  if (!isLockProvider(provider)) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_JOB_LOCK_PROVIDER_INVALID",
      `provider ${JSON.stringify(JOB_LOCK_PROVIDER_ID)} did not create a lock provider`,
      { operationId: operation.id, providerId: JOB_LOCK_PROVIDER_ID },
    );
  }
  const ttlMs = operation.job.concurrency.leaseMs;
  const lease = await provider.acquire(operation.id, key, ttlMs);
  if (!lease) return { status: "held", key };
  const heartbeat = startLeaseHeartbeat(provider, lease, ttlMs);
  return {
    status: "acquired",
    key,
    release: async () => {
      heartbeat.stop();
      await provider.release(heartbeat.current());
    },
  };
}

function startLeaseHeartbeat(
  provider: LockProvider,
  lease: LockLease,
  ttlMs: number,
): { readonly stop: () => void; readonly current: () => LockLease } {
  let current = lease;
  if (typeof provider.extend !== "function") {
    return { stop: () => undefined, current: () => current };
  }
  const extend = provider.extend.bind(provider);
  const interval = Math.max(1, Math.floor(ttlMs / 3));
  const timer = setInterval(() => {
    void extend(current, ttlMs)
      .then((extended) => {
        if (extended) {
          current = { ...current, expiresAt: new Date(Date.now() + ttlMs) };
        }
      })
      .catch(() => undefined);
  }, interval);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
  return { stop: () => clearInterval(timer), current: () => current };
}

/** The lock and fairness key for one run: `concurrency.key(payload)` or the empty key. */
export function jobKey(operation: AnyOperation, input: Readonly<Record<string, unknown>>): string {
  if (!isJob(operation) || typeof operation.job.key !== "function") return "";
  let key: unknown;
  try {
    key = operation.job.key(Reflect.get(input, JOB_INPUT_LOCATION));
  } catch (error) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_JOB_KEY_INVALID",
      `job ${JSON.stringify(operation.id)} concurrency key function threw`,
      { operationId: operation.id, cause: error },
    );
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_JOB_KEY_INVALID",
      `job ${JSON.stringify(operation.id)} concurrency key must be a non-empty string`,
      { operationId: operation.id },
    );
  }
  return key;
}

interface PreparedIdempotency {
  readonly store: IdempotencyStore;
  readonly key: string;
  readonly windowMs: number;
}

async function prepareIdempotency(
  app: CompiledApplication<string, readonly AnyModule[]>,
  operation: AnyOperation,
  input: Readonly<Record<string, unknown>>,
  operationProviders: Map<string, Promise<unknown>>,
  singletonProviders: Map<string, Promise<unknown>>,
): Promise<PreparedIdempotency | undefined> {
  const declaration = operation.idempotency;
  if (!declaration) return undefined;
  let key: unknown;
  try {
    key = (declaration.key as (input: unknown) => string)(input);
  } catch (error) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_IDEMPOTENCY_KEY_INVALID",
      `operation ${JSON.stringify(operation.id)} idempotency key function threw`,
      { operationId: operation.id, cause: error },
    );
  }
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_IDEMPOTENCY_KEY_INVALID",
      `operation ${JSON.stringify(operation.id)} idempotency key must be a non-empty string`,
      { operationId: operation.id },
    );
  }
  const store = await resolveProvider(
    app,
    operation,
    declaration.store.id,
    operationProviders,
    singletonProviders,
  );
  if (!isIdempotencyStore(store)) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_IDEMPOTENCY_STORE_INVALID",
      `provider ${JSON.stringify(declaration.store.id)} did not create an idempotency store`,
      { operationId: operation.id, providerId: declaration.store.id },
    );
  }
  return { store, key: `${operation.id}:${key}`, windowMs: declaration.windowMs };
}

/**
 * Claims the key before the handler runs. Inside a transaction the scope is
 * the active capability map, so a transaction-aware store records the claim
 * and result atomically with the business change.
 */
async function runWithIdempotency(
  operation: AnyOperation,
  idempotency: PreparedIdempotency | undefined,
  scope: object | undefined,
  requestId: string,
  run: () => Promise<OperationSuccessResult>,
): Promise<OperationSuccessResult | OperationFailureResult> {
  if (!idempotency) return run();
  const context = Object.freeze({ ...(scope ? { scope } : {}), now: new Date() });
  const claim = await storeCall(operation, () =>
    idempotency.store.claim(idempotency.key, idempotency.windowMs, context),
  );
  if (claim === "duplicate") {
    const stored = await storeCall(operation, () =>
      idempotency.store.readResult(idempotency.key, context),
    );
    const replay = isStoredIdempotentResult(stored)
      ? stored
      : legacyEmptyWebhookResult(operation, stored);
    if (!replay) {
      throw new OperationExecutionError(
        "SHIP_OPERATION_IDEMPOTENCY_RESULT_MISSING",
        `operation ${JSON.stringify(operation.id)} has a completed idempotency key without a stored result`,
        { operationId: operation.id, providerId: operation.idempotency?.store.id },
      );
    }
    return Object.freeze({
      ok: true as const,
      status: replay.status,
      data: replay.dataUndefined ? undefined : replay.data,
      requestId,
      ...(replay.headers ? { headers: replay.headers } : {}),
      replayed: true as const,
    });
  }
  if (claim === "in-flight") {
    return Object.freeze({
      ok: false as const,
      status: 409 as const,
      error: Object.freeze({
        code: "IDEMPOTENT_IN_FLIGHT" as const,
        message: "An identical request is still in flight",
        details: Object.freeze({ idempotencyKey: idempotency.key }),
      }),
      requestId,
    });
  }
  let result: OperationSuccessResult;
  try {
    result = await run();
  } catch (error) {
    try {
      await idempotency.store.release(idempotency.key, context);
    } catch {
      // The original failure is the meaningful one; a failed release expires with the window.
    }
    throw error;
  }
  await storeCall(operation, () =>
    idempotency.store.complete(
      idempotency.key,
      {
        status: result.status,
        data: result.data === undefined ? null : result.data,
        ...(result.data === undefined ? { dataUndefined: true } : {}),
        ...(result.headers ? { headers: result.headers } : {}),
      },
      context,
    ),
  );
  return result;
}

/** Recover empty webhook receipts written before undefined bodies had a JSON-safe marker. */
function legacyEmptyWebhookResult(
  operation: AnyOperation,
  value: unknown,
): StoredIdempotentResult | undefined {
  if (
    operation.transport?.metadata?.response !== "empty" ||
    typeof value !== "object" ||
    value === null ||
    "data" in value
  ) {
    return undefined;
  }
  const normalized = { ...value, data: null, dataUndefined: true as const };
  return isStoredIdempotentResult(normalized) &&
    Reflect.get(operation.output, normalized.status) !== undefined
    ? normalized
    : undefined;
}

/**
 * A store that throws is an infrastructure outage, not a handler defect.
 * Callers such as webhook ingress map this code to a retry-inducing response
 * instead of accepting work the store could not record.
 */
async function storeCall<TResult>(
  operation: AnyOperation,
  call: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await call();
  } catch (error) {
    throw new OperationExecutionError(
      "SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE",
      `idempotency store ${JSON.stringify(operation.idempotency?.store.id)} failed while running operation ${JSON.stringify(operation.id)}`,
      { operationId: operation.id, providerId: operation.idempotency?.store.id, cause: error },
    );
  }
}

function normalizeIssue(issue: SchemaIssue, prefix?: string): ValidationIssue {
  const path = (issue.path ?? []).map((segment) => {
    const key = typeof segment === "object" && segment !== null ? segment.key : segment;
    return typeof key === "number" ? key : String(key);
  });
  const code = Reflect.get(issue, "code");
  return Object.freeze({
    path: Object.freeze(prefix ? [prefix, ...path] : path),
    message: issue.message,
    ...(typeof code === "string" ? { code } : {}),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(operationId: string, signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new OperationExecutionError(
    "SHIP_OPERATION_ABORTED",
    `operation ${JSON.stringify(operationId)} was aborted`,
    { operationId, cause: signal.reason },
  );
}
