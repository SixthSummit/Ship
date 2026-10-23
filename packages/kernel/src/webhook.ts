import type { PermissionAccess, ProviderAccess } from "./access.js";
import { permission, providerAccess, systemAccess } from "./access.js";
import type {
  DependencyBindings,
  DependencyToken,
  EffectDependencyToken,
  ResolveDependencyBindings,
  UnitOfWorkDependencyToken,
} from "./dependency.js";
import { dependency, isDependencyToken, isUnitOfWorkDependencyToken } from "./dependency.js";
import type { FrameworkFieldSchema } from "./framework-schema.js";
import {
  booleanSchema,
  bytesSchema,
  emptySchema,
  integerSchema,
  objectSchema,
  optionalSchema,
  recordSchema,
  stringSchema,
} from "./framework-schema.js";
import type { IdempotencyStoreDependencyToken } from "./idempotency.js";
import { isIdempotencyStoreDependencyToken } from "./idempotency.js";
import type {
  AnyOperation,
  ExplicitOperationResponse,
  InferOperationInput,
  Operation,
  OperationContextForAccess,
  OperationHandlerResult,
  OperationOutputSchemas,
  OperationOutputStatus,
  OperationTransactionMode,
  OperationTransport,
} from "./operation.js";
import { defineOperation } from "./operation.js";
import type { OperationErrorDefinition } from "./operation-error.js";
import { operationError, operationFailure } from "./operation-error.js";
import type {
  AnyOutbox,
  Outbox,
  OutboxIntentDefinition,
  OutboxIntentDefinitions,
  OutboxPerformArguments,
  OutboxRecord,
  OutboxWriter,
  OutboxWriterDependencyToken,
} from "./outbox.js";
import { isOutbox, outboxDependency, outboxIntent } from "./outbox.js";
import type { InferSchemaOutput, RuntimeSchema } from "./schema.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const MEDIA_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u;
const BINDING_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/u;
const WEBHOOK_CONTENT_TYPE = "application/json; charset=UTF-8";
const CONTENT_TYPE_PATTERN =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n]+)*$/u;
/** The single path parameter a replay transport may declare. */
/** Default name of the replay path parameter that carries the event id. */
const REPLAY_DEFAULT_PATH_PARAMETER = "eventId";
const PATH_PARAMETER_PATTERN = /^:([A-Za-z_][A-Za-z0-9_]*)$/u;

/** Permission that gates the generic replay operation. */
export const WEBHOOK_REPLAY_PERMISSION = "ship.webhooks:replay";

/**
 * Header names never persisted with a received event, regardless of provider.
 * Verifiers add their own signature or shared-secret headers through
 * `sensitiveHeaders`.
 */
export const WEBHOOK_REDACTED_HEADERS: readonly string[] = Object.freeze([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
]);

// ---------------------------------------------------------------------------
// Verifier contract
// ---------------------------------------------------------------------------

/**
 * What a verification scheme actually proves. `signature`: the body bytes are
 * authenticated; `freshness`: a signed timestamp bounds the request age;
 * `replay`: the scheme itself rejects a repeated delivery (rare; most schemes
 * rely on the idempotency window instead).
 */
export type WebhookVerifierGuarantees = {
  readonly signature: boolean;
  readonly freshness: boolean;
  readonly replay: boolean;
};

export type WebhookVerificationFailureReason =
  | "missing-signature"
  | "malformed-signature"
  | "signature-mismatch"
  | "timestamp-missing"
  | "timestamp-stale"
  | "unsupported-request";

export interface WebhookVerificationRequest {
  /** Lower-cased request headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact bytes received after transport bounding, before any parsing. */
  readonly rawBody: Uint8Array;
  readonly method: string;
  /** Derived from the declared public base URL and operation path, never from the incoming request. */
  readonly canonicalUrl: string;
  /** One candidate secret; the adapter calls verify once per rotated secret. */
  readonly secret: string;
  readonly now: Date;
}

export type WebhookVerification =
  | { readonly ok: true; readonly eventId?: string; readonly timestamp?: Date }
  | { readonly ok: false; readonly reason: WebhookVerificationFailureReason };

/**
 * Pure verification of one request. Implementations must not read ambient
 * state, log the body, or throw for untrusted input; return `{ ok: false }`.
 */
export interface WebhookVerifier {
  readonly id: string;
  readonly guarantees: WebhookVerifierGuarantees;
  /** Lower-cased header names that carry credentials and must never be persisted. */
  readonly sensitiveHeaders?: readonly string[];
  verify(request: WebhookVerificationRequest): WebhookVerification | Promise<WebhookVerification>;
}

export interface WebhookSecretSource {
  readonly kind: "ship.webhook-secret";
  readonly id: string;
  /** Every currently valid secret, newest first, so rotation overlaps cleanly. */
  current(): readonly string[] | Promise<readonly string[]>;
}

/** Binds one verifier and one rotatable secret source to a provider id. */
export interface WebhookVerifierToken {
  readonly kind: "ship.webhook-verifier";
  /** The provider id used for `providerAccess()` and the provider actor. */
  readonly provider: string;
  readonly verifier: WebhookVerifier;
  readonly secret: WebhookSecretSource;
}

export type WebhookDiagnosticCode =
  | "SHIP_WEBHOOK_DEFINITION_INVALID"
  | "SHIP_WEBHOOK_ID_INVALID"
  | "SHIP_WEBHOOK_PATH_INVALID"
  | "SHIP_WEBHOOK_PROVIDER_INVALID"
  | "SHIP_WEBHOOK_VERIFIER_INVALID"
  | "SHIP_WEBHOOK_VERIFIER_GUARANTEES_UNDECLARED"
  | "SHIP_WEBHOOK_SECRET_INVALID"
  | "SHIP_WEBHOOK_BODY_POLICY_INVALID"
  | "SHIP_WEBHOOK_IDEMPOTENCY_INVALID"
  | "SHIP_WEBHOOK_IDEMPOTENCY_STORE_REQUIRED"
  | "SHIP_WEBHOOK_IN_FLIGHT_POLICY_INVALID"
  | "SHIP_WEBHOOK_EFFECT_TRANSACTION_FORBIDDEN"
  | "SHIP_WEBHOOK_RECEIVE_INVALID"
  | "SHIP_WEBHOOK_OUTBOX_INTENT_UNKNOWN"
  | "SHIP_WEBHOOK_RETENTION_REQUIRED"
  | "SHIP_WEBHOOK_RETENTION_INVALID"
  | "SHIP_WEBHOOK_HANDLER_INVALID"
  | "SHIP_WEBHOOK_OPERATIONS_INVALID"
  | "SHIP_WEBHOOK_RESPONSE_INVALID"
  | "SHIP_WEBHOOK_TRANSPORT_INVALID"
  | "SHIP_WEBHOOK_CACHE_FORBIDDEN";

export class InvalidWebhookDefinitionError extends Error {
  readonly code: WebhookDiagnosticCode;
  readonly webhookId?: string;
  readonly field?: string;

  constructor(
    code: WebhookDiagnosticCode,
    message: string,
    options: { readonly webhookId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidWebhookDefinitionError";
    this.code = code;
    this.webhookId = options.webhookId;
    this.field = options.field;
  }
}

export function defineWebhookVerifier(definition: WebhookVerifier): WebhookVerifier {
  assertVerifier(definition);
  return Object.freeze({
    id: definition.id,
    guarantees: Object.freeze({
      signature: definition.guarantees.signature,
      freshness: definition.guarantees.freshness,
      replay: definition.guarantees.replay,
    }),
    ...(definition.sensitiveHeaders
      ? {
          sensitiveHeaders: Object.freeze(
            definition.sensitiveHeaders.map((header) => header.toLowerCase()),
          ),
        }
      : {}),
    verify: definition.verify,
  });
}

export function isWebhookVerifier(value: unknown): value is WebhookVerifier {
  if (typeof value !== "object" || value === null) return false;
  const guarantees = Reflect.get(value, "guarantees");
  const sensitiveHeaders = Reflect.get(value, "sensitiveHeaders");
  return (
    typeof Reflect.get(value, "id") === "string" &&
    IDENTIFIER_PATTERN.test(Reflect.get(value, "id")) &&
    typeof guarantees === "object" &&
    guarantees !== null &&
    ["signature", "freshness", "replay"].every(
      (flag) => typeof Reflect.get(guarantees, flag) === "boolean",
    ) &&
    (sensitiveHeaders === undefined ||
      (Array.isArray(sensitiveHeaders) &&
        sensitiveHeaders.every((header) => typeof header === "string" && header.length > 0))) &&
    typeof Reflect.get(value, "verify") === "function"
  );
}

export function isWebhookVerification(value: unknown): value is WebhookVerification {
  if (typeof value !== "object" || value === null) return false;
  const ok = Reflect.get(value, "ok");
  if (ok === true) {
    const eventId = Reflect.get(value, "eventId");
    const timestamp = Reflect.get(value, "timestamp");
    return (
      (eventId === undefined || (typeof eventId === "string" && eventId.length > 0)) &&
      (timestamp === undefined ||
        (timestamp instanceof Date && Number.isFinite(timestamp.getTime())))
    );
  }
  if (ok !== false) return false;
  const reason = Reflect.get(value, "reason");
  return (
    reason === "missing-signature" ||
    reason === "malformed-signature" ||
    reason === "signature-mismatch" ||
    reason === "timestamp-missing" ||
    reason === "timestamp-stale" ||
    reason === "unsupported-request"
  );
}

/** A fixed secret list for environments that inject secrets at boot. Newest first. */
export function webhookSecret(...secrets: readonly string[]): WebhookSecretSource {
  const values = Object.freeze([...secrets]);
  if (values.length === 0 || values.some((value) => typeof value !== "string" || value === "")) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_SECRET_INVALID",
      "webhookSecret requires at least one non-empty secret",
      { field: "secret" },
    );
  }
  return Object.freeze({
    kind: "ship.webhook-secret" as const,
    id: "static",
    current: () => values,
  });
}

