import { permission, systemAccess } from "./access.js";
import type { DependencyBindings, DependencyToken, EffectDependencyToken } from "./dependency.js";
import { isEffectDependencyToken } from "./dependency.js";
import {
  arraySchema,
  integerSchema,
  jsonValueSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "./framework-schema.js";
import type { AnyOperation, OperationContext } from "./operation.js";
import { defineOperation } from "./operation.js";
import { operationError, operationFailure } from "./operation-error.js";
import type { AnyChannel } from "./realtime.js";
import { channelForPublication, isChannelPublicationToken } from "./realtime.js";
import type { InferSchemaInput, InferSchemaOutput, RuntimeSchema, SchemaResult } from "./schema.js";
import { isRuntimeSchema } from "./schema.js";

const OUTBOX_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const INTENT_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const BINDING_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/u;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const UNKNOWN_INTENT_PROBE_INTERVAL_MS = 5_000;

/** Permission that gates the generic dead-letter management operations. */
export const OUTBOX_MANAGE_PERMISSION = "ship.outbox:manage";

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

export interface OutboxPerformArguments<TEffect, TPayload> {
  /** The provider bound to the intent's effect token in this application. */
  readonly effect: TEffect;
  /** Payload validated against the intent schema at enqueue and again at dispatch. */
  readonly payload: TPayload;
  readonly record: OutboxRecord;
  readonly context: OperationContext;
}

export interface OutboxIntentDefinition<
  TPayload extends RuntimeSchema = RuntimeSchema,
  TEffect extends EffectDependencyToken = EffectDependencyToken,
> {
  readonly payload: TPayload;
  /** The single declared effect this intent performs when dispatched. */
  readonly effect: TEffect;
  /** Consumer-owned meaning: how the effect provider performs this payload. */
  readonly perform: (
    arguments_: OutboxPerformArguments<
      TEffect extends EffectDependencyToken<infer TValue> ? TValue : never,
      InferSchemaOutput<TPayload>
    >,
  ) => void | Promise<void>;
}

/** Runtime shape of any intent; `perform` is intentionally contravariant-safe. */
export interface AnyOutboxIntent {
  readonly payload: RuntimeSchema;
  readonly effect: EffectDependencyToken;
  readonly perform: (arguments_: never) => void | Promise<void>;
}

export type OutboxIntentDefinitions = Readonly<Record<string, AnyOutboxIntent>>;

/**
 * Declares one intent with inferred payload and effect types so `perform`
 * receives a typed effect provider and payload.
 */
export function outboxIntent<TPayload extends RuntimeSchema, TEffect extends EffectDependencyToken>(
  definition: OutboxIntentDefinition<TPayload, TEffect>,
): OutboxIntentDefinition<TPayload, TEffect> {
  return Object.freeze({
    payload: definition.payload,
    effect: definition.effect,
    perform: definition.perform,
  });
}

export interface OutboxRetention {
  /** Completed records older than this are deleted by the cleanup operation. */
  readonly completedMs: number;
  /** Dead-lettered and discarded records older than this are deleted by the cleanup operation. */
  readonly deadLetteredMs: number;
}

export interface OutboxDefinition<
  TId extends string = string,
  TIntents extends OutboxIntentDefinitions = OutboxIntentDefinitions,
> {
  readonly id: TId;
  readonly intents: TIntents;
  readonly retention?: OutboxRetention;
  /**
   * The sustained rate, in intents per second, the application expects to
   * record into this outbox. Optional and informational: when every
   * dispatcher covering the outbox also declares `roundsPerSecond`, the
   * compiler compares this rate with the declared dispatch capacity
   * (`batchSize x roundsPerSecond` summed over the dispatchers) and warns
   * `SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE` when the backlog would
   * grow without bound.
   */
  readonly expectedRatePerSecond?: number;
}

export interface OutboxWriterDependencyToken<TIntents extends OutboxIntentDefinitions>
  extends DependencyToken<OutboxBackend, OutboxWriter<TIntents>> {
  readonly scope: "outbox";
  readonly role: "writer";
  readonly outbox: AnyOutbox;
}

export interface OutboxBackendDependencyToken
  extends DependencyToken<OutboxBackend, OutboxBackend> {
  readonly scope: "outbox";
  readonly role: "backend";
  readonly outbox: AnyOutbox;
}

export interface Outbox<
  TId extends string = string,
  TIntents extends OutboxIntentDefinitions = OutboxIntentDefinitions,
> extends OutboxDefinition<TId, TIntents> {
  readonly kind: "ship.outbox";
  /** Bound inside `transaction: "write"` operations; resolves to an OutboxWriter. */
  readonly writer: OutboxWriterDependencyToken<TIntents>;
  /** Bound by dispatcher, cleanup and management operations; resolves to the backend. */
  readonly backend: OutboxBackendDependencyToken;
}

export interface AnyOutbox {
  readonly kind: "ship.outbox";
  readonly id: string;
  readonly intents: OutboxIntentDefinitions;
  readonly retention?: OutboxRetention;
  readonly expectedRatePerSecond?: number;
  readonly writer: DependencyToken & { readonly scope: "outbox"; readonly role: "writer" };
  readonly backend: DependencyToken & { readonly scope: "outbox"; readonly role: "backend" };
}

export type OutboxDiagnosticCode =
  | "SHIP_OUTBOX_DEFINITION_INVALID"
  | "SHIP_OUTBOX_ID_INVALID"
  | "SHIP_OUTBOX_INTENT_ID_INVALID"
  | "SHIP_OUTBOX_INTENT_PAYLOAD_INVALID"
  | "SHIP_OUTBOX_INTENT_EFFECT_INVALID"
  | "SHIP_OUTBOX_INTENT_PERFORM_INVALID"
  | "SHIP_OUTBOX_INTENTS_EMPTY"
  | "SHIP_OUTBOX_RETENTION_INVALID"
  | "SHIP_OUTBOX_EXPECTED_RATE_INVALID"
  | "SHIP_OUTBOX_RETENTION_REQUIRED"
  | "SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID"
  | "SHIP_OUTBOX_DISPATCHER_INTENT_UNKNOWN"
  | "SHIP_OUTBOX_EFFECT_BINDING_CONFLICT";

export class InvalidOutboxDefinitionError extends Error {
  readonly code: OutboxDiagnosticCode;
  readonly outboxId?: string;
  readonly field?: string;

  constructor(
    code: OutboxDiagnosticCode,
    message: string,
    options: { readonly outboxId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidOutboxDefinitionError";
    this.code = code;
    this.outboxId = options.outboxId;
    this.field = options.field;
  }
}

/**
 * Declares a durable outbox: named, schema-validated intents, each bound to
 * exactly one declared effect. The transactional writer records intent in the
 * same unit of work as the business change; a separate dispatcher operation
 * performs the effects with at-least-once delivery.
 */
export function defineOutbox<
  const TId extends string,
  const TIntents extends OutboxIntentDefinitions,
>(definition: OutboxDefinition<TId, TIntents>): Outbox<TId, TIntents> {
  assertOutboxDefinition(definition);
  const intents = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.intents).map(([intentId, intent]) => [
        intentId,
        Object.freeze({ payload: intent.payload, effect: intent.effect, perform: intent.perform }),
      ]),
    ),
  ) as TIntents;
  const outbox: {
    kind: "ship.outbox";
    id: TId;
    intents: TIntents;
    retention?: OutboxRetention;
    expectedRatePerSecond?: number;
    writer?: OutboxWriterDependencyToken<TIntents>;
    backend?: OutboxBackendDependencyToken;
  } = {
    kind: "ship.outbox",
    id: definition.id,
    intents,
    ...(definition.retention ? { retention: Object.freeze({ ...definition.retention }) } : {}),
    ...(definition.expectedRatePerSecond !== undefined
      ? { expectedRatePerSecond: definition.expectedRatePerSecond }
      : {}),
  };
  outbox.writer = Object.freeze({
    kind: "ship.dependency" as const,
    id: definition.id,
    scope: "outbox" as const,
    role: "writer" as const,
    outbox: outbox as AnyOutbox,
  }) as OutboxWriterDependencyToken<TIntents>;
  outbox.backend = Object.freeze({
    kind: "ship.dependency" as const,
    id: definition.id,
    scope: "outbox" as const,
    role: "backend" as const,
    outbox: outbox as AnyOutbox,
  }) as OutboxBackendDependencyToken;
  return Object.freeze(outbox) as Outbox<TId, TIntents>;
}

