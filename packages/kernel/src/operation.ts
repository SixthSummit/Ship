import type { OperationAccess } from "./access.js";
import { isOperationAccess } from "./access.js";
import type { AnyAttachment } from "./attachment.js";
import { isAttachment } from "./attachment.js";
import type {
  OperationActor,
  OperationIdentity,
  ProviderOperationActor,
  SystemOperationActor,
} from "./actor.js";
import type { CacheInvalidation, CacheInvalidationDeclaration, OperationCache } from "./cache.js";
import { isCacheInvalidationList, isOperationCache, normalizeCacheInvalidations } from "./cache.js";
import type {
  DependencyBindings,
  EffectDependencyToken,
  ResolveDependencyBindings,
} from "./dependency.js";
import { isDependencyToken, isEffectDependencyToken } from "./dependency.js";
import type { OperationIdempotency } from "./idempotency.js";
import { isOperationIdempotency } from "./idempotency.js";
import type { OperationErrorDefinition } from "./operation-error.js";
import { isOperationErrorDefinition } from "./operation-error.js";
import type { AnyChannel } from "./realtime.js";
import { isChannel, isChannelPublicationToken } from "./realtime.js";
import type { InferSchemaInput, InferSchemaOutput, RuntimeSchema } from "./schema.js";
import { isRuntimeSchema } from "./schema.js";

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const INPUT_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const responseMarker: unique symbol = Symbol("ship.operation.response");

export type OperationTransactionMode = "none" | "read" | "write";
export type OperationInputSchemas = Readonly<Record<string, RuntimeSchema>>;
export type OperationOutputSchemas = Readonly<Record<number, RuntimeSchema>>;
export type OperationTransportMetadataPrimitive = string | number | boolean | null;
export type OperationTransportMetadataValue =
  | OperationTransportMetadataPrimitive
  | OperationTransportMetadata
  | readonly OperationTransportMetadataValue[];
export interface OperationTransportMetadata {
  readonly [key: string]: OperationTransportMetadataValue;
}
export type OperationOutputStatus<TOutput extends OperationOutputSchemas> = Extract<
  keyof TOutput,
  number
>;

/**
 * Declares that a transport delivers the operation result as a stream of
 * validated frames followed by one terminal value. The terminal value is the
 * operation's declared `200` output; frames are validated against `frame`.
 * Adapters own framing (for example SSE), heartbeats, limits, and cancellation.
 */
export interface OperationStreamResponse<TFrame extends RuntimeSchema = RuntimeSchema> {
  readonly mode: "stream";
  /** Adapter-owned framing identifier, for example `"sse"`. */
  readonly framing: string;
  readonly frame: TFrame;
  /** Idle interval after which the adapter emits a keep-alive. Required at compile time. */
  readonly heartbeatMs?: number;
  /** Maximum stream lifetime before the adapter terminates it. Required at compile time. */
  readonly maxDurationMs?: number;
  /** Maximum number of frames before the adapter terminates the stream. Required at compile time. */
  readonly maxFrames?: number;
}

export interface OperationTransport {
  readonly kind: string;
  /** Adapter-owned canonical binding key, used for graph collision checks. */
  readonly binding?: string;
  /** JSON-safe adapter metadata projected into the compiled application graph. */
  readonly metadata?: OperationTransportMetadata;
  /** Streaming response declaration; absent means one unary response. */
  readonly response?: OperationStreamResponse;
}

/** Handler-facing stream seam: validated `emit` plus the adapter-owned cancellation signal. */
export interface OperationStream<TFrame = unknown> {
  readonly emit: (frame: TFrame) => Promise<void>;
  readonly signal: AbortSignal;
}

export type OperationStreamFrameInput<TTransport> = TTransport extends {
  readonly response: {
    readonly mode: "stream";
    readonly frame: infer TFrame extends RuntimeSchema;
  };
}
  ? InferSchemaInput<TFrame>
  : never;