/** A live secret source (vault, KMS, rotating config). */
export function webhookSecretSource(definition: {
  readonly id: string;
  readonly current: WebhookSecretSource["current"];
}): WebhookSecretSource {
  if (
    typeof definition !== "object" ||
    definition === null ||
    typeof definition.id !== "string" ||
    !IDENTIFIER_PATTERN.test(definition.id) ||
    typeof definition.current !== "function"
  ) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_SECRET_INVALID",
      "webhookSecretSource requires a lowercase id and a current() function",
      { field: "secret" },
    );
  }
  return Object.freeze({
    kind: "ship.webhook-secret" as const,
    id: definition.id,
    current: definition.current,
  });
}

export function isWebhookSecretSource(value: unknown): value is WebhookSecretSource {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.webhook-secret" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "current") === "function"
  );
}

/**
 * Binds a verifier to a provider id and secret source. The provider id defaults
 * to the verifier id; declare it when one scheme serves several providers.
 */
export function webhookVerifierToken(definition: {
  readonly provider?: string;
  readonly verifier: WebhookVerifier;
  readonly secret: WebhookSecretSource;
}): WebhookVerifierToken {
  if (typeof definition !== "object" || definition === null) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_PROVIDER_INVALID",
      "webhookVerifierToken requires { verifier, secret }",
    );
  }
  assertVerifier(definition.verifier);
  if (!isWebhookSecretSource(definition.secret)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_SECRET_INVALID",
      "webhook secret must come from webhookSecret() or webhookSecretSource()",
      { field: "secret" },
    );
  }
  const provider = definition.provider ?? definition.verifier.id;
  if (typeof provider !== "string" || !IDENTIFIER_PATTERN.test(provider)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_PROVIDER_INVALID",
      `webhook provider id must be a lowercase dot-separated identifier; received ${JSON.stringify(provider)}`,
      { field: "provider" },
    );
  }
  return Object.freeze({
    kind: "ship.webhook-verifier" as const,
    provider,
    verifier: defineWebhookVerifier(definition.verifier),
    secret: definition.secret,
  });
}

export function isWebhookVerifierToken(value: unknown): value is WebhookVerifierToken {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.webhook-verifier" &&
    typeof Reflect.get(value, "provider") === "string" &&
    IDENTIFIER_PATTERN.test(Reflect.get(value, "provider")) &&
    isWebhookVerifier(Reflect.get(value, "verifier")) &&
    isWebhookSecretSource(Reflect.get(value, "secret"))
  );
}

// ---------------------------------------------------------------------------
// Event store contract (receive-then-process)
// ---------------------------------------------------------------------------

export interface WebhookEventInput {
  /** Framework-generated durable event identity (UUID). */
  readonly id: string;
  readonly webhookId: string;
  readonly provider: string;
  /** The provider's own event identity when the verifier or key derivation exposes one. */
  readonly providerEventId?: string;
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly contentType?: string;
  /** Lower-cased headers with sensitive names already removed. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface StoredWebhookEvent extends WebhookEventInput {
  readonly outboxRecordId?: string;
}

export interface WebhookEventCleanupRequest {
  readonly webhookId: string;
  /** Events received before this instant are eligible unless their intent is undispatched. */
  readonly eventsBefore: Date;
  /** Idempotency claims that expired before this instant are deleted. */
  readonly claimsBefore: Date;
  /** The executor's key namespace for this webhook: `<operationId>:`. */
  readonly claimKeyPrefix: string;
}

export interface WebhookEventCleanupResult {
  readonly eventsDeleted: number;
  readonly claimsDeleted: number;
}

/**
 * Durable raw-event storage. `record` and `link` receive the active
 * unit-of-work capability map as `scope` so the event, its outbox intent, and
 * the idempotency claim commit or roll back together. `cleanup` must never
 * delete an event whose linked outbox record is still pending or claimed.
 */
export interface WebhookEventStore {
  readonly kind: "ship.webhook-event-store";
  record(scope: object, event: WebhookEventInput): Promise<void>;
  link(scope: object, eventId: string, outboxRecordId: string): Promise<void>;
  read(eventId: string): Promise<StoredWebhookEvent | undefined>;
  cleanup(request: WebhookEventCleanupRequest): Promise<WebhookEventCleanupResult>;
  /**
   * Optional operator-facing listing, most recently received first. Stores
   * that omit it still satisfy the contract; an ops console reports the
   * missing capability instead of failing.
   */
  list?(query: WebhookEventQuery): Promise<readonly StoredWebhookEvent[]>;
}

export interface WebhookEventQuery {
  /** Restrict to one declared webhook. */
  readonly webhookId?: string;
  /** Events received strictly before this instant, for paging backwards. */
  readonly before?: Date;
  readonly limit: number;
}

export function webhookEventStoreDependency(id: string): DependencyToken<WebhookEventStore> {
  return dependency<WebhookEventStore>(id);
}