/** The unit-of-work-bound token a `transaction: "write"` operation binds to enqueue intents. */
export function outboxDependency<TIntents extends OutboxIntentDefinitions>(
  outbox: Outbox<string, TIntents>,
): OutboxWriterDependencyToken<TIntents> {
  assertOutbox(outbox);
  return outbox.writer;
}

/** The raw backend token for dispatcher, cleanup, management and custom tooling operations. */
export function outboxBackendDependency(outbox: AnyOutbox): OutboxBackendDependencyToken {
  assertOutbox(outbox);
  return outbox.backend as OutboxBackendDependencyToken;
}

export function isOutbox(value: unknown): value is AnyOutbox {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.outbox" &&
    typeof Reflect.get(value, "id") === "string" &&
    OUTBOX_ID_PATTERN.test(Reflect.get(value, "id")) &&
    typeof Reflect.get(value, "intents") === "object" &&
    Reflect.get(value, "intents") !== null
  );
}

export function isOutboxDependencyToken(value: DependencyToken): value is DependencyToken & {
  readonly scope: "outbox";
  readonly role: "writer" | "backend";
  readonly outbox: AnyOutbox;
} {
  return value.scope === "outbox" && isOutbox(Reflect.get(value, "outbox"));
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export type OutboxRecordStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "dead-lettered"
  | "discarded";

export interface OutboxRecord {
  readonly id: string;
  readonly outboxId: string;
  readonly intentId: string;
  readonly payload: unknown;
  readonly dedupeKey?: string;
  readonly status: OutboxRecordStatus;
  /** Number of failed dispatch attempts so far. */
  readonly attempts: number;
  readonly availableAt: Date;
  readonly leaseExpiresAt?: Date;
  readonly lastError?: string;
  readonly createdAt: Date;
  readonly completedAt?: Date;
  readonly deadLetteredAt?: Date;
  readonly discardedAt?: Date;
  readonly discardReason?: string;
}

export interface OutboxIntentInput {
  readonly intentId: string;
  readonly payload: unknown;
  readonly dedupeKey?: string;
  readonly availableAt: Date;
}

export type OutboxRecordResult =
  | { readonly recordId: string; readonly deduplicated: false }
  | { readonly deduplicated: true };

export type OutboxFailureDisposition = { readonly retryAt: Date } | { readonly deadLetter: true };

export interface OutboxCleanupResult {
  readonly completedDeleted: number;
  readonly deadLetteredDeleted: number;
}

export interface OutboxHealth {
  readonly pending: number;
  readonly claimed: number;
  readonly deadLettered: number;
  readonly oldestPendingAt?: Date;
}

/**
 * Adapter contract for durable intent storage. One backend serves one outbox.
 * `record()` receives the active unit-of-work capability map as `scope` so a
 * transaction-aware adapter can write in the same transaction; `claimDue()`
 * must be atomic across concurrent dispatchers.
 */
export interface OutboxBackend {
  readonly kind: "ship.outbox-backend";
  readonly outboxId: string;
  record(
    scope: object,
    intents: readonly OutboxIntentInput[],
  ): Promise<readonly OutboxRecordResult[]>;
  claimDue(
    now: Date,
    batchSize: number,
    leaseMs: number,
    intentIds?: readonly string[],
  ): Promise<readonly OutboxRecord[]>;
  /**
   * Atomically claim only IDs absent from the current full outbox declaration.
   * A partitioned dispatcher uses this to quarantine removed IDs without
   * claiming valid intents owned by another dispatcher. Existing backends may
   * omit this method when a single dispatcher covers every declared intent;
   * partitioned dispatchers require it.
   */
  claimUnknownDue?(
    now: Date,
    batchSize: number,
    leaseMs: number,
    knownIntentIds: readonly string[],
  ): Promise<readonly OutboxRecord[]>;
  complete(recordId: string, now: Date): Promise<void>;
  fail(
    recordId: string,
    error: string,
    disposition: OutboxFailureDisposition,
    now: Date,
  ): Promise<void>;
  listDeadLettered(options: { readonly limit: number }): Promise<readonly OutboxRecord[]>;
  /** Returns the record moved back to pending, or undefined when it is not dead-lettered. */
  retry(recordId: string, now: Date): Promise<OutboxRecord | undefined>;
  /** Returns the discarded record, or undefined when it is not dead-lettered. */
  discard(recordId: string, reason: string, now: Date): Promise<OutboxRecord | undefined>;
  cleanup(retention: OutboxRetention, now: Date): Promise<OutboxCleanupResult>;
  health(now: Date): Promise<OutboxHealth>;
  /** Optional operator-facing lookup of one record regardless of status. */
  findRecord?(recordId: string): Promise<OutboxRecord | undefined>;
  /** Optional operator-facing listing, most recently created first. */
  listRecords?(query: OutboxRecordQuery): Promise<readonly OutboxRecord[]>;
}

export interface OutboxRecordQuery {
  /** Restrict to one status; every status when omitted. */
  readonly status?: OutboxRecordStatus;
  readonly limit: number;
}

export function isOutboxBackend(value: unknown): value is OutboxBackend {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.outbox-backend" &&
    typeof Reflect.get(value, "outboxId") === "string" &&
    [
      "record",
      "claimDue",
      "complete",
      "fail",
      "listDeadLettered",
      "retry",
      "discard",
      "cleanup",
      "health",
    ].every((method) => typeof Reflect.get(value, method) === "function")
  );
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface OutboxEnqueueOptions {
  /** Deduplicates within the retention window; a repeated key is a no-op. */
  readonly dedupeKey?: string;
  /** Earliest dispatch time; defaults to now. */
  readonly availableAt?: Date;
}

export interface OutboxWriter<TIntents extends OutboxIntentDefinitions> {
  readonly kind: "ship.outbox-writer";
  readonly outboxId: string;
  enqueue<TIntentId extends Extract<keyof TIntents, string>>(
    intentId: TIntentId,
    payload: InferSchemaInput<TIntents[TIntentId]["payload"]>,
    options?: OutboxEnqueueOptions,
  ): Promise<OutboxRecordResult>;
}

export type OutboxWriteErrorCode =
  | "SHIP_OUTBOX_INTENT_UNKNOWN"
  | "SHIP_OUTBOX_PAYLOAD_INVALID"
  | "SHIP_OUTBOX_ENQUEUE_OPTIONS_INVALID";

export class OutboxWriteError extends Error {
  readonly code: OutboxWriteErrorCode;
  readonly outboxId: string;
  readonly intentId?: string;
  readonly issues?: readonly { readonly message: string; readonly path: readonly PropertyKey[] }[];

  constructor(
    code: OutboxWriteErrorCode,
    message: string,
    options: {
      readonly outboxId: string;
      readonly intentId?: string;
      readonly issues?: readonly {
        readonly message: string;
        readonly path: readonly PropertyKey[];
      }[];
    },
  ) {
    super(message);
    this.name = "OutboxWriteError";
    this.code = code;
    this.outboxId = options.outboxId;
    this.intentId = options.intentId;
    this.issues = options.issues;
  }
}

/** @internal Constructed by the executor for each write transaction. */
export function createOutboxWriter<TIntents extends OutboxIntentDefinitions>(
  outbox: AnyOutbox,
  backend: OutboxBackend,
  scope: object,
  clock: () => Date = () => new Date(),
): OutboxWriter<TIntents> {
  const enqueue = async (
    intentId: string,
    payload: unknown,
    options: OutboxEnqueueOptions = {},
  ): Promise<OutboxRecordResult> => {
    const intent = Object.hasOwn(outbox.intents, intentId) ? outbox.intents[intentId] : undefined;
    if (!intent) {
      throw new OutboxWriteError(
        "SHIP_OUTBOX_INTENT_UNKNOWN",
        `outbox ${JSON.stringify(outbox.id)} declares no intent ${JSON.stringify(intentId)}`,
        { outboxId: outbox.id, intentId },
      );
    }
    if (
      typeof options !== "object" ||
      options === null ||
      (options.dedupeKey !== undefined &&
        (typeof options.dedupeKey !== "string" || options.dedupeKey.length === 0)) ||
      (options.availableAt !== undefined &&
        !(options.availableAt instanceof Date && Number.isFinite(options.availableAt.getTime())))
    ) {
      throw new OutboxWriteError(
        "SHIP_OUTBOX_ENQUEUE_OPTIONS_INVALID",
        "outbox enqueue options must provide a non-empty dedupeKey and a valid availableAt when present",
        { outboxId: outbox.id, intentId },
      );
    }
    const validated = await validatePayload(outbox, intentId, intent.payload, payload);
    const results = await backend.record(scope, [
      Object.freeze({
        intentId,
        payload: validated,
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
        availableAt: options.availableAt ?? clock(),
      }),
    ]);
    return results[0] ?? Object.freeze({ deduplicated: true as const });
  };

  return Object.freeze({
    kind: "ship.outbox-writer" as const,
    outboxId: outbox.id,
    enqueue,
  }) as OutboxWriter<TIntents>;
}

async function validatePayload(
  outbox: AnyOutbox,
  intentId: string,
  schema: RuntimeSchema,
  payload: unknown,
): Promise<unknown> {
  const result = (await schema["~standard"].validate(payload)) as SchemaResult<unknown>;
  if ("issues" in result && result.issues !== undefined) {
    throw new OutboxWriteError(
      "SHIP_OUTBOX_PAYLOAD_INVALID",
      `outbox intent ${JSON.stringify(intentId)} payload does not match its declared schema`,
      {
        outboxId: outbox.id,
        intentId,
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

// ---------------------------------------------------------------------------
// Operation roles (read by the application compiler and tooling)
// ---------------------------------------------------------------------------

export type OutboxOperationRole =
  | {
      readonly role: "dispatcher";
      readonly outboxId: string;
      readonly intentIds: readonly string[];
      readonly batchSize: number;
      readonly roundsPerSecond?: number;
    }
  | { readonly role: "cleanup"; readonly outboxId: string }
  | {
      readonly role: "management";
      readonly outboxId: string;
      readonly action: "list-dead-lettered" | "retry" | "discard";
    };

const outboxOperationRoles = new WeakMap<object, OutboxOperationRole>();

/** Identifies framework-generated outbox operations for graph projection and diagnostics. */
export function describeOutboxOperation(operation: AnyOperation): OutboxOperationRole | undefined {
  return outboxOperationRoles.get(operation);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface OutboxBackoff {
  readonly initialMs: number;
  /** Exponential multiplier per attempt; defaults to 2. */
  readonly multiplier?: number;
  readonly maxMs?: number;
}

export interface OutboxDispatcherOptions<TIntents extends OutboxIntentDefinitions> {
  readonly batchSize: number;
  readonly lease: { readonly ms: number };
  readonly retry: { readonly attempts: number; readonly backoff: OutboxBackoff };
  /** Dead-lettering after the attempt limit is the only supported terminal policy. */
  readonly deadLetter: true;
  /**
   * How many dispatch rounds per second the application's runner drives this
   * dispatcher at, per process. Optional and informational: with the outbox's
   * `expectedRatePerSecond` it lets the compiler warn when the declared
   * capacity (`batchSize x roundsPerSecond`) is below the write rate. With
   * `startOutboxDispatchRunner` the sustained figure is about
   * `maxPassesPerCycle / (intervalMs / 1000 + maxPassesPerCycle x pass duration)`.
   */
  readonly roundsPerSecond?: number;
  /** Dispatch only these intents; every intent must be covered by some dispatcher in the app. */
  readonly intents?: readonly Extract<keyof TIntents, string>[];
  /** Injectable clock for deterministic tests. */
  readonly clock?: () => Date;
}

export interface OutboxDispatchResult {
  readonly claimed: number;
  readonly completed: number;
  readonly retried: number;
  readonly deadLettered: number;
  /**
   * The dispatcher's declared batch size, so a runner can tell a full batch
   * (`claimed === batchSize`, more may be due) from a short or empty one.
   */
  readonly batchSize: number;
}

const dispatchResultSchema = objectSchema({
  batchSize: integerSchema({ minimum: 1 }),
  claimed: integerSchema({ minimum: 0 }),
  completed: integerSchema({ minimum: 0 }),
  retried: integerSchema({ minimum: 0 }),
  deadLettered: integerSchema({ minimum: 0 }),
});

const recordViewSchema = objectSchema({
  id: stringSchema({ minLength: 1 }),
  intentId: stringSchema({ minLength: 1 }),
  payload: jsonValueSchema(),
  status: stringSchema({ minLength: 1 }),
  attempts: integerSchema({ minimum: 0 }),
  availableAt: stringSchema({ minLength: 1 }),
  createdAt: stringSchema({ minLength: 1 }),
  dedupeKey: optionalSchema(stringSchema({ minLength: 1 })),
  lastError: optionalSchema(stringSchema()),
  deadLetteredAt: optionalSchema(stringSchema({ minLength: 1 })),
  discardedAt: optionalSchema(stringSchema({ minLength: 1 })),
  discardReason: optionalSchema(stringSchema()),
});

export type OutboxRecordView = InferSchemaOutput<typeof recordViewSchema>;

const listQuerySchema = objectSchema({
  limit: optionalSchema(integerSchema({ minimum: 1, maximum: MAX_LIST_LIMIT })),
});
const listOutputSchema = objectSchema({ records: arraySchema(recordViewSchema) });
const recordIdBodySchema = objectSchema({ recordId: stringSchema({ minLength: 1 }) });
const discardBodySchema = objectSchema({
  recordId: stringSchema({ minLength: 1 }),
  reason: stringSchema({ minLength: 1 }),
});
const recordOutputSchema = objectSchema({ record: recordViewSchema });
const cleanupOutputSchema = objectSchema({
  completedDeleted: integerSchema({ minimum: 0 }),
  deadLetteredDeleted: integerSchema({ minimum: 0 }),
});

export const outboxRecordNotFound = operationError({
  code: "OUTBOX_RECORD_NOT_FOUND",
  status: 404,
  message: "Dead-lettered outbox record not found",
});

/** The generated dispatcher and management operations, with precise operation types. */
export type OutboxDispatcher<
  TId extends string = string,
  TIntents extends OutboxIntentDefinitions = OutboxIntentDefinitions,
> = ReturnType<typeof defineOutboxDispatcher<TId, TIntents>>;

/**
 * Generates the non-transactional dispatcher operation (`<outbox>.dispatch`)
 * plus the dead-letter management operations for one outbox. Delivery is
 * at-least-once: a crash after an effect succeeds but before completion is
 * recorded leads to a retry after the lease expires.
 */
export function defineOutboxDispatcher<
  const TId extends string,
  const TIntents extends OutboxIntentDefinitions,
>(outbox: Outbox<TId, TIntents>, options: OutboxDispatcherOptions<TIntents>) {
  assertOutbox(outbox);
  assertDispatcherOptions(outbox, options);
  const clock = options.clock ?? (() => new Date());
  const intentIds = Object.freeze(
    [...(options.intents ?? Object.keys(outbox.intents))].sort(),
  ) as readonly string[];
  const knownIntentIds = Object.freeze(Object.keys(outbox.intents).sort());
  const coversAllIntents = knownIntentIds.every((intentId) => intentIds.includes(intentId));
  const effectBindings = bindEffects(outbox, intentIds);
  const leaseMs = options.lease.ms;
  const { attempts, backoff } = options.retry;
  // Empty inverse-ID scans can be expensive against a large healthy backlog.
  // Probe periodically, then drain continuously while obsolete work exists.
  let nextUnknownProbeAt = Number.NEGATIVE_INFINITY;
  let unknownBacklog = false;
  // A single-slot dispatcher alternates while obsolete work is present so
  // neither normal nor obsolete receipts starve under sustained load.
  let unknownTurn = false;

  const dispatch = defineOperation({
    id: `${outbox.id}.dispatch` as const,
    input: {},
    output: { 200: dispatchResultSchema },
    successStatus: 200,
    errors: [],
    access: systemAccess(),
    transaction: "none",
    dependencies: { outbox: outbox.backend, ...effectBindings.dependencies },
    effects: effectBindings.effects,
    publishes: effectBindings.publishes,
    handler: async ({ services, context }) => {
      const backend = services.outbox;
      if (!backend.claimUnknownDue && !coversAllIntents) {
        throw new Error(
          `outbox ${JSON.stringify(outbox.id)} uses intent partitions but its backend cannot claim unknown intents`,
        );
      }
      const now = clock();
      const probeUnknown = unknownBacklog || now.getTime() >= nextUnknownProbeAt;
      // Older custom backends remain compatible when this dispatcher covers
      // every declared intent: an unfiltered claim cannot steal another
      // partition's valid work. Partitioned backends must opt in explicitly.
      const claimUnknown = async (batchSize: number) => {
        const claimed = backend.claimUnknownDue
          ? backend.claimUnknownDue(now, batchSize, leaseMs, knownIntentIds)
          : backend.claimDue(now, batchSize, leaseMs);
        const records = await claimed;
        unknownBacklog = records.some((record) => !knownIntentIds.includes(record.intentId));
        if (!unknownBacklog) nextUnknownProbeAt = now.getTime() + UNKNOWN_INTENT_PROBE_INTERVAL_MS;
        return records;
      };
      const unknownBudget = probeUnknown && (options.batchSize > 1 || unknownTurn) ? 1 : 0;
      unknownTurn = !unknownTurn;
      const knownBudget = options.batchSize - unknownBudget;
      const known =
        knownBudget > 0 ? await backend.claimDue(now, knownBudget, leaseMs, intentIds) : [];
      const unknown = unknownBudget > 0 ? await claimUnknown(unknownBudget) : [];
      const records: OutboxRecord[] = [...known, ...unknown];
      let remaining = options.batchSize - records.length;
      if (remaining > 0 && (knownBudget === 0 || known.length === knownBudget)) {
        const moreKnown = await backend.claimDue(now, remaining, leaseMs, intentIds);
        records.push(...moreKnown);
        remaining -= moreKnown.length;
      }
      if (
        remaining > 0 &&
        probeUnknown &&
        (unknownBudget === 0 || unknown.length === unknownBudget)
      ) {
        records.push(...(await claimUnknown(remaining)));
      }
      let completed = 0;
      let retried = 0;
      let deadLettered = 0;
      for (const record of records) {
        if (context.signal?.aborted) break;
        const intent = Object.hasOwn(outbox.intents, record.intentId)
          ? outbox.intents[record.intentId]
          : undefined;
        const effectName = intent ? effectBindings.nameByEffectId.get(intent.effect.id) : undefined;
        if (!intent || !effectName) {
          await backend.fail(
            record.id,
            `outbox intent ${JSON.stringify(record.intentId)} is not declared`,
            { deadLetter: true },
            clock(),
          );
          deadLettered += 1;
          continue;
        }
        let failure: unknown;
        try {
          const payload = await validatePayload(
            outbox,
            record.intentId,
            intent.payload,
            record.payload,
          );
          await intent.perform({
            effect: Reflect.get(services, effectName),
            payload,
            record,
            context,
          } as never);
        } catch (error) {
          failure = error ?? new Error("outbox intent failed");
        }
        if (failure === undefined) {
          // A crash here leaves the record claimed; the lease expiry makes it
          // retryable, which is the documented at-least-once case.
          await backend.complete(record.id, clock());
          completed += 1;
          continue;
        }
        const attempt = record.attempts + 1;
        const message = errorMessage(failure);
        if (attempt >= attempts) {
          await backend.fail(record.id, message, { deadLetter: true }, clock());
          deadLettered += 1;
        } else {
          const delay = backoffDelay(backoff, attempt);
          await backend.fail(
            record.id,
            message,
            { retryAt: new Date(clock().getTime() + delay) },
            clock(),
          );
          retried += 1;
        }
      }
      return {
        batchSize: options.batchSize,
        claimed: records.length,
        completed,
        retried,
        deadLettered,
      };
    },
  });
  outboxOperationRoles.set(
    dispatch,
    Object.freeze({
      role: "dispatcher",
      outboxId: outbox.id,
      intentIds,
      batchSize: options.batchSize,
      ...(options.roundsPerSecond !== undefined
        ? { roundsPerSecond: options.roundsPerSecond }
        : {}),
    }),
  );

  const listDeadLettered = defineOperation({
    id: `${outbox.id}.list-dead-lettered` as const,
    input: { query: listQuerySchema },
    output: { 200: listOutputSchema },
    successStatus: 200,
    errors: [],
    access: permission(OUTBOX_MANAGE_PERMISSION),
    transaction: "none",
    dependencies: { outbox: outbox.backend },
    handler: async ({ input, services }) => {
      const records = await services.outbox.listDeadLettered({
        limit: input.query.limit ?? DEFAULT_LIST_LIMIT,
      });
      return { records: records.map(recordView) };
    },
  });
  outboxOperationRoles.set(
    listDeadLettered,
    Object.freeze({ role: "management", outboxId: outbox.id, action: "list-dead-lettered" }),
  );

  const retry = defineOperation({
    id: `${outbox.id}.retry` as const,
    input: { body: recordIdBodySchema },
    output: { 200: recordOutputSchema },
    successStatus: 200,
    errors: [outboxRecordNotFound],
    access: permission(OUTBOX_MANAGE_PERMISSION),
    transaction: "none",
    dependencies: { outbox: outbox.backend },
    handler: async ({ input, services }) => {
      const record = await services.outbox.retry(input.body.recordId, clock());
      if (!record) throw operationFailure(outboxRecordNotFound);
      return { record: recordView(record) };
    },
  });
  outboxOperationRoles.set(
    retry,
    Object.freeze({ role: "management", outboxId: outbox.id, action: "retry" }),
  );

  const discard = defineOperation({
    id: `${outbox.id}.discard` as const,
    input: { body: discardBodySchema },
    output: { 200: recordOutputSchema },
    successStatus: 200,
    errors: [outboxRecordNotFound],
    access: permission(OUTBOX_MANAGE_PERMISSION),
    transaction: "none",
    dependencies: { outbox: outbox.backend },
    handler: async ({ input, services }) => {
      const record = await services.outbox.discard(input.body.recordId, input.body.reason, clock());
      if (!record) throw operationFailure(outboxRecordNotFound);
      return { record: recordView(record) };
    },
  });
  outboxOperationRoles.set(
    discard,
    Object.freeze({ role: "management", outboxId: outbox.id, action: "discard" }),
  );

  return Object.freeze({
    kind: "ship.outbox-dispatcher" as const,
    outbox,
    dispatch,
    listDeadLettered,
    retry,
    discard,
    /** All generated operations, ready to spread into a module's operations. */
    operations: Object.freeze([dispatch, listDeadLettered, retry, discard] as const),
  });
}

/**
 * Generates `<outbox>.cleanup`: deletes completed records older than
 * `retention.completedMs` and dead-lettered/discarded records older than
 * `retention.deadLetteredMs`. Pending and claimed records are never touched.
 * Scheduling it on a single runner is the job runner's responsibility.
 */
export function defineOutboxCleanup<const TId extends string>(
  outbox: Outbox<TId, OutboxIntentDefinitions>,
  options: { readonly clock?: () => Date } = {},
) {
  assertOutbox(outbox);
  const retention = outbox.retention;
  if (!retention) {
    throw new InvalidOutboxDefinitionError(
      "SHIP_OUTBOX_RETENTION_REQUIRED",
      `outbox ${JSON.stringify(outbox.id)} declares no retention; add retention: { completedMs, deadLetteredMs } before defining cleanup`,
      { outboxId: outbox.id, field: "retention" },
    );
  }
  const clock = options.clock ?? (() => new Date());
  const cleanup = defineOperation({
    id: `${outbox.id}.cleanup` as const,
    input: {},
    output: { 200: cleanupOutputSchema },
    successStatus: 200,
    errors: [],
    access: systemAccess(),
    transaction: "none",
    dependencies: { outbox: outbox.backend },
    handler: async ({ services }) => {
      const result = await services.outbox.cleanup(retention, clock());
      return {
        completedDeleted: result.completedDeleted,
        deadLetteredDeleted: result.deadLetteredDeleted,
      };
    },
  });
  outboxOperationRoles.set(cleanup, Object.freeze({ role: "cleanup", outboxId: outbox.id }));
  return cleanup;
}

export function outboxRecordView(record: OutboxRecord): OutboxRecordView {
  return recordView(record);
}

function recordView(record: OutboxRecord): OutboxRecordView {
  return Object.freeze({
    id: record.id,
    intentId: record.intentId,
    payload: record.payload,
    status: record.status,
    attempts: record.attempts,
    availableAt: record.availableAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    ...(record.dedupeKey !== undefined ? { dedupeKey: record.dedupeKey } : {}),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
    ...(record.deadLetteredAt ? { deadLetteredAt: record.deadLetteredAt.toISOString() } : {}),
    ...(record.discardedAt ? { discardedAt: record.discardedAt.toISOString() } : {}),
    ...(record.discardReason !== undefined ? { discardReason: record.discardReason } : {}),
  });
}

export function backoffDelay(backoff: OutboxBackoff, attempt: number): number {
  const multiplier = backoff.multiplier ?? 2;
  const raw = backoff.initialMs * multiplier ** Math.max(0, attempt - 1);
  return Math.min(backoff.maxMs ?? Number.POSITIVE_INFINITY, Math.round(raw));
}

function bindEffects(
  outbox: AnyOutbox,
  intentIds: readonly string[],
): {
  readonly dependencies: DependencyBindings;
  readonly effects: readonly EffectDependencyToken[];
  /** Channel publication tokens are declared as publishes, never as effects. */
  readonly publishes: readonly AnyChannel[];
  readonly nameByEffectId: ReadonlyMap<string, string>;
} {
  const dependencies: Record<string, DependencyToken> = {};
  const effects: EffectDependencyToken[] = [];
  const publishes: AnyChannel[] = [];
  const nameByEffectId = new Map<string, string>();
  const tokens = new Map<string, EffectDependencyToken>();
  for (const intentId of intentIds) {
    const intent = outbox.intents[intentId] as AnyOutboxIntent;
    tokens.set(intent.effect.id, intent.effect);
  }
  for (const [effectId, token] of [...tokens].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const name = bindingName(effectId);
    if (name === "outbox" || Object.hasOwn(dependencies, name)) {
      throw new InvalidOutboxDefinitionError(
        "SHIP_OUTBOX_EFFECT_BINDING_CONFLICT",
        `effect ${JSON.stringify(effectId)} cannot be bound as ${JSON.stringify(name)} on the ${JSON.stringify(outbox.id)} dispatcher because that name is already taken`,
        { outboxId: outbox.id, field: "intents" },
      );
    }
    dependencies[name] = token;
    const channel = isChannelPublicationToken(token) ? channelForPublication(token) : undefined;
    if (channel) publishes.push(channel);
    else effects.push(token);
    nameByEffectId.set(effectId, name);
  }
  return {
    dependencies: Object.freeze(dependencies),
    effects: Object.freeze(effects),
    publishes: Object.freeze(publishes),
    nameByEffectId,
  };
}

function bindingName(effectId: string): string {
  const name = effectId
    .split(/[.-]/u)
    .filter((segment) => segment.length > 0)
    .map((segment, index) =>
      index === 0 ? segment : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`,
    )
    .join("");
  return BINDING_NAME_PATTERN.test(name) ? name : `effect${name.replace(/[^a-zA-Z0-9]/gu, "")}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : "outbox intent failed";
}

function assertOutbox(value: unknown): asserts value is AnyOutbox {
  if (!isOutbox(value)) {
    throw new InvalidOutboxDefinitionError(
      "SHIP_OUTBOX_DEFINITION_INVALID",
      "expected an outbox created by defineOutbox()",
    );
  }
}

function assertDispatcherOptions(
  outbox: AnyOutbox,
  options: unknown,
): asserts options is OutboxDispatcherOptions<OutboxIntentDefinitions> {
  const invalid = (message: string, field: string) =>
    new InvalidOutboxDefinitionError("SHIP_OUTBOX_DISPATCHER_OPTIONS_INVALID", message, {
      outboxId: outbox.id,
      field,
    });
  if (typeof options !== "object" || options === null) {
    throw invalid("dispatcher options must be an object", "options");
  }
  if (!isPositiveInteger(Reflect.get(options, "batchSize"))) {
    throw invalid("batchSize must be a positive integer", "batchSize");
  }
  const lease = Reflect.get(options, "lease");
  if (typeof lease !== "object" || lease === null || !isPositiveInteger(Reflect.get(lease, "ms"))) {
    throw invalid("lease.ms must be a positive integer", "lease.ms");
  }
  const retry = Reflect.get(options, "retry");
  if (
    typeof retry !== "object" ||
    retry === null ||
    !isPositiveInteger(Reflect.get(retry, "attempts"))
  ) {
    throw invalid("retry.attempts must be a positive integer", "retry.attempts");
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
    throw invalid(
      "retry.backoff must declare initialMs with optional multiplier (>= 1) and maxMs",
      "retry.backoff",
    );
  }
  if (Reflect.get(options, "deadLetter") !== true) {
    throw invalid(
      "deadLetter must be true; the dispatcher never drops failed intents silently",
      "deadLetter",
    );
  }
  const clock = Reflect.get(options, "clock");
  if (clock !== undefined && typeof clock !== "function") {
    throw invalid("clock must be a function", "clock");
  }
  const roundsPerSecond = Reflect.get(options, "roundsPerSecond");
  if (roundsPerSecond !== undefined && !isPositiveFinite(roundsPerSecond)) {
    throw invalid("roundsPerSecond must be a positive finite number", "roundsPerSecond");
  }
  const intents = Reflect.get(options, "intents");
  if (intents !== undefined) {
    if (!Array.isArray(intents) || intents.length === 0) {
      throw invalid("intents must be a non-empty array of declared intent ids", "intents");
    }
    for (const intentId of intents) {
      if (typeof intentId !== "string" || !Object.hasOwn(outbox.intents, intentId)) {
        throw new InvalidOutboxDefinitionError(
          "SHIP_OUTBOX_DISPATCHER_INTENT_UNKNOWN",
          `outbox ${JSON.stringify(outbox.id)} declares no intent ${JSON.stringify(intentId)}`,
          { outboxId: outbox.id, field: "intents" },
        );
      }
    }
  }
}

function assertOutboxDefinition(
  definition: unknown,
): asserts definition is OutboxDefinition<string, OutboxIntentDefinitions> {
  if (typeof definition !== "object" || definition === null) {
    throw new InvalidOutboxDefinitionError(
      "SHIP_OUTBOX_DEFINITION_INVALID",
      "outbox definition must be an object",
    );
  }
  const id = Reflect.get(definition, "id");
  if (typeof id !== "string" || !OUTBOX_ID_PATTERN.test(id)) {
    throw new InvalidOutboxDefinitionError(
      "SHIP_OUTBOX_ID_INVALID",
      "outbox id must be a lowercase dot-separated identifier",
      { outboxId: typeof id === "string" ? id : undefined, field: "id" },
    );
  }
  const intents = Reflect.get(definition, "intents");
  if (typeof intents !== "object" || intents === null || Array.isArray(intents)) {
    throw new InvalidOutboxDefinitionError(
      "SHIP_OUTBOX_DEFINITION_INVALID",
      "outbox intents must be a map of intent definitions",
      { outboxId: id, field: "intents" },
    );
  }
  if (Object.keys(intents).length === 0) {
    throw new InvalidOutboxDefinitionError(
      "SHIP_OUTBOX_INTENTS_EMPTY",
      `outbox ${JSON.stringify(id)} must declare at least one intent`,
      { outboxId: id, field: "intents" },
    );
  }
  for (const [intentId, intent] of Object.entries(intents)) {
    if (!INTENT_ID_PATTERN.test(intentId)) {
      throw new InvalidOutboxDefinitionError(
        "SHIP_OUTBOX_INTENT_ID_INVALID",
        `outbox intent id ${JSON.stringify(intentId)} must be a lowercase dot-separated identifier`,
        { outboxId: id, field: `intents.${intentId}` },
      );
    }
    if (
      typeof intent !== "object" ||
      intent === null ||
      !isRuntimeSchema(Reflect.get(intent, "payload"))
    ) {
      throw new InvalidOutboxDefinitionError(
        "SHIP_OUTBOX_INTENT_PAYLOAD_INVALID",
        `outbox intent ${JSON.stringify(intentId)} must declare a Standard Schema payload`,
        { outboxId: id, field: `intents.${intentId}.payload` },
      );
    }
    const effect = Reflect.get(intent, "effect");
    if (!isEffectDependencyToken(effect as DependencyToken)) {
      throw new InvalidOutboxDefinitionError(
        "SHIP_OUTBOX_INTENT_EFFECT_INVALID",
        `outbox intent ${JSON.stringify(intentId)} must bind exactly one effectDependency() token`,
        { outboxId: id, field: `intents.${intentId}.effect` },
      );
    }
    if (typeof Reflect.get(intent, "perform") !== "function") {
      throw new InvalidOutboxDefinitionError(
        "SHIP_OUTBOX_INTENT_PERFORM_INVALID",
        `outbox intent ${JSON.stringify(intentId)} must declare perform({ effect, payload })`,
        { outboxId: id, field: `intents.${intentId}.perform` },
      );
    }
  }
  const retention = Reflect.get(definition, "retention");
  if (
    retention !== undefined &&
    (typeof retention !== "object" ||
      retention === null ||
      !isPositiveInteger(Reflect.get(retention, "completedMs")) ||
      !isPositiveInteger(Reflect.get(retention, "deadLetteredMs")))
  ) {
    throw new InvalidOutboxDefinitionError(
      "SHIP_OUTBOX_RETENTION_INVALID",
      "outbox retention must declare positive integer completedMs and deadLetteredMs",
      { outboxId: id, field: "retention" },
    );
  }
  const expectedRate = Reflect.get(definition, "expectedRatePerSecond");
  if (expectedRate !== undefined && !isPositiveFinite(expectedRate)) {
    throw new InvalidOutboxDefinitionError(
      "SHIP_OUTBOX_EXPECTED_RATE_INVALID",
      "outbox expectedRatePerSecond must be a positive finite number",
      { outboxId: id, field: "expectedRatePerSecond" },
    );
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