export type OperationStreamArguments<TTransport> = TTransport extends {
  readonly response: { readonly mode: "stream"; readonly frame: RuntimeSchema };
}
  ? { readonly stream: OperationStream<OperationStreamFrameInput<TTransport>> }
  : { readonly stream?: never };

export interface OperationContext<TActor = OperationActor> {
  readonly requestId: string;
  readonly actor?: TActor;
  readonly identity?: OperationIdentity;
  readonly signal?: AbortSignal;
}

export type OperationContextForAccess<TAccess extends OperationAccess> = TAccess extends {
  readonly kind: "public" | "optional-identity";
}
  ? OperationContext
  : TAccess extends { readonly kind: "system" }
    ? OperationContext & { readonly actor: SystemOperationActor }
    : TAccess extends { readonly kind: "provider" }
      ? OperationContext & { readonly actor: ProviderOperationActor }
      : OperationContext & { readonly actor: OperationActor };

export type InferOperationRawInput<TInput extends OperationInputSchemas> = {
  readonly [TKey in keyof TInput]: InferSchemaInput<TInput[TKey]>;
};

export type InferOperationInput<TInput extends OperationInputSchemas> = {
  readonly [TKey in keyof TInput]: InferSchemaOutput<TInput[TKey]>;
};

export type InferOperationOutputs<TOutput extends OperationOutputSchemas> = {
  readonly [TStatus in OperationOutputStatus<TOutput>]: InferSchemaOutput<
    TOutput[TStatus] & RuntimeSchema
  >;
};

export interface ExplicitOperationResponse<TStatus extends number = number, TBody = unknown> {
  readonly [responseMarker]: true;
  readonly status: TStatus;
  readonly body: TBody;
  readonly headers?: Readonly<Record<string, string>>;
}

export type OperationResponse<TOutput extends OperationOutputSchemas> = {
  [TStatus in OperationOutputStatus<TOutput>]: ExplicitOperationResponse<
    TStatus,
    InferSchemaOutput<TOutput[TStatus]>
  >;
}[OperationOutputStatus<TOutput>];