export function isWebhookEventStore(value: unknown): value is WebhookEventStore {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.webhook-event-store" &&
    ["record", "link", "read", "cleanup"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}

/** The outbox payload an enqueue-mode webhook records; it references, never embeds, the event. */
export const webhookEventReferenceSchema = objectSchema({
  eventId: stringSchema({ minLength: 1 }),
  webhookId: stringSchema({ minLength: 1 }),
  provider: stringSchema({ minLength: 1 }),
  receivedAt: stringSchema({ minLength: 1 }),
});

export type WebhookEventReference = InferSchemaOutput<typeof webhookEventReferenceSchema>;

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export type WebhookReceiptOutcome =
  | "accepted"
  | "duplicate"
  | "rejected"
  | "in-flight"
  | "unavailable"
  | "failed";

export interface WebhookReceiptEvent {
  readonly webhookId: string;
  readonly provider: string;
  readonly outcome: WebhookReceiptOutcome;
  readonly status: number;
  /** Verification failure reason or framework diagnostic code; never body content. */
  readonly reason?: string;
  readonly durationMs: number;
}

export interface WebhookDispatchEvent {
  readonly webhookId: string;
  readonly provider: string;
  /** Milliseconds between durable receipt and the dispatcher performing the intent. */
  readonly lagMs: number;
}

/** Transport- and vendor-neutral hook; `@sixthsummit/ship-observability-otel` provides a metrics implementation. */
export interface WebhookObserver {
  received?(event: WebhookReceiptEvent): void;
  dispatched?(event: WebhookDispatchEvent): void;
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

export interface WebhookBodyPolicy {
  readonly maxBytes: number;
  readonly mediaTypes: readonly string[];
}

export type WebhookInFlightPolicy =
  | { readonly kind: "wait"; readonly maxMs: number }
  | { readonly kind: "retry"; readonly status: number };

export interface WebhookVerified {
  readonly eventId?: string;
  /** ISO-8601 timestamp the verifier authenticated, when the scheme carries one. */
  readonly timestamp?: string;
  /** Lower-case hex SHA-256 of the raw body; the default idempotency key when no event id exists. */
  readonly bodyDigest: string;
}

export interface WebhookReceipt {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Uint8Array;
  readonly verified: WebhookVerified;
}

export interface WebhookIdempotency {
  /** Defaults to the verifier event id, then the raw-body digest. Must return a non-empty string. */
  readonly key?: (receipt: WebhookReceipt) => string;
  readonly windowMs: number;
  readonly store: IdempotencyStoreDependencyToken;
  readonly inFlight: WebhookInFlightPolicy;
}

export type WebhookRetention = {
  /** Stored raw events older than this are deleted by the cleanup operation once dispatched. */
  readonly eventsMs: number;
  /** Expired idempotency claims older than this are deleted by the cleanup operation. */
  readonly claimsMs: number;
};

/**
 * How a webhook acknowledges a verified delivery on the wire. `json` (the
 * default) serializes the declared output; `text` and `binary` send the
 * handler's string or bytes under the declared content type, which providers
 * such as voice platforms execute; `empty` answers the success status with no
 * entity body and no content type. Failures always use the JSON envelope.
 */
export type WebhookResponseDeclaration =
  | { readonly mode: "json" }
  | { readonly mode: "text"; readonly contentType: string }
  | { readonly mode: "binary"; readonly contentType: string }
  | { readonly mode: "empty" };

export type WebhookResponseMode = WebhookResponseDeclaration["mode"];

const DEFAULT_WEBHOOK_RESPONSE: WebhookResponseDeclaration = Object.freeze({
  mode: "json" as const,
});

export type WebhookInputSchemas = {
  readonly headers: ReturnType<typeof headersSchema>;
  readonly body: ReturnType<typeof bytesSchema>;
  readonly verified: ReturnType<typeof verifiedSchema>;
};

/** JSON-safe webhook facts projected into the graph, client contract and OpenAPI. */
export type WebhookTransportMetadata = {
  readonly id: string;
  readonly provider: string;
  readonly verifier: string;
  readonly guarantees: WebhookVerifierGuarantees;
  readonly mode: "inline" | "enqueue";
  readonly response: WebhookResponseDeclaration;
  readonly idempotency: {
    readonly windowMs: number;
    readonly inFlight: WebhookInFlightPolicy;
  };
  readonly retention?: WebhookRetention;
  readonly outbox?: { readonly id: string; readonly intent: string };
};

/**
 * Structurally identical to a `ship-hono` raw-body POST transport plus webhook
 * metadata. `response` is the declared mode; `contentType` is present for every
 * mode except `empty`, whose acknowledgement carries no entity body.
 */
export interface WebhookTransport<TPath extends string = string> extends OperationTransport {
  readonly kind: "http";
  readonly binding: `POST ${TPath}`;
  readonly metadata: {
    readonly method: "POST";
    readonly path: TPath;
    readonly response: WebhookResponseMode;
    readonly contentType?: string;
    readonly requestBody: {
      readonly mode: "raw";
      readonly maxBytes: number;
      readonly contentTypes: readonly string[];
    };
    readonly webhook: WebhookTransportMetadata;
  };
}

interface WebhookDefinitionBase<TId extends string, TPath extends string> {
  readonly id: TId;
  readonly path: TPath;
  readonly provider: WebhookVerifierToken;
  readonly body: WebhookBodyPolicy;
  readonly idempotency: WebhookIdempotency;
  readonly retention?: WebhookRetention;
  /** Wire representation of a successful acknowledgement; defaults to `{ mode: "json" }`. */
  readonly response?: WebhookResponseDeclaration;
}

export interface WebhookHandlerArguments<
  TDependencies extends DependencyBindings,
  TAccess extends ProviderAccess = ProviderAccess,
> {
  readonly event: WebhookReceipt;
  readonly services: ResolveDependencyBindings<TDependencies>;
  readonly context: OperationContextForAccess<TAccess>;
}

export interface InlineWebhookDefinition<
  TId extends string,
  TPath extends string,
  TOutput extends OperationOutputSchemas,
  TDependencies extends DependencyBindings,
  TErrors extends readonly OperationErrorDefinition[],
  TTransaction extends OperationTransactionMode,
  TSuccessStatus extends OperationOutputStatus<TOutput>,
  TEffects extends readonly EffectDependencyToken[],
> extends WebhookDefinitionBase<TId, TPath> {
  readonly response?: { readonly mode: "json" };
  readonly output: TOutput;
  readonly successStatus: TSuccessStatus;
  readonly errors?: TErrors;
  readonly transaction: TTransaction;
  readonly dependencies: TDependencies;
  readonly effects?: TEffects;
  readonly handler: (
    arguments_: WebhookHandlerArguments<TDependencies>,
  ) => OperationHandlerResult<TOutput, TSuccessStatus>;
  readonly receive?: undefined;
}

/** A handler answer for a body-carrying non-JSON mode: the body itself or `respond(status, body)`. */
export type WebhookBodyHandlerResult<TBody, TSuccessStatus extends number> =
  | TBody
  | ExplicitOperationResponse<TSuccessStatus, TBody>
  | Promise<TBody | ExplicitOperationResponse<TSuccessStatus, TBody>>;

/** Framework-owned output schemas for the non-JSON response modes. */
export type WebhookTextOutput<TSuccessStatus extends number> = {
  readonly [TStatus in TSuccessStatus]: ReturnType<typeof stringSchema>;
};
export type WebhookBinaryOutput<TSuccessStatus extends number> = {
  readonly [TStatus in TSuccessStatus]: ReturnType<typeof bytesSchema>;
};
export type WebhookEmptyOutput<TSuccessStatus extends number> = {
  readonly [TStatus in TSuccessStatus]: ReturnType<typeof emptySchema>;
};

interface BodyModeWebhookDefinitionBase<
  TId extends string,
  TPath extends string,
  TDependencies extends DependencyBindings,
  TErrors extends readonly OperationErrorDefinition[],
  TTransaction extends OperationTransactionMode,
  TSuccessStatus extends number,
  TEffects extends readonly EffectDependencyToken[],
> extends WebhookDefinitionBase<TId, TPath> {
  /** Defaults to `200`. The output schema is framework-owned for these modes. */
  readonly successStatus?: TSuccessStatus;
  readonly output?: undefined;
  readonly errors?: TErrors;
  readonly transaction: TTransaction;
  readonly dependencies: TDependencies;
  readonly effects?: TEffects;
  readonly receive?: undefined;
}

/** `response: { mode: "text", contentType }`: the handler returns the document as a string. */
export interface TextWebhookDefinition<
  TId extends string,
  TPath extends string,
  TDependencies extends DependencyBindings,
  TErrors extends readonly OperationErrorDefinition[],
  TTransaction extends OperationTransactionMode,
  TSuccessStatus extends number,
  TEffects extends readonly EffectDependencyToken[],
> extends BodyModeWebhookDefinitionBase<
    TId,
    TPath,
    TDependencies,
    TErrors,
    TTransaction,
    TSuccessStatus,
    TEffects
  > {
  readonly response: { readonly mode: "text"; readonly contentType: string };
  readonly handler: (
    arguments_: WebhookHandlerArguments<TDependencies>,
  ) => WebhookBodyHandlerResult<string, TSuccessStatus>;
}

/** `response: { mode: "binary", contentType }`: the handler returns the body bytes. */
export interface BinaryWebhookDefinition<
  TId extends string,
  TPath extends string,
  TDependencies extends DependencyBindings,
  TErrors extends readonly OperationErrorDefinition[],
  TTransaction extends OperationTransactionMode,
  TSuccessStatus extends number,
  TEffects extends readonly EffectDependencyToken[],
> extends BodyModeWebhookDefinitionBase<
    TId,
    TPath,
    TDependencies,
    TErrors,
    TTransaction,
    TSuccessStatus,
    TEffects
  > {
  readonly response: { readonly mode: "binary"; readonly contentType: string };
  readonly handler: (
    arguments_: WebhookHandlerArguments<TDependencies>,
  ) => WebhookBodyHandlerResult<Uint8Array, TSuccessStatus>;
}

/** `response: { mode: "empty" }`: the handler returns nothing; the adapter answers a bodiless status. */
export interface EmptyWebhookDefinition<
  TId extends string,
  TPath extends string,
  TDependencies extends DependencyBindings,
  TErrors extends readonly OperationErrorDefinition[],
  TTransaction extends OperationTransactionMode,
  TSuccessStatus extends number,
  TEffects extends readonly EffectDependencyToken[],
> extends BodyModeWebhookDefinitionBase<
    TId,
    TPath,
    TDependencies,
    TErrors,
    TTransaction,
    TSuccessStatus,
    TEffects
  > {
  readonly response: { readonly mode: "empty" };
  readonly handler: (
    arguments_: WebhookHandlerArguments<TDependencies>,
  ) => WebhookBodyHandlerResult<undefined, TSuccessStatus> | void | Promise<void>;
}

export interface WebhookEnqueueReceive<
  TIntents extends OutboxIntentDefinitions = OutboxIntentDefinitions,
> {
  readonly mode: "enqueue";
  readonly outbox: Outbox<string, TIntents>;
  readonly intent: Extract<keyof TIntents, string>;
  readonly store: DependencyToken<WebhookEventStore>;
  readonly unitOfWork: UnitOfWorkDependencyToken<unknown>;
}

export interface EnqueueWebhookDefinition<
  TId extends string,
  TPath extends string,
  TIntents extends OutboxIntentDefinitions,
> extends WebhookDefinitionBase<TId, TPath> {
  readonly receive: WebhookEnqueueReceive<TIntents>;
  readonly retention: WebhookRetention;
  readonly handler?: undefined;
}

const acceptedSchema = objectSchema({
  accepted: booleanSchema(),
  eventId: stringSchema({ minLength: 1 }),
});

export type WebhookAccepted = InferSchemaOutput<typeof acceptedSchema>;

export type EnqueueWebhookDependencies = {
  readonly tx: UnitOfWorkDependencyToken<unknown>;
  readonly outbox: OutboxWriterDependencyToken<OutboxIntentDefinitions>;
  readonly events: DependencyToken<WebhookEventStore>;
};

interface WebhookBase<TId extends string> {
  readonly kind: "ship.webhook";
  readonly id: TId;
  readonly provider: WebhookVerifierToken;
  readonly path: string;
  readonly body: WebhookBodyPolicy;
  readonly idempotency: Required<WebhookIdempotency>;
  readonly retention?: WebhookRetention;
  readonly response: WebhookResponseDeclaration;
}

export interface InlineWebhook<
  TId extends string,
  TPath extends string,
  TOutput extends OperationOutputSchemas,
  TDependencies extends DependencyBindings,
  TErrors extends readonly OperationErrorDefinition[],
  TTransaction extends OperationTransactionMode,
  TSuccessStatus extends OperationOutputStatus<TOutput>,
  TEffects extends readonly EffectDependencyToken[],
> extends WebhookBase<TId> {
  readonly mode: "inline";
  readonly operation: Operation<
    TId,
    WebhookInputSchemas,
    TOutput,
    TDependencies,
    TErrors,
    ProviderAccess,
    TTransaction,
    TSuccessStatus,
    TEffects,
    WebhookTransport<TPath>
  >;
}

export interface EnqueueWebhook<
  TId extends string,
  TPath extends string,
  TIntents extends OutboxIntentDefinitions,
> extends WebhookBase<TId> {
  readonly mode: "enqueue";
  readonly retention: WebhookRetention;
  readonly receive: WebhookEnqueueReceive<TIntents>;
  readonly operation: Operation<
    TId,
    WebhookInputSchemas,
    { readonly 202: typeof acceptedSchema },
    EnqueueWebhookDependencies,
    readonly [],
    ProviderAccess,
    "write",
    202,
    readonly [],
    WebhookTransport<TPath>
  >;
}

/** Runtime shape of an enqueue receive declaration without the intent-level generics. */
export interface AnyWebhookEnqueueReceive {
  readonly mode: "enqueue";
  readonly outbox: AnyOutbox;
  readonly intent: string;
  readonly store: DependencyToken<WebhookEventStore>;
  readonly unitOfWork: UnitOfWorkDependencyToken<unknown>;
}

/** Runtime shape shared by inline and enqueue webhooks. */
export interface AnyWebhook {
  readonly kind: "ship.webhook";
  readonly id: string;
  readonly provider: WebhookVerifierToken;
  readonly path: string;
  readonly body: WebhookBodyPolicy;
  readonly idempotency: Required<WebhookIdempotency>;
  readonly retention?: WebhookRetention;
  readonly response: WebhookResponseDeclaration;
  readonly mode: "inline" | "enqueue";
  readonly receive?: AnyWebhookEnqueueReceive;
  readonly operation: AnyOperation;
}

export type WebhookOperationRole =
  | { readonly role: "receive"; readonly webhook: AnyWebhook }
  | { readonly role: "replay"; readonly webhookIds: readonly string[] }
  | { readonly role: "cleanup"; readonly webhookIds: readonly string[] };

const webhookOperationRoles = new WeakMap<object, WebhookOperationRole>();

/** Identifies framework-generated webhook operations for adapters, projection and tooling. */
export function describeWebhookOperation(
  operation: AnyOperation,
): WebhookOperationRole | undefined {
  return webhookOperationRoles.get(operation);
}

export function isWebhook(value: unknown): value is AnyWebhook {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.webhook" &&
    typeof Reflect.get(value, "id") === "string" &&
    isWebhookVerifierToken(Reflect.get(value, "provider")) &&
    typeof Reflect.get(value, "operation") === "object"
  );
}

export function defineWebhook<
  const TId extends string,
  const TPath extends string,
  const TOutput extends OperationOutputSchemas,
  const TDependencies extends DependencyBindings,
  const TErrors extends readonly OperationErrorDefinition[] = readonly [],
  const TTransaction extends OperationTransactionMode = "none",
  const TSuccessStatus extends OperationOutputStatus<TOutput> = OperationOutputStatus<TOutput>,
  const TEffects extends readonly EffectDependencyToken[] = readonly [],
>(
  definition: InlineWebhookDefinition<
    TId,
    TPath,
    TOutput,
    TDependencies,
    TErrors,
    TTransaction,
    TSuccessStatus,
    TEffects
  >,
): InlineWebhook<
  TId,
  TPath,
  TOutput,
  TDependencies,
  TErrors,
  TTransaction,
  TSuccessStatus,
  TEffects
>;
export function defineWebhook<
  const TId extends string,
  const TPath extends string,
  const TDependencies extends DependencyBindings,
  const TErrors extends readonly OperationErrorDefinition[] = readonly [],
  const TTransaction extends OperationTransactionMode = "none",
  const TSuccessStatus extends number = 200,
  const TEffects extends readonly EffectDependencyToken[] = readonly [],
>(
  definition: TextWebhookDefinition<
    TId,
    TPath,
    TDependencies,
    TErrors,
    TTransaction,
    TSuccessStatus,
    TEffects
  >,
): InlineWebhook<
  TId,
  TPath,
  WebhookTextOutput<TSuccessStatus>,
  TDependencies,
  TErrors,
  TTransaction,
  OperationOutputStatus<WebhookTextOutput<TSuccessStatus>>,
  TEffects
>;
export function defineWebhook<
  const TId extends string,
  const TPath extends string,
  const TDependencies extends DependencyBindings,
  const TErrors extends readonly OperationErrorDefinition[] = readonly [],
  const TTransaction extends OperationTransactionMode = "none",
  const TSuccessStatus extends number = 200,
  const TEffects extends readonly EffectDependencyToken[] = readonly [],
>(
  definition: BinaryWebhookDefinition<
    TId,
    TPath,
    TDependencies,
    TErrors,
    TTransaction,
    TSuccessStatus,
    TEffects
  >,
): InlineWebhook<
  TId,
  TPath,
  WebhookBinaryOutput<TSuccessStatus>,
  TDependencies,
  TErrors,
  TTransaction,
  OperationOutputStatus<WebhookBinaryOutput<TSuccessStatus>>,
  TEffects
>;
export function defineWebhook<
  const TId extends string,
  const TPath extends string,
  const TDependencies extends DependencyBindings,
  const TErrors extends readonly OperationErrorDefinition[] = readonly [],
  const TTransaction extends OperationTransactionMode = "none",
  const TSuccessStatus extends number = 200,
  const TEffects extends readonly EffectDependencyToken[] = readonly [],
>(
  definition: EmptyWebhookDefinition<
    TId,
    TPath,
    TDependencies,
    TErrors,
    TTransaction,
    TSuccessStatus,
    TEffects
  >,
): InlineWebhook<
  TId,
  TPath,
  WebhookEmptyOutput<TSuccessStatus>,
  TDependencies,
  TErrors,
  TTransaction,
  OperationOutputStatus<WebhookEmptyOutput<TSuccessStatus>>,
  TEffects
>;
export function defineWebhook<
  const TId extends string,
  const TPath extends string,
  const TIntents extends OutboxIntentDefinitions,
>(definition: EnqueueWebhookDefinition<TId, TPath, TIntents>): EnqueueWebhook<TId, TPath, TIntents>;
/**
 * Declares an inbound webhook as an HTTP operation with a bounded raw body,
 * provider-scoped access, and executor-enforced idempotency. The transport
 * adapter verifies the exact bytes with the bound verifier before any actor,
 * claim, or handler work; the provider actor exists only after that succeeds.
 *
 * Inline mode runs the consumer handler once per unique event. Enqueue mode
 * persists the raw event and one outbox intent in a single write transaction
 * and acknowledges with 202 only after that commit.
 *
 * `response` selects the wire form of a successful acknowledgement: `json`
 * (default), `text` or `binary` under a declared content type, or `empty`.
 */
export function defineWebhook(definition: unknown): AnyWebhook {
  const base = assertBaseDefinition(definition);
  const response = normalizeResponse(base.id, base.response);
  const idempotency = Object.freeze({
    key: base.idempotency.key ?? defaultIdempotencyKey,
    windowMs: base.idempotency.windowMs,
    store: base.idempotency.store,
    inFlight: freezeInFlight(base.idempotency.inFlight),
  });
  const body = Object.freeze({
    maxBytes: base.body.maxBytes,
    mediaTypes: Object.freeze(base.body.mediaTypes.map((type) => type.toLowerCase())),
  });
  const retention = base.retention ? Object.freeze({ ...base.retention }) : undefined;
  const receive = Reflect.get(definition as object, "receive");
  const input = Object.freeze({
    headers: headersSchema(),
    body: bytesSchema(),
    verified: verifiedSchema(),
  });
  const operationIdempotency = {
    key: (input: InferOperationInput<WebhookInputSchemas>) =>
      idempotency.key({ headers: input.headers, rawBody: input.body, verified: input.verified }),
    windowMs: idempotency.windowMs,
    store: idempotency.store,
  };

  if (receive !== undefined) {
    const enqueue = assertEnqueueReceive(base.id, receive);
    if (response.mode !== "json") {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_RESPONSE_INVALID",
        `webhook ${JSON.stringify(base.id)} acknowledges durable receipt with a JSON 202 body; response mode ${JSON.stringify(response.mode)} is only available to inline webhooks`,
        { webhookId: base.id, field: "response" },
      );
    }
    if (!retention) {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_RETENTION_REQUIRED",
        `webhook ${JSON.stringify(base.id)} persists received events and must declare retention: { eventsMs, claimsMs }`,
        { webhookId: base.id, field: "retention" },
      );
    }
    const metadata = transportMetadata(base, idempotency, "enqueue", response, retention, {
      id: enqueue.outbox.id,
      intent: enqueue.intent,
    });
    const provider = base.provider;
    const sensitive = new Set([
      ...WEBHOOK_REDACTED_HEADERS,
      ...(provider.verifier.sensitiveHeaders ?? []),
    ]);
    const operation = defineOperation({
      id: base.id,
      transport: webhookTransport(base.path, body, response, metadata),
      input,
      output: { 202: acceptedSchema },
      successStatus: 202,
      errors: [],
      access: providerAccess(provider.provider),
      transaction: "write",
      dependencies: {
        tx: enqueue.unitOfWork,
        outbox: outboxDependency(enqueue.outbox),
        events: enqueue.store,
      },
      idempotency: operationIdempotency,
      handler: async ({ input, services, context }) => {
        const store = services.events;
        if (!isWebhookEventStore(store)) {
          throw new TypeError(
            `provider ${JSON.stringify(enqueue.store.id)} did not create a webhook event store`,
          );
        }
        const scope = services.tx as object;
        const eventId = globalThis.crypto.randomUUID();
        const receivedAt = new Date();
        await store.record(scope, {
          id: eventId,
          webhookId: base.id,
          provider: provider.provider,
          ...(input.verified.eventId ? { providerEventId: input.verified.eventId } : {}),
          requestId: context.requestId,
          receivedAt,
          ...(input.headers["content-type"] ? { contentType: input.headers["content-type"] } : {}),
          headers: redactHeaders(input.headers, sensitive),
          body: input.body,
        });
        const queued = await (services.outbox as OutboxWriter<OutboxIntentDefinitions>).enqueue(
          enqueue.intent,
          {
            eventId,
            webhookId: base.id,
            provider: provider.provider,
            receivedAt: receivedAt.toISOString(),
          },
          { dedupeKey: eventId },
        );
        if (!queued.deduplicated) await store.link(scope, eventId, queued.recordId);
        return { accepted: true, eventId };
      },
    });
    const webhook: AnyWebhook = Object.freeze({
      kind: "ship.webhook" as const,
      id: base.id,
      provider,
      path: base.path,
      body,
      idempotency,
      retention,
      response,
      mode: "enqueue" as const,
      receive: Object.freeze({
        mode: "enqueue" as const,
        outbox: enqueue.outbox as unknown as AnyOutbox,
        intent: enqueue.intent,
        store: enqueue.store,
        unitOfWork: enqueue.unitOfWork,
      }),
      operation,
    });
    webhookOperationRoles.set(operation, Object.freeze({ role: "receive" as const, webhook }));
    return webhook;
  }

  const inline = assertInlineDefinition(base.id, definition as object, response);
  const metadata = transportMetadata(base, idempotency, "inline", response, retention);
  const handler = inline.handler;
  const successStatus = inline.successStatus ?? 200;
  const output = inlineOutput(response, successStatus, inline.output);
  const operation = defineOperation({
    id: base.id,
    transport: webhookTransport(base.path, body, response, metadata),
    input,
    output,
    successStatus,
    errors: inline.errors ?? [],
    access: providerAccess(base.provider.provider),
    transaction: inline.transaction,
    dependencies: inline.dependencies,
    effects: inline.effects ?? [],
    idempotency: operationIdempotency,
    handler: ({ input, services, context }) =>
      handler({
        event: { headers: input.headers, rawBody: input.body, verified: input.verified },
        services,
        context,
      }),
  });
  const webhook: AnyWebhook = Object.freeze({
    kind: "ship.webhook" as const,
    id: base.id,
    provider: base.provider,
    path: base.path,
    body,
    idempotency,
    ...(retention ? { retention } : {}),
    response,
    mode: "inline" as const,
    operation,
  });
  webhookOperationRoles.set(operation, Object.freeze({ role: "receive" as const, webhook }));
  return webhook;
}

/** Removes credential-bearing headers before an event is persisted. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  sensitive: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(headers).filter(([name]) => !sensitive.has(name.toLowerCase())),
    ),
  );
}

function defaultIdempotencyKey(receipt: WebhookReceipt): string {
  return receipt.verified.eventId ?? receipt.verified.bodyDigest;
}

// ---------------------------------------------------------------------------
// Outbox intent helper for enqueue mode
// ---------------------------------------------------------------------------

export interface WebhookIntentPerformArguments<TEffect> {
  readonly effect: TEffect;
  readonly event: WebhookEventReference;
  readonly record: OutboxRecord;
  readonly context: OutboxPerformArguments<TEffect, WebhookEventReference>["context"];
}

/**
 * Declares the outbox intent an enqueue-mode webhook records. The payload is
 * the framework event reference; `perform` receives it typed, and the
 * optional observer receives receive-to-dispatch lag for metrics.
 */
export function webhookIntent<TEffect extends EffectDependencyToken>(definition: {
  readonly effect: TEffect;
  readonly perform: (
    arguments_: WebhookIntentPerformArguments<
      TEffect extends EffectDependencyToken<infer TValue> ? TValue : never
    >,
  ) => void | Promise<void>;
  readonly observer?: WebhookObserver;
  readonly clock?: () => Date;
}): OutboxIntentDefinition<typeof webhookEventReferenceSchema, TEffect> {
  if (typeof definition?.perform !== "function") {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_HANDLER_INVALID",
      "webhookIntent requires perform({ effect, event, record, context })",
      { field: "perform" },
    );
  }
  const clock = definition.clock ?? (() => new Date());
  return outboxIntent({
    payload: webhookEventReferenceSchema,
    effect: definition.effect,
    perform: async ({ effect, payload, record, context }) => {
      const receivedAt = Date.parse(payload.receivedAt);
      if (Number.isFinite(receivedAt)) {
        definition.observer?.dispatched?.({
          webhookId: payload.webhookId,
          provider: payload.provider,
          lagMs: Math.max(0, clock().getTime() - receivedAt),
        });
      }
      await definition.perform({ effect, event: payload, record, context } as never);
    },
  });
}