export function respond<const TStatus extends number, TBody>(
  status: TStatus,
  body: TBody,
  options: { readonly headers?: Readonly<Record<string, string>> } = {},
): ExplicitOperationResponse<TStatus, TBody> {
  const headers = normalizeResponseHeaders(options.headers);
  return Object.freeze({
    [responseMarker]: true,
    status,
    body,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}

export function isExplicitOperationResponse(
  value: unknown,
): value is ExplicitOperationResponse<number, unknown> {
  return typeof value === "object" && value !== null && Reflect.get(value, responseMarker) === true;
}

function normalizeResponseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (headers === undefined) return Object.freeze({});
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new TypeError("operation response headers must be a string map");
  }

  const entries: [string, string][] = [];
  const names = new Set<string>();
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) ||
      typeof value !== "string" ||
      /[\r\n]/u.test(value)
    ) {
      throw new TypeError(`invalid operation response header ${JSON.stringify(rawName)}`);
    }
    if (names.has(name)) {
      throw new TypeError(`duplicate operation response header ${JSON.stringify(name)}`);
    }
    names.add(name);
    entries.push([name, value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export type OperationHandlerResult<
  TOutput extends OperationOutputSchemas,
  TSuccessStatus extends OperationOutputStatus<TOutput>,
> =
  | InferSchemaOutput<TOutput[TSuccessStatus]>
  | OperationResponse<TOutput>
  | Promise<InferSchemaOutput<TOutput[TSuccessStatus]> | OperationResponse<TOutput>>;

export type OperationHandlerArguments<
  TInput extends OperationInputSchemas,
  TDependencies extends DependencyBindings,
  TAccess extends OperationAccess = OperationAccess,
  TTransport extends OperationTransport | undefined = undefined,
> = {
  readonly input: InferOperationInput<TInput>;
  readonly services: ResolveDependencyBindings<TDependencies>;
  readonly context: OperationContextForAccess<TAccess>;
} & OperationStreamArguments<TTransport>;

export type OperationHandler<
  TInput extends OperationInputSchemas,
  TOutput extends OperationOutputSchemas,
  TDependencies extends DependencyBindings,
  TSuccessStatus extends OperationOutputStatus<TOutput>,
  TAccess extends OperationAccess = OperationAccess,
  TTransport extends OperationTransport | undefined = undefined,
> = (
  arguments_: OperationHandlerArguments<TInput, TDependencies, TAccess, TTransport>,
) => OperationHandlerResult<TOutput, TSuccessStatus>;

export interface OperationDefinition<
  TId extends string,
  TInput extends OperationInputSchemas,
  TOutput extends OperationOutputSchemas,
  TDependencies extends DependencyBindings,
  TErrors extends readonly OperationErrorDefinition[],
  TAccess extends OperationAccess,
  TTransaction extends OperationTransactionMode,
  TSuccessStatus extends OperationOutputStatus<TOutput>,
  TEffects extends readonly EffectDependencyToken[],
  TTransport extends OperationTransport | undefined = undefined,
> {
  readonly id: TId;
  readonly input: TInput;
  readonly output: TOutput;
  readonly successStatus: TSuccessStatus;
  readonly errors: TErrors;
  readonly access: TAccess;
  readonly transaction: TTransaction;
  readonly dependencies: TDependencies;
  readonly effects?: TEffects;
  readonly transport?: TTransport;
  /**
   * Executor-enforced idempotency: duplicate keys replay the stored success
   * result, in-flight keys fail with IDEMPOTENT_IN_FLIGHT, and a claimed key
   * is released when the handler fails.
   */
  readonly idempotency?: OperationIdempotency<InferOperationInput<TInput>>;
  /** Realtime channels this operation publishes to through bound channel.publication tokens. */
  readonly publishes?: readonly AnyChannel[];
  /**
   * Executor-enforced read caching. Only `transaction: "none"` or `"read"`
   * operations may declare it; the key is framework-derived and scoped so one
   * actor or tenant can never observe another's entry. A streaming transport
   * response bypasses the read cache: frames are never stored or replayed.
   */
  readonly cache?: OperationCache<InferOperationInput<TInput>>;
  /**
   * Cache tags this write operation invalidates. The executor records one
   * durable purge intent per tag inside the write transaction; the mounted
   * cache-invalidation dispatcher performs the purge afterwards. A plain tag
   * purges every tenant's entries; `{ tag, scope: "tenant", tenant }` purges
   * only the entries a tenant-scoped read stored for the derived tenant.
   */
  readonly invalidates?: readonly CacheInvalidationDeclaration<InferOperationInput<TInput>>[];
  /**
   * Managed attachments this operation attaches, detaches, lists or resolves
   * through bound `attachment.binding` tokens. The executor hands the handler
   * a capability scoped to the running transaction; `attach` and `detach`
   * require `transaction: "write"` so the purge intent commits with the record.
   */
  readonly attachments?: readonly AnyAttachment[];
  readonly handler: OperationHandler<
    TInput,
    TOutput,
    TDependencies,
    TSuccessStatus,
    TAccess,
    TTransport
  >;
}

export interface Operation<
  TId extends string,
  TInput extends OperationInputSchemas,
  TOutput extends OperationOutputSchemas,
  TDependencies extends DependencyBindings,
  TErrors extends readonly OperationErrorDefinition[],
  TAccess extends OperationAccess,
  TTransaction extends OperationTransactionMode,
  TSuccessStatus extends OperationOutputStatus<TOutput>,
  TEffects extends readonly EffectDependencyToken[],
  TTransport extends OperationTransport | undefined = undefined,
> extends Omit<
    OperationDefinition<
      TId,
      TInput,
      TOutput,
      TDependencies,
      TErrors,
      TAccess,
      TTransaction,
      TSuccessStatus,
      TEffects,
      TTransport
    >,
    "invalidates"
  > {
  readonly kind: "ship.operation";
  readonly effects: TEffects;
  readonly publishes: readonly AnyChannel[];
  readonly attachments: readonly AnyAttachment[];
  /** Declared `invalidates` entries in their compiled `{ tag, scope, tenant? }` form. */
  readonly invalidates?: readonly CacheInvalidation<InferOperationInput<TInput>>[];
}

/** Runtime shape accepted by modules without erasing each operation's inferred public type. */
export interface AnyOperation {
  readonly kind: "ship.operation";
  readonly id: string;
  readonly input: OperationInputSchemas;
  readonly output: OperationOutputSchemas;
  readonly successStatus: number;
  readonly errors: readonly OperationErrorDefinition[];
  readonly access: OperationAccess;
  readonly transaction: OperationTransactionMode;
  readonly dependencies: DependencyBindings;
  readonly effects: readonly EffectDependencyToken[];
  readonly transport?: OperationTransport;
  readonly idempotency?: OperationIdempotency<never>;
  readonly cache?: OperationCache<never>;
  readonly invalidates?: readonly CacheInvalidation<never>[];
  readonly publishes: readonly AnyChannel[];
  readonly attachments: readonly AnyAttachment[];
  readonly handler: (...arguments_: never[]) => unknown;
}

export type OperationDefinitionDiagnosticCode =
  | "SHIP_OPERATION_DEFINITION_INVALID"
  | "SHIP_OPERATION_ID_INVALID"
  | "SHIP_OPERATION_INPUT_INVALID"
  | "SHIP_OPERATION_OUTPUT_INVALID"
  | "SHIP_OPERATION_SUCCESS_STATUS_INVALID"
  | "SHIP_OPERATION_ERROR_INVALID"
  | "SHIP_OPERATION_ERROR_DUPLICATE"
  | "SHIP_OPERATION_ACCESS_INVALID"
  | "SHIP_OPERATION_TRANSACTION_INVALID"
  | "SHIP_OPERATION_DEPENDENCY_INVALID"
  | "SHIP_OPERATION_DEPENDENCY_DUPLICATE"
  | "SHIP_OPERATION_EFFECT_INVALID"
  | "SHIP_OPERATION_EFFECT_DUPLICATE"
  | "SHIP_OPERATION_TRANSPORT_INVALID"
  | "SHIP_OPERATION_IDEMPOTENCY_INVALID"
  | "SHIP_OPERATION_CACHE_INVALID"
  | "SHIP_OPERATION_INVALIDATES_INVALID"
  | "SHIP_OPERATION_PUBLISH_INVALID"
  | "SHIP_OPERATION_PUBLISH_DUPLICATE"
  | "SHIP_OPERATION_ATTACHMENT_INVALID"
  | "SHIP_OPERATION_ATTACHMENT_DUPLICATE"
  | "SHIP_OPERATION_HANDLER_INVALID";

export class InvalidOperationDefinitionError extends Error {
  readonly code: OperationDefinitionDiagnosticCode;
  readonly operationId?: string;
  readonly field?: string;

  constructor(
    code: OperationDefinitionDiagnosticCode,
    message: string,
    options: { readonly operationId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidOperationDefinitionError";
    this.code = code;
    this.operationId = options.operationId;
    this.field = options.field;
  }
}

export function defineOperation<
  const TId extends string,
  const TInput extends OperationInputSchemas,
  const TOutput extends OperationOutputSchemas,
  const TDependencies extends DependencyBindings,
  const TErrors extends readonly OperationErrorDefinition[],
  const TAccess extends OperationAccess,
  const TTransaction extends OperationTransactionMode,
  const TSuccessStatus extends OperationOutputStatus<TOutput>,
  const TEffects extends readonly EffectDependencyToken[] = readonly [],
  const TTransport extends OperationTransport | undefined = undefined,
>(
  definition: OperationDefinition<
    TId,
    TInput,
    TOutput,
    TDependencies,
    TErrors,
    TAccess,
    TTransaction,
    TSuccessStatus,
    TEffects,
    TTransport
  >,
): Operation<
  TId,
  TInput,
  TOutput,
  TDependencies,
  TErrors,
  TAccess,
  TTransaction,
  TSuccessStatus,
  TEffects,
  TTransport
> {
  assertOperationDefinition(definition);

  const { invalidates: declaredInvalidates, ...declaration } = definition;
  return Object.freeze({
    ...declaration,
    kind: "ship.operation" as const,
    input: Object.freeze({ ...definition.input }),
    output: Object.freeze({ ...definition.output }),
    errors: Object.freeze([...definition.errors]) as unknown as TErrors,
    dependencies: Object.freeze({ ...definition.dependencies }),
    effects: Object.freeze([...(definition.effects ?? [])]) as unknown as TEffects,
    ...(definition.idempotency
      ? {
          idempotency: Object.freeze({
            key: definition.idempotency.key,
            windowMs: definition.idempotency.windowMs,
            store: definition.idempotency.store,
          }),
        }
      : {}),
    ...(definition.cache
      ? {
          cache: Object.freeze({
            ttlMs: definition.cache.ttlMs,
            scope: definition.cache.scope,
            ...(definition.cache.vary ? { vary: definition.cache.vary } : {}),
            ...(definition.cache.tags ? { tags: Object.freeze([...definition.cache.tags]) } : {}),
            ...(definition.cache.tenant ? { tenant: definition.cache.tenant } : {}),
          }),
        }
      : {}),
    ...(declaredInvalidates
      ? { invalidates: normalizeCacheInvalidations(declaredInvalidates) }
      : {}),
    publishes: Object.freeze([...(definition.publishes ?? [])]),
    attachments: Object.freeze([...(definition.attachments ?? [])]),
    ...(definition.transport
      ? {
          transport: Object.freeze({
            ...definition.transport,
            ...(definition.transport.metadata
              ? { metadata: cloneAndFreezeMetadata(definition.transport.metadata) }
              : {}),
            ...(definition.transport.response
              ? { response: Object.freeze({ ...definition.transport.response }) }
              : {}),
          }) as unknown as TTransport,
        }
      : {}),
  });
}

function assertOperationDefinition(
  definition: unknown,
): asserts definition is OperationDefinition<
  string,
  OperationInputSchemas,
  OperationOutputSchemas,
  DependencyBindings,
  readonly OperationErrorDefinition[],
  OperationAccess,
  OperationTransactionMode,
  number,
  readonly EffectDependencyToken[],
  OperationTransport | undefined
> {
  if (typeof definition !== "object" || definition === null) {
    fail("SHIP_OPERATION_DEFINITION_INVALID", "operation definition must be an object");
  }

  const operationId =
    typeof Reflect.get(definition, "id") === "string"
      ? (Reflect.get(definition, "id") as string)
      : undefined;

  if (!operationId || !OPERATION_ID_PATTERN.test(operationId)) {
    fail(
      "SHIP_OPERATION_ID_INVALID",
      "operation id must contain at least two lowercase dot-separated segments",
      operationId,
      "id",
    );
  }

  assertSchemaMap(Reflect.get(definition, "input"), operationId, "input", false);
  assertSchemaMap(Reflect.get(definition, "output"), operationId, "output", true);

  const output = Reflect.get(definition, "output") as Record<string, RuntimeSchema>;
  const successStatus = Reflect.get(definition, "successStatus");
  const transport = Reflect.get(definition, "transport");
  const redirect =
    Reflect.get(transport ?? {}, "kind") === "http" &&
    Reflect.get(Reflect.get(transport ?? {}, "metadata") ?? {}, "response") === "redirect";
  const statuses = Object.keys(output).map(Number);
  if (statuses.some((status) => (redirect ? !REDIRECT_STATUSES.has(status) : status > 299))) {
    fail(
      "SHIP_OPERATION_OUTPUT_INVALID",
      redirect
        ? "redirect output statuses must be 301, 302, 303, 307, or 308"
        : "3xx output statuses require an HTTP redirect transport",
      operationId,
      "output",
    );
  }
  if (
    typeof successStatus !== "number" ||
    !Number.isInteger(successStatus) ||
    successStatus < 200 ||
    (redirect ? !REDIRECT_STATUSES.has(successStatus) : successStatus > 299) ||
    !Object.hasOwn(output, String(successStatus))
  ) {
    fail(
      "SHIP_OPERATION_SUCCESS_STATUS_INVALID",
      redirect
        ? "successStatus must name a declared redirect output"
        : "successStatus must name a declared 2xx output",
      operationId,
      "successStatus",
    );
  }

  assertErrorCodes(Reflect.get(definition, "errors"), operationId);

  if (!isOperationAccess(Reflect.get(definition, "access"))) {
    fail(
      "SHIP_OPERATION_ACCESS_INVALID",
      "access must be an access declaration created by the kernel helpers",
      operationId,
      "access",
    );
  }

  const transaction = Reflect.get(definition, "transaction");
  if (transaction !== "none" && transaction !== "read" && transaction !== "write") {
    fail(
      "SHIP_OPERATION_TRANSACTION_INVALID",
      "transaction must be one of none, read, or write",
      operationId,
      "transaction",
    );
  }

  assertDependencies(Reflect.get(definition, "dependencies"), operationId);
  assertEffects(Reflect.get(definition, "effects"), operationId);
  assertPublishes(Reflect.get(definition, "publishes"), operationId);
  assertAttachments(Reflect.get(definition, "attachments"), operationId);

  if (
    transport !== undefined &&
    (typeof transport !== "object" ||
      transport === null ||
      typeof Reflect.get(transport, "kind") !== "string" ||
      Reflect.get(transport, "kind").length === 0 ||
      (Reflect.get(transport, "binding") !== undefined &&
        (typeof Reflect.get(transport, "binding") !== "string" ||
          Reflect.get(transport, "binding").length === 0)))
  ) {
    fail(
      "SHIP_OPERATION_TRANSPORT_INVALID",
      "transport must have a non-empty kind",
      operationId,
      "transport",
    );
  }
  if (transport !== undefined) {
    const metadata = Reflect.get(transport, "metadata");
    if (
      metadata !== undefined &&
      (typeof metadata !== "object" ||
        metadata === null ||
        Array.isArray(metadata) ||
        Object.keys(metadata).some((key) => key.length === 0) ||
        !isJsonSafeMetadataValue(metadata, new WeakSet()))
    ) {
      fail(
        "SHIP_OPERATION_TRANSPORT_INVALID",
        "transport metadata must contain only finite JSON-safe values",
        operationId,
        "transport.metadata",
      );
    }
    assertTransportResponse(Reflect.get(transport, "response"), operationId);
  }

  const idempotency = Reflect.get(definition, "idempotency");
  if (idempotency !== undefined && !isOperationIdempotency(idempotency)) {
    fail(
      "SHIP_OPERATION_IDEMPOTENCY_INVALID",
      "idempotency must declare key(input), a positive integer windowMs, and an idempotencyStoreDependency() token",
      operationId,
      "idempotency",
    );
  }

  const cache = Reflect.get(definition, "cache");
  if (cache !== undefined && !isOperationCache(cache)) {
    fail(
      "SHIP_OPERATION_CACHE_INVALID",
      "cache must declare a positive integer ttlMs, a scope of actor/tenant/public, optional vary(input) and unique lowercase tags, and tenant(arguments) exactly when the scope is tenant",
      operationId,
      "cache",
    );
  }

  const invalidates = Reflect.get(definition, "invalidates");
  if (invalidates !== undefined && !isCacheInvalidationList(invalidates)) {
    fail(
      "SHIP_OPERATION_INVALIDATES_INVALID",
      'invalidates must be a non-empty array of unique lowercase cache tags, each a string or { tag, scope: "tenant", tenant(arguments) }',
      operationId,
      "invalidates",
    );
  }

  if (typeof Reflect.get(definition, "handler") !== "function") {
    fail("SHIP_OPERATION_HANDLER_INVALID", "handler must be a function", operationId, "handler");
  }
}

const STREAM_RESPONSE_KEYS = new Set([
  "mode",
  "framing",
  "frame",
  "heartbeatMs",
  "maxDurationMs",
  "maxFrames",
]);

export function isOperationStreamResponse(value: unknown): value is OperationStreamResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!Object.keys(value).every((key) => STREAM_RESPONSE_KEYS.has(key))) return false;
  const framing = Reflect.get(value, "framing");
  return (
    Reflect.get(value, "mode") === "stream" &&
    typeof framing === "string" &&
    /^[a-z][a-z0-9-]*$/u.test(framing) &&
    isRuntimeSchema(Reflect.get(value, "frame")) &&
    ["heartbeatMs", "maxDurationMs", "maxFrames"].every((key) => {
      const limit = Reflect.get(value, key);
      return limit === undefined || (Number.isSafeInteger(limit) && Number(limit) > 0);
    })
  );
}

function assertTransportResponse(value: unknown, operationId: string): void {
  if (value === undefined || isOperationStreamResponse(value)) return;
  fail(
    "SHIP_OPERATION_TRANSPORT_INVALID",
    "transport response must declare mode stream, a framing id, a frame schema, and positive integer limits",
    operationId,
    "transport.response",
  );
}

function isJsonSafeMetadataValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;

  ancestors.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  const valid = values.every((item) => isJsonSafeMetadataValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function cloneAndFreezeMetadata(metadata: OperationTransportMetadata): OperationTransportMetadata {
  return cloneAndFreezeMetadataValue(metadata) as OperationTransportMetadata;
}

function cloneAndFreezeMetadataValue(
  value: OperationTransportMetadataValue,
): OperationTransportMetadataValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreezeMetadataValue(item)));
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, cloneAndFreezeMetadataValue(item)]),
      ),
    );
  }
  return value;
}

function assertEffects(
  value: unknown,
  operationId: string,
): asserts value is readonly EffectDependencyToken[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((effect) => isEffectDependencyToken(effect))) {
    fail(
      "SHIP_OPERATION_EFFECT_INVALID",
      "effects must contain only effectDependency() tokens",
      operationId,
      "effects",
    );
  }
  const ids = new Set<string>();
  for (const effect of value) {
    if (isChannelPublicationToken(effect)) {
      fail(
        "SHIP_OPERATION_EFFECT_INVALID",
        `channel publication ${JSON.stringify(effect.id)} must be declared in publishes, not effects`,
        operationId,
        "effects",
      );
    }
    if (ids.has(effect.id)) {
      fail(
        "SHIP_OPERATION_EFFECT_DUPLICATE",
        `duplicate operation effect ${JSON.stringify(effect.id)}`,
        operationId,
        "effects",
      );
    }
    ids.add(effect.id);
  }
}

function assertPublishes(
  value: unknown,
  operationId: string,
): asserts value is readonly AnyChannel[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((channel) => isChannel(channel))) {
    fail(
      "SHIP_OPERATION_PUBLISH_INVALID",
      "publishes must contain only defineChannel() results",
      operationId,
      "publishes",
    );
  }
  const ids = new Set<string>();
  for (const channel of value) {
    if (ids.has(channel.id)) {
      fail(
        "SHIP_OPERATION_PUBLISH_DUPLICATE",
        `duplicate operation publication ${JSON.stringify(channel.id)}`,
        operationId,
        "publishes",
      );
    }
    ids.add(channel.id);
  }
}