// ---------------------------------------------------------------------------
// Replay and cleanup operations
// ---------------------------------------------------------------------------

export const webhookEventNotFound = operationError({
  code: "WEBHOOK_EVENT_NOT_FOUND",
  status: 404,
  message: "Stored webhook event not found",
});

const replayBodySchema = objectSchema({ eventId: stringSchema({ minLength: 1 }) });
const replayOutputSchema = objectSchema({
  eventId: stringSchema({ minLength: 1 }),
  webhookId: stringSchema({ minLength: 1 }),
  queued: booleanSchema(),
});
const cleanupOutputSchema = objectSchema({
  eventsDeleted: integerSchema({ minimum: 0 }),
  claimsDeleted: integerSchema({ minimum: 0 }),
});

/** The params schema of a replay whose path parameter is `TName`: one required non-empty string. */
export type WebhookReplayParamsSchema<TName extends string> = FrameworkFieldSchema<{
  readonly [TKey in TName]: string;
}>;

function replayParamsSchema<TName extends string>(name: TName): WebhookReplayParamsSchema<TName> {
  return objectSchema({
    [name]: stringSchema({ minLength: 1 }),
  }) as WebhookReplayParamsSchema<TName>;
}

/**
 * Optional HTTP binding for the replay operation. `{ path }` compiles to a
 * JSON `POST`; a full `http.post(...)` transport is accepted as well. When the
 * path declares one `:name` parameter the event id travels in it, whatever
 * the name (`/webhooks/:id/retry` keeps a legacy route's id in the URL);
 * otherwise it travels as the JSON body `{ eventId }`.
 */
export interface WebhookReplayTransportDeclaration<TPath extends string = string> {
  readonly path: TPath;
  /**
   * Name of the path parameter carrying the event id. Defaults to the single
   * `:name` segment the path declares; naming it is a cross-check that fails
   * `SHIP_WEBHOOK_TRANSPORT_INVALID` when the path declares another name.
   */
  readonly eventIdParameter?: string;
}

/** The single `:name` segment of a replay path, or never when the path declares none. */
export type WebhookReplayPathParameter<TPath extends string> =
  TPath extends `${string}/:${infer TName}/${string}`
    ? TName
    : TPath extends `${string}/:${infer TName}`
      ? TName
      : never;

export type WebhookReplayTransportInput<TPath extends string | undefined> = TPath extends string
  ? [WebhookReplayPathParameter<TPath>] extends [never]
    ? { readonly body: typeof replayBodySchema }
    : { readonly params: WebhookReplayParamsSchema<WebhookReplayPathParameter<TPath>> }
  : { readonly body: typeof replayBodySchema };

/** The JSON POST transport a replay operation mounts through the HTTP adapter. */
export interface WebhookReplayTransport<TPath extends string = string> extends OperationTransport {
  readonly kind: "http";
  readonly binding: `POST ${TPath}`;
  readonly metadata: {
    readonly method: "POST";
    readonly path: TPath;
    readonly response: "json";
    readonly contentType: string;
    readonly requestBody: { readonly mode: "json" };
  };
}

export type WebhookReplayOperation<
  TId extends string,
  TPath extends string | undefined,
> = Operation<
  TId,
  WebhookReplayTransportInput<TPath>,
  { readonly 200: typeof replayOutputSchema },
  DependencyBindings,
  readonly [typeof webhookEventNotFound],
  PermissionAccess,
  "write",
  200,
  readonly [],
  TPath extends string ? WebhookReplayTransport<TPath> : undefined
>;

export interface WebhookReplayDefinition<TId extends string = string> {
  /** Operation id, namespaced by the owning module (for example `ingress.webhook-replay`). */
  readonly id: TId;
  /** Enqueue-mode webhooks whose stored events may be re-enqueued. */
  readonly webhooks: readonly AnyWebhook[];
  readonly unitOfWork: UnitOfWorkDependencyToken<unknown>;
  readonly store: DependencyToken<WebhookEventStore>;
  /** Defaults to `ship.webhooks:replay`. */
  readonly permission?: string;
  /**
   * Mount the replay through the HTTP adapter instead of calling the executor
   * directly. Access stays permission-gated; the adapter's credential adapter
   * and actor resolver authenticate the caller as for any operation.
   */
  readonly transport?:
    | WebhookReplayTransportDeclaration
    | (OperationTransport & { readonly metadata: { readonly path: string } });
}

export interface MountedWebhookReplayDefinition<TId extends string, TPath extends string>
  extends WebhookReplayDefinition<TId> {
  readonly transport:
    | WebhookReplayTransportDeclaration<TPath>
    | (OperationTransport & { readonly metadata: { readonly path: TPath } });
}

/**
 * Generates a permission-gated operation that re-enqueues the outbox intent
 * for a stored event. It never re-verifies or re-reads the provider request:
 * the stored bytes are the durable receipt.
 */
export function defineWebhookReplay<const TId extends string, const TPath extends string>(
  definition: MountedWebhookReplayDefinition<TId, TPath>,
): WebhookReplayOperation<TId, TPath>;
export function defineWebhookReplay<const TId extends string>(
  definition: WebhookReplayDefinition<TId> & { readonly transport?: undefined },
): WebhookReplayOperation<TId, undefined>;
export function defineWebhookReplay(definition: WebhookReplayDefinition): unknown {
  const webhooks = assertEnqueueWebhooks(definition, "defineWebhookReplay");
  assertOperationId(definition.id);
  assertNoReadCache(definition.id, definition);
  const { transport, parameter } = normalizeReplayTransport(definition.id, definition.transport);
  if (!isUnitOfWorkDependencyToken(definition.unitOfWork as DependencyToken)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_OPERATIONS_INVALID",
      "defineWebhookReplay requires a unitOfWorkDependency() token",
      { field: "unitOfWork" },
    );
  }
  if (!isDependencyToken(definition.store)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_OPERATIONS_INVALID",
      "defineWebhookReplay requires a webhookEventStoreDependency() token",
      { field: "store" },
    );
  }
  const outboxes = new Map<string, AnyOutbox>();
  for (const webhook of webhooks) {
    const receive = webhook.receive as AnyWebhookEnqueueReceive;
    outboxes.set(receive.outbox.id, receive.outbox);
  }
  const bindings: Record<string, DependencyToken> = {};
  const bindingByOutbox = new Map<string, string>();
  for (const [outboxId, outbox] of [...outboxes].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const name = uniqueBindingName(outboxId, bindings);
    bindings[name] = outboxDependency(outbox as Outbox<string, OutboxIntentDefinitions>);
    bindingByOutbox.set(outboxId, name);
  }
  const webhookById = new Map(webhooks.map((webhook) => [webhook.id, webhook]));
  const input: Readonly<Record<string, RuntimeSchema>> = parameter
    ? { params: replayParamsSchema(parameter) }
    : { body: replayBodySchema };
  const operation = defineOperation({
    id: definition.id,
    ...(transport ? { transport } : {}),
    input,
    output: { 200: replayOutputSchema },
    successStatus: 200,
    errors: [webhookEventNotFound],
    access: permission(definition.permission ?? WEBHOOK_REPLAY_PERMISSION),
    transaction: "write",
    dependencies: { tx: definition.unitOfWork, events: definition.store, ...bindings },
    handler: async ({ input, services }) => {
      const store = Reflect.get(services, "events");
      if (!isWebhookEventStore(store)) {
        throw new TypeError(
          `provider ${JSON.stringify(definition.store.id)} did not create a webhook event store`,
        );
      }
      const eventId = readReplayEventId(input, parameter);
      const event = await store.read(eventId);
      const webhook = event ? webhookById.get(event.webhookId) : undefined;
      if (!event || !webhook) throw operationFailure(webhookEventNotFound);
      const receive = webhook.receive as AnyWebhookEnqueueReceive;
      const writer = Reflect.get(
        services,
        bindingByOutbox.get(receive.outbox.id) as string,
      ) as OutboxWriter<OutboxIntentDefinitions>;
      const queued = await writer.enqueue(receive.intent, {
        eventId: event.id,
        webhookId: event.webhookId,
        provider: event.provider,
        receivedAt: event.receivedAt.toISOString(),
      });
      if (!queued.deduplicated) {
        await store.link(Reflect.get(services, "tx") as object, event.id, queued.recordId);
      }
      return { eventId: event.id, webhookId: event.webhookId, queued: !queued.deduplicated };
    },
  });
  webhookOperationRoles.set(
    operation,
    Object.freeze({
      role: "replay" as const,
      webhookIds: Object.freeze(webhooks.map((webhook) => webhook.id).sort()),
    }),
  );
  return operation;
}

function readReplayEventId(input: unknown, parameter: string | undefined): string {
  const location = Reflect.get(input as object, parameter ? "params" : "body");
  const eventId = Reflect.get(location as object, parameter ?? REPLAY_DEFAULT_PATH_PARAMETER);
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new TypeError("replay input must carry a non-empty eventId");
  }
  return eventId;
}

export interface WebhookCleanupDefinition<TId extends string = string> {
  readonly id: TId;
  /** Webhooks with declared retention; enqueue-mode webhooks require it. */
  readonly webhooks: readonly AnyWebhook[];
  readonly store: DependencyToken<WebhookEventStore>;
  readonly clock?: () => Date;
}

/**
 * Generates `<id>`: deletes stored events past `retention.eventsMs` whose
 * outbox intent has been dispatched, and expired idempotency claims past
 * `retention.claimsMs`. Scheduling it is the job runner's responsibility.
 */
export function defineWebhookCleanup<const TId extends string>(
  definition: WebhookCleanupDefinition<TId>,
) {
  if (
    typeof definition !== "object" ||
    definition === null ||
    !Array.isArray(definition.webhooks) ||
    definition.webhooks.length === 0 ||
    !definition.webhooks.every(isWebhook)
  ) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_OPERATIONS_INVALID",
      "defineWebhookCleanup requires at least one webhook created by defineWebhook()",
      { field: "webhooks" },
    );
  }
  assertOperationId(definition.id);
  if (!isDependencyToken(definition.store)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_OPERATIONS_INVALID",
      "defineWebhookCleanup requires a webhookEventStoreDependency() token",
      { field: "store" },
    );
  }
  const retained = definition.webhooks.filter(
    (webhook): webhook is AnyWebhook & { readonly retention: WebhookRetention } =>
      webhook.retention !== undefined,
  );
  if (retained.length === 0) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RETENTION_REQUIRED",
      "defineWebhookCleanup requires at least one webhook that declares retention",
      { field: "webhooks" },
    );
  }
  const clock = definition.clock ?? (() => new Date());
  const operation = defineOperation({
    id: definition.id,
    input: {},
    output: { 200: cleanupOutputSchema },
    successStatus: 200,
    errors: [],
    access: systemAccess(),
    transaction: "none",
    dependencies: { events: definition.store },
    handler: async ({ services }) => {
      const store = services.events;
      if (!isWebhookEventStore(store)) {
        throw new TypeError(
          `provider ${JSON.stringify(definition.store.id)} did not create a webhook event store`,
        );
      }
      let eventsDeleted = 0;
      let claimsDeleted = 0;
      for (const webhook of retained) {
        const now = clock();
        const result = await store.cleanup({
          webhookId: webhook.id,
          eventsBefore: new Date(now.getTime() - webhook.retention.eventsMs),
          claimsBefore: new Date(now.getTime() - webhook.retention.claimsMs),
          claimKeyPrefix: `${webhook.id}:`,
        });
        eventsDeleted += result.eventsDeleted;
        claimsDeleted += result.claimsDeleted;
      }
      return { eventsDeleted, claimsDeleted };
    },
  });
  webhookOperationRoles.set(
    operation,
    Object.freeze({
      role: "cleanup" as const,
      webhookIds: Object.freeze(retained.map((webhook) => webhook.id).sort()),
    }),
  );
  return operation;
}

// ---------------------------------------------------------------------------
// Schemas and transport
// ---------------------------------------------------------------------------

function headersSchema() {
  return recordSchema(stringSchema());
}

function verifiedSchema() {
  return objectSchema({
    eventId: optionalSchema(stringSchema({ minLength: 1 })),
    timestamp: optionalSchema(stringSchema({ minLength: 1 })),
    bodyDigest: stringSchema({ minLength: 64 }),
  });
}

function webhookTransport<TPath extends string>(
  path: TPath,
  body: WebhookBodyPolicy,
  response: WebhookResponseDeclaration,
  webhook: WebhookTransportMetadata,
): WebhookTransport<TPath> {
  const contentType =
    response.mode === "json"
      ? WEBHOOK_CONTENT_TYPE
      : response.mode === "empty"
        ? undefined
        : response.contentType;
  return Object.freeze({
    kind: "http" as const,
    binding: `POST ${path}` as const,
    metadata: Object.freeze({
      method: "POST" as const,
      path,
      response: response.mode,
      ...(contentType === undefined ? {} : { contentType }),
      requestBody: Object.freeze({
        mode: "raw" as const,
        maxBytes: body.maxBytes,
        contentTypes: Object.freeze([...body.mediaTypes]),
      }),
      webhook,
    }),
  });
}

/** Recognizes the transport `defineWebhook` compiles, including its declared response mode. */
export function isWebhookTransport(value: unknown): value is WebhookTransport {
  if (typeof value !== "object" || value === null || Reflect.get(value, "kind") !== "http") {
    return false;
  }
  const metadata = Reflect.get(value, "metadata");
  if (typeof metadata !== "object" || metadata === null) return false;
  const path = Reflect.get(metadata, "path");
  const response = Reflect.get(metadata, "response");
  const contentType = Reflect.get(metadata, "contentType");
  const requestBody = Reflect.get(metadata, "requestBody");
  const webhook = Reflect.get(metadata, "webhook");
  return (
    Reflect.get(metadata, "method") === "POST" &&
    typeof path === "string" &&
    Reflect.get(value, "binding") === `POST ${path}` &&
    (response === "json" || response === "text" || response === "binary" || response === "empty") &&
    (response === "empty"
      ? contentType === undefined
      : typeof contentType === "string" && CONTENT_TYPE_PATTERN.test(contentType)) &&
    typeof requestBody === "object" &&
    requestBody !== null &&
    Reflect.get(requestBody, "mode") === "raw" &&
    typeof webhook === "object" &&
    webhook !== null &&
    isResponseDeclaration(Reflect.get(webhook, "response"))
  );
}

function replayTransport<TPath extends string>(path: TPath): WebhookReplayTransport<TPath> {
  return Object.freeze({
    kind: "http" as const,
    binding: `POST ${path}` as const,
    metadata: Object.freeze({
      method: "POST" as const,
      path,
      response: "json" as const,
      contentType: WEBHOOK_CONTENT_TYPE,
      requestBody: Object.freeze({ mode: "json" as const }),
    }),
  });
}

function transportMetadata(
  base: WebhookDefinitionBase<string, string>,
  idempotency: Required<WebhookIdempotency>,
  mode: "inline" | "enqueue",
  response: WebhookResponseDeclaration,
  retention: WebhookRetention | undefined,
  outbox?: { readonly id: string; readonly intent: string },
): WebhookTransportMetadata {
  return Object.freeze({
    id: base.id,
    provider: base.provider.provider,
    verifier: base.provider.verifier.id,
    guarantees: Object.freeze({ ...base.provider.verifier.guarantees }),
    mode,
    response,
    idempotency: Object.freeze({ windowMs: idempotency.windowMs, inFlight: idempotency.inFlight }),
    ...(retention ? { retention: Object.freeze({ ...retention }) } : {}),
    ...(outbox ? { outbox: Object.freeze({ ...outbox }) } : {}),
  });
}