function assertAttachments(
  value: unknown,
  operationId: string,
): asserts value is readonly AnyAttachment[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((attachment) => isAttachment(attachment))) {
    fail(
      "SHIP_OPERATION_ATTACHMENT_INVALID",
      "attachments must contain only defineAttachment() results",
      operationId,
      "attachments",
    );
  }
  const ids = new Set<string>();
  for (const attachment of value) {
    if (ids.has(attachment.id)) {
      fail(
        "SHIP_OPERATION_ATTACHMENT_DUPLICATE",
        `duplicate operation attachment ${JSON.stringify(attachment.id)}`,
        operationId,
        "attachments",
      );
    }
    ids.add(attachment.id);
  }
}

function assertSchemaMap(
  value: unknown,
  operationId: string,
  field: "input" | "output",
  requireEntries: boolean,
): asserts value is Record<string, RuntimeSchema> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(
      field === "input" ? "SHIP_OPERATION_INPUT_INVALID" : "SHIP_OPERATION_OUTPUT_INVALID",
      `${field} must be a schema map`,
      operationId,
      field,
    );
  }

  const entries = Object.entries(value);
  if (requireEntries && entries.length === 0) {
    fail(
      "SHIP_OPERATION_OUTPUT_INVALID",
      "output must declare at least one success status schema",
      operationId,
      field,
    );
  }

  for (const [key, schema] of entries) {
    const validKey =
      field === "input"
        ? INPUT_NAME_PATTERN.test(key)
        : Number.isInteger(Number(key)) && Number(key) >= 200 && Number(key) <= 399;

    if (!validKey || !isRuntimeSchema(schema)) {
      fail(
        field === "input" ? "SHIP_OPERATION_INPUT_INVALID" : "SHIP_OPERATION_OUTPUT_INVALID",
        `${field}.${key} must be a valid ${field === "input" ? "named" : "success-status"} Standard Schema`,
        operationId,
        `${field}.${key}`,
      );
    }
  }
}