function freezeInFlight(policy: WebhookInFlightPolicy): WebhookInFlightPolicy {
  return policy.kind === "wait"
    ? Object.freeze({ kind: "wait" as const, maxMs: policy.maxMs })
    : Object.freeze({ kind: "retry" as const, status: policy.status });
}

function uniqueBindingName(outboxId: string, taken: Record<string, unknown>): string {
  const candidate = outboxId
    .split(/[.-]/u)
    .filter((segment) => segment.length > 0)
    .map((segment, index) =>
      index === 0 ? segment : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`,
    )
    .join("");
  let name = BINDING_NAME_PATTERN.test(candidate)
    ? candidate
    : `outbox${candidate.replace(/[^a-zA-Z0-9]/gu, "")}`;
  if (name === "tx" || name === "events") name = `${name}Outbox`;
  let unique = name;
  let suffix = 2;
  while (Object.hasOwn(taken, unique)) {
    unique = `${name}${suffix}`;
    suffix += 1;
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertVerifier(value: unknown): asserts value is WebhookVerifier {
  if (typeof value !== "object" || value === null) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_VERIFIER_INVALID",
      "webhook verifier must be an object with id, guarantees and verify()",
      { field: "verifier" },
    );
  }
  const id = Reflect.get(value, "id");
  if (typeof id !== "string" || !IDENTIFIER_PATTERN.test(id)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_VERIFIER_INVALID",
      `webhook verifier id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
      { field: "verifier.id" },
    );
  }
  const guarantees = Reflect.get(value, "guarantees");
  if (
    typeof guarantees !== "object" ||
    guarantees === null ||
    ["signature", "freshness", "replay"].some(
      (flag) => typeof Reflect.get(guarantees, flag) !== "boolean",
    )
  ) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_VERIFIER_GUARANTEES_UNDECLARED",
      `webhook verifier ${JSON.stringify(id)} must declare guarantees: { signature, freshness, replay } explicitly`,
      { field: "verifier.guarantees" },
    );
  }
  if (!isWebhookVerifier(value)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_VERIFIER_INVALID",
      `webhook verifier ${JSON.stringify(id)} must define verify(request) and string sensitiveHeaders`,
      { field: "verifier" },
    );
  }
}

function assertBaseDefinition(definition: unknown): WebhookDefinitionBase<string, string> {
  if (typeof definition !== "object" || definition === null) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_DEFINITION_INVALID",
      "webhook definition must be an object",
    );
  }
  const id = Reflect.get(definition, "id");
  if (typeof id !== "string" || !OPERATION_ID_PATTERN.test(id)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_ID_INVALID",
      "webhook id must contain at least two lowercase dot-separated segments",
      { webhookId: typeof id === "string" ? id : undefined, field: "id" },
    );
  }
  assertNoReadCache(id, definition);
  const path = Reflect.get(definition, "path");
  if (!isValidWebhookPath(path)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_PATH_INVALID",
      `webhook ${JSON.stringify(id)} path must be an absolute literal path without parameters, query, fragment, whitespace or trailing slash`,
      { webhookId: id, field: "path" },
    );
  }
  const provider = Reflect.get(definition, "provider");
  if (!isWebhookVerifierToken(provider)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_PROVIDER_INVALID",
      `webhook ${JSON.stringify(id)} provider must be created with webhookVerifierToken()`,
      { webhookId: id, field: "provider" },
    );
  }
  const body = Reflect.get(definition, "body");
  const mediaTypes =
    typeof body === "object" && body !== null ? Reflect.get(body, "mediaTypes") : undefined;
  if (
    typeof body !== "object" ||
    body === null ||
    !isPositiveInteger(Reflect.get(body, "maxBytes")) ||
    !Array.isArray(mediaTypes) ||
    mediaTypes.length === 0 ||
    !mediaTypes.every(
      (type, index) =>
        typeof type === "string" &&
        MEDIA_TYPE_PATTERN.test(type.toLowerCase()) &&
        mediaTypes.findIndex((other) => String(other).toLowerCase() === type.toLowerCase()) ===
          index,
    )
  ) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_BODY_POLICY_INVALID",
      `webhook ${JSON.stringify(id)} body must declare a positive integer maxBytes and a non-empty list of distinct bare media types`,
      { webhookId: id, field: "body" },
    );
  }
  const idempotency = Reflect.get(definition, "idempotency");
  if (typeof idempotency !== "object" || idempotency === null) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_IDEMPOTENCY_INVALID",
      `webhook ${JSON.stringify(id)} must declare idempotency: { windowMs, store, inFlight }`,
      { webhookId: id, field: "idempotency" },
    );
  }
  if (!isIdempotencyStoreDependencyToken(Reflect.get(idempotency, "store"))) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_IDEMPOTENCY_STORE_REQUIRED",
      `webhook ${JSON.stringify(id)} must bind an idempotencyStoreDependency() so duplicate deliveries are detected durably`,
      { webhookId: id, field: "idempotency.store" },
    );
  }
  const key = Reflect.get(idempotency, "key");
  if (
    !isPositiveInteger(Reflect.get(idempotency, "windowMs")) ||
    (key !== undefined && typeof key !== "function")
  ) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_IDEMPOTENCY_INVALID",
      `webhook ${JSON.stringify(id)} idempotency must declare a positive integer windowMs and an optional key(receipt) function`,
      { webhookId: id, field: "idempotency" },
    );
  }
  const inFlight = Reflect.get(idempotency, "inFlight");
  if (!isInFlightPolicy(inFlight)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_IN_FLIGHT_POLICY_INVALID",
      `webhook ${JSON.stringify(id)} idempotency.inFlight must be { kind: "wait", maxMs } or { kind: "retry", status: 4xx|5xx }`,
      { webhookId: id, field: "idempotency.inFlight" },
    );
  }
  const retention = Reflect.get(definition, "retention");
  if (
    retention !== undefined &&
    (typeof retention !== "object" ||
      retention === null ||
      !isPositiveInteger(Reflect.get(retention, "eventsMs")) ||
      !isPositiveInteger(Reflect.get(retention, "claimsMs")))
  ) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RETENTION_INVALID",
      `webhook ${JSON.stringify(id)} retention must declare positive integer eventsMs and claimsMs`,
      { webhookId: id, field: "retention" },
    );
  }
  return definition as WebhookDefinitionBase<string, string>;
}

function assertEnqueueReceive(webhookId: string, receive: unknown): WebhookEnqueueReceive {
  if (
    typeof receive !== "object" ||
    receive === null ||
    Reflect.get(receive, "mode") !== "enqueue"
  ) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RECEIVE_INVALID",
      `webhook ${JSON.stringify(webhookId)} receive must be { mode: "enqueue", outbox, intent, store, unitOfWork }`,
      { webhookId, field: "receive" },
    );
  }
  const outbox = Reflect.get(receive, "outbox");
  if (!isOutbox(outbox)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RECEIVE_INVALID",
      `webhook ${JSON.stringify(webhookId)} receive.outbox must be created by defineOutbox()`,
      { webhookId, field: "receive.outbox" },
    );
  }
  const intent = Reflect.get(receive, "intent");
  if (typeof intent !== "string" || !Object.hasOwn(outbox.intents, intent)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_OUTBOX_INTENT_UNKNOWN",
      `webhook ${JSON.stringify(webhookId)} names intent ${JSON.stringify(intent)} which outbox ${JSON.stringify(outbox.id)} does not declare`,
      { webhookId, field: "receive.intent" },
    );
  }
  const store = Reflect.get(receive, "store");
  if (!isDependencyToken(store) || store.scope !== undefined) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RECEIVE_INVALID",
      `webhook ${JSON.stringify(webhookId)} receive.store must be a webhookEventStoreDependency() token`,
      { webhookId, field: "receive.store" },
    );
  }
  const unitOfWork = Reflect.get(receive, "unitOfWork");
  if (!isDependencyToken(unitOfWork) || !isUnitOfWorkDependencyToken(unitOfWork)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RECEIVE_INVALID",
      `webhook ${JSON.stringify(webhookId)} receive.unitOfWork must be a unitOfWorkDependency() token`,
      { webhookId, field: "receive.unitOfWork" },
    );
  }
  if (Reflect.get(receive, "handler") !== undefined) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RECEIVE_INVALID",
      `webhook ${JSON.stringify(webhookId)} cannot declare both receive and handler`,
      { webhookId, field: "handler" },
    );
  }
  return receive as WebhookEnqueueReceive;
}

function assertInlineDefinition(
  webhookId: string,
  definition: object,
  response: WebhookResponseDeclaration,
): {
  readonly output?: OperationOutputSchemas;
  readonly successStatus?: number;
  readonly errors?: readonly OperationErrorDefinition[];
  readonly transaction: OperationTransactionMode;
  readonly dependencies: DependencyBindings;
  readonly effects?: readonly EffectDependencyToken[];
  readonly handler: (arguments_: WebhookHandlerArguments<DependencyBindings>) => unknown;
} {
  if (typeof Reflect.get(definition, "handler") !== "function") {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_HANDLER_INVALID",
      `webhook ${JSON.stringify(webhookId)} must declare handler({ event, services, context }) or receive: { mode: "enqueue" }`,
      { webhookId, field: "handler" },
    );
  }
  if (response.mode !== "json") {
    if (Reflect.get(definition, "output") !== undefined) {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_RESPONSE_INVALID",
        `webhook ${JSON.stringify(webhookId)} declares response mode ${JSON.stringify(response.mode)}, whose output schema is framework-owned; remove output`,
        { webhookId, field: "output" },
      );
    }
    const successStatus = Reflect.get(definition, "successStatus");
    if (
      successStatus !== undefined &&
      (!Number.isInteger(successStatus) ||
        Number(successStatus) < 200 ||
        Number(successStatus) > 299)
    ) {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_RESPONSE_INVALID",
        `webhook ${JSON.stringify(webhookId)} successStatus must be a 2xx status`,
        { webhookId, field: "successStatus" },
      );
    }
    if (response.mode !== "empty" && (successStatus === 204 || successStatus === 205)) {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_RESPONSE_INVALID",
        `webhook ${JSON.stringify(webhookId)} cannot send a ${JSON.stringify(response.mode)} body with status ${successStatus}; use response: { mode: "empty" }`,
        { webhookId, field: "successStatus" },
      );
    }
  }
  const transaction = Reflect.get(definition, "transaction");
  const effects = Reflect.get(definition, "effects");
  if (Array.isArray(effects) && effects.length > 0 && transaction !== "none") {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_EFFECT_TRANSACTION_FORBIDDEN",
      `webhook ${JSON.stringify(webhookId)} declares immediate effects inside a ${JSON.stringify(transaction)} transaction; use receive: { mode: "enqueue" } and perform the effect from the outbox dispatcher`,
      { webhookId, field: "effects" },
    );
  }
  return definition as never;
}

/**
 * A webhook acknowledgement is never a cached read: every delivery is a distinct
 * event whose response is settled by verification and the idempotency window
 * (ADR-0019 keeps `cache` on read operations; ADR-0016 forbids it on streams).
 * `defineWebhook` and `defineWebhookReplay` never forward a `cache` declaration
 * to the operation, so one is rejected at definition time instead of silently
 * dropped.
 */
function assertNoReadCache(subjectId: string, definition: object): void {
  if (Reflect.get(definition, "cache") === undefined) return;
  throw new InvalidWebhookDefinitionError(
    "SHIP_WEBHOOK_CACHE_FORBIDDEN",
    `webhook ${JSON.stringify(subjectId)} declares a read cache; webhook acknowledgements and replays are never cached, remove the cache declaration`,
    { webhookId: subjectId, field: "cache" },
  );
}

function isResponseDeclaration(value: unknown): value is WebhookResponseDeclaration {
  if (typeof value !== "object" || value === null) return false;
  const mode = Reflect.get(value, "mode");
  const contentType = Reflect.get(value, "contentType");
  if (mode === "json" || mode === "empty") return contentType === undefined;
  if (mode !== "text" && mode !== "binary") return false;
  return typeof contentType === "string" && CONTENT_TYPE_PATTERN.test(contentType);
}

function normalizeResponse(webhookId: string, value: unknown): WebhookResponseDeclaration {
  if (value === undefined) return DEFAULT_WEBHOOK_RESPONSE;
  const mode = typeof value === "object" && value !== null ? Reflect.get(value, "mode") : undefined;
  if (
    (mode === "text" || mode === "binary") &&
    Reflect.get(value as object, "contentType") === undefined
  ) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RESPONSE_INVALID",
      `webhook ${JSON.stringify(webhookId)} response mode ${JSON.stringify(mode)} must declare the contentType the provider receives (for example "text/xml")`,
      { webhookId, field: "response.contentType" },
    );
  }
  if (!isResponseDeclaration(value)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_RESPONSE_INVALID",
      `webhook ${JSON.stringify(webhookId)} response must be { mode: "json" }, { mode: "text", contentType }, { mode: "binary", contentType } or { mode: "empty" }`,
      { webhookId, field: "response" },
    );
  }
  return value.mode === "json" || value.mode === "empty"
    ? Object.freeze({ mode: value.mode })
    : Object.freeze({ mode: value.mode, contentType: value.contentType });
}

function inlineOutput(
  response: WebhookResponseDeclaration,
  successStatus: number,
  declared: OperationOutputSchemas | undefined,
): OperationOutputSchemas {
  if (response.mode === "json") return declared ?? {};
  const schema =
    response.mode === "text"
      ? stringSchema()
      : response.mode === "binary"
        ? bytesSchema()
        : emptySchema();
  return Object.freeze({ [successStatus]: schema });
}

function normalizeReplayTransport(
  operationId: string,
  declaration: unknown,
): { readonly transport?: WebhookReplayTransport; readonly parameter?: string } {
  if (declaration === undefined) return {};
  if (typeof declaration !== "object" || declaration === null) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_TRANSPORT_INVALID",
      `replay ${JSON.stringify(operationId)} transport must be { path } or an http.post() transport`,
      { field: "transport" },
    );
  }
  const kind = Reflect.get(declaration, "kind");
  const metadata = Reflect.get(declaration, "metadata");
  const path =
    kind === undefined
      ? Reflect.get(declaration, "path")
      : typeof metadata === "object" && metadata !== null
        ? Reflect.get(metadata, "path")
        : undefined;
  if (kind !== undefined) {
    const method =
      typeof metadata === "object" && metadata !== null
        ? Reflect.get(metadata, "method")
        : undefined;
    const response =
      typeof metadata === "object" && metadata !== null
        ? Reflect.get(metadata, "response")
        : undefined;
    const requestBody =
      typeof metadata === "object" && metadata !== null
        ? Reflect.get(metadata, "requestBody")
        : undefined;
    if (
      kind !== "http" ||
      method !== "POST" ||
      response !== "json" ||
      typeof requestBody !== "object" ||
      requestBody === null ||
      Reflect.get(requestBody, "mode") !== "json"
    ) {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_TRANSPORT_INVALID",
        `replay ${JSON.stringify(operationId)} transport must be a JSON http.post() transport`,
        { field: "transport" },
      );
    }
  }
  if (!isValidReplayPath(path)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_TRANSPORT_INVALID",
      `replay ${JSON.stringify(operationId)} transport path must be an absolute literal path with at most one :parameter segment`,
      { field: "transport.path" },
    );
  }
  const parameter = replayPathParameter(path);
  const declared = kind === undefined ? Reflect.get(declaration, "eventIdParameter") : undefined;
  if (declared !== undefined) {
    if (typeof declared !== "string" || !PATH_PARAMETER_PATTERN.test(`:${declared}`)) {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_TRANSPORT_INVALID",
        `replay ${JSON.stringify(operationId)} eventIdParameter must be a path parameter name`,
        { field: "transport.eventIdParameter" },
      );
    }
    if (declared !== parameter) {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_TRANSPORT_INVALID",
        parameter === undefined
          ? `replay ${JSON.stringify(operationId)} names eventIdParameter ${JSON.stringify(declared)} but its path declares no parameter`
          : `replay ${JSON.stringify(operationId)} names eventIdParameter ${JSON.stringify(declared)} but its path declares ${JSON.stringify(parameter)}`,
        { field: "transport.eventIdParameter" },
      );
    }
  }
  return { transport: replayTransport(path), ...(parameter ? { parameter } : {}) };
}

/** The name of the single `:parameter` segment in a validated replay path. */
function replayPathParameter(path: string): string | undefined {
  for (const segment of path.slice(1).split("/")) {
    const match = PATH_PARAMETER_PATTERN.exec(segment);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function assertEnqueueWebhooks(
  definition: { readonly webhooks?: unknown },
  helper: string,
): readonly AnyWebhook[] {
  const webhooks = definition?.webhooks;
  if (!Array.isArray(webhooks) || webhooks.length === 0 || !webhooks.every(isWebhook)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_OPERATIONS_INVALID",
      `${helper} requires at least one webhook created by defineWebhook()`,
      { field: "webhooks" },
    );
  }
  for (const webhook of webhooks) {
    if (webhook.mode !== "enqueue") {
      throw new InvalidWebhookDefinitionError(
        "SHIP_WEBHOOK_OPERATIONS_INVALID",
        `${helper} accepts only enqueue-mode webhooks; ${JSON.stringify(webhook.id)} runs inline`,
        { webhookId: webhook.id, field: "webhooks" },
      );
    }
  }
  return webhooks;
}

function assertOperationId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !OPERATION_ID_PATTERN.test(id)) {
    throw new InvalidWebhookDefinitionError(
      "SHIP_WEBHOOK_ID_INVALID",
      "webhook operation id must contain at least two lowercase dot-separated segments",
      { field: "id" },
    );
  }
}

function isValidWebhookPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "/") return false;
  if (!path.startsWith("/") || path.endsWith("/") || path.includes("//") || /[\s?#]/u.test(path)) {
    return false;
  }
  return path
    .slice(1)
    .split("/")
    .every(
      (segment) => /^[A-Za-z0-9._~!$&'()+,;=@%-]+$/u.test(segment) && !segment.startsWith(":"),
    );
}

function isValidReplayPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "/") return false;
  if (!path.startsWith("/") || path.endsWith("/") || path.includes("//") || /[\s?#]/u.test(path)) {
    return false;
  }
  const segments = path.slice(1).split("/");
  return (
    segments.every(
      (segment) =>
        PATH_PARAMETER_PATTERN.test(segment) ||
        (/^[A-Za-z0-9._~!$&'()+,;=@%-]+$/u.test(segment) && !segment.startsWith(":")),
    ) && segments.filter((segment) => PATH_PARAMETER_PATTERN.test(segment)).length <= 1
  );
}

function isInFlightPolicy(value: unknown): value is WebhookInFlightPolicy {
  if (typeof value !== "object" || value === null) return false;
  const kind = Reflect.get(value, "kind");
  if (kind === "wait") return isPositiveInteger(Reflect.get(value, "maxMs"));
  if (kind !== "retry") return false;
  const status = Reflect.get(value, "status");
  return Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