function assertErrorCodes(
  value: unknown,
  operationId: string,
): asserts value is readonly OperationErrorDefinition[] {
  if (!Array.isArray(value)) {
    fail(
      "SHIP_OPERATION_ERROR_INVALID",
      "errors must be an array of operationError() definitions",
      operationId,
      "errors",
    );
  }

  const unique = new Set<string>();
  for (const error of value) {
    if (!isOperationErrorDefinition(error)) {
      fail(
        "SHIP_OPERATION_ERROR_INVALID",
        "errors must contain only operationError() definitions",
        operationId,
        "errors",
      );
    }
    if (unique.has(error.code)) {
      fail(
        "SHIP_OPERATION_ERROR_DUPLICATE",
        `duplicate operation error code ${JSON.stringify(error.code)}`,
        operationId,
        "errors",
      );
    }
    unique.add(error.code);
  }
}

function assertDependencies(
  value: unknown,
  operationId: string,
): asserts value is DependencyBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(
      "SHIP_OPERATION_DEPENDENCY_INVALID",
      "dependencies must be a map of dependency tokens",
      operationId,
      "dependencies",
    );
  }

  const providerIds = new Set<string>();
  for (const [name, token] of Object.entries(value)) {
    if (!INPUT_NAME_PATTERN.test(name) || !isDependencyToken(token)) {
      fail(
        "SHIP_OPERATION_DEPENDENCY_INVALID",
        `dependencies.${name} must be a valid dependency token`,
        operationId,
        `dependencies.${name}`,
      );
    }
    if (providerIds.has(token.id)) {
      fail(
        "SHIP_OPERATION_DEPENDENCY_DUPLICATE",
        `dependency token ${JSON.stringify(token.id)} is bound more than once`,
        operationId,
        "dependencies",
      );
    }
    providerIds.add(token.id);
  }
}

function fail(
  code: OperationDefinitionDiagnosticCode,
  message: string,
  operationId?: string,
  field?: string,
): never {
  throw new InvalidOperationDefinitionError(code, message, { operationId, field });
}
