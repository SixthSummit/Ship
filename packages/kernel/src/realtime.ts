import type { OperationAccess } from "./access.js";
import { authenticatedAccess, isOperationAccess } from "./access.js";
import type { OperationActor } from "./actor.js";
import { isOperationActor } from "./actor.js";
import type { ApplicationDiagnostic } from "./application.js";
import type { DependencyToken, EffectDependencyToken } from "./dependency.js";
import { isEffectDependencyToken } from "./dependency.js";
import type { AnyModule } from "./module.js";
import type { AnyOperation } from "./operation.js";
import type { Provider } from "./provider.js";
import { valueProvider } from "./provider.js";
import type { InferSchemaInput, InferSchemaOutput, RuntimeSchema, SchemaIssue } from "./schema.js";
import { isManifestProjectable, isRuntimeSchema } from "./schema.js";
import type { TenantScope, TenantScopeAuthority } from "./tenant.js";
import { isTenantScope, TenantCapabilityError } from "./tenant.js";

const CHANNEL_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
/** Scope keys travel on the wire and inside adapter-owned keys; keep them printable and bounded. */
export const REALTIME_SCOPE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const PUBLICATION_SUFFIX = ".publish";
const MAX_COALESCE_WINDOW_MS = 60_000;
/**
 * The module id a mounted realtime publication module must use. Its
 * dispatcher may publish to any channel in the application on behalf of the
 * recording operation, which already passed the import check.
 */
export const REALTIME_PUBLICATION_MODULE_ID = "ship-realtime";

export type ChannelScope = "actor" | "tenant" | "resource";
export type SlowSubscriberPolicy = "drop-oldest" | "disconnect";

export interface ChannelCoalescePolicy<TPayload = unknown> {
  /** Publishes for one key inside this window collapse into the latest payload. */
  readonly windowMs: number;
  readonly key: (payload: TPayload) => string;
}

export interface ChannelSubscriptionContext {
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export type ChannelSubscriptionPolicy = (
  actor: OperationActor,
  resourceRef: string,
  context: ChannelSubscriptionContext,
) => boolean | Promise<boolean>;

export interface ChannelDefinition<
  TId extends string,
  TScope extends ChannelScope,
  TPayload extends RuntimeSchema,
  TPresence extends boolean,
> {
  readonly id: TId;
  readonly scope: TScope;
  /**
   * Validates every publication and is projected into the client manifest as
   * JSON Schema, exactly like an operation output. The manifest derives that
   * JSON Schema from the schema itself for natively projected vendors (Zod
   * v4) or reads it from a `ProjectableRuntimeSchema` (`contractSchema()` or a
   * framework builder). Any other schema compiles with the
   * `SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE` warning, projects as
   * `ChannelPayloadNotProjectable` in `ApplicationContractOf`, and fails the
   * manifest build.
   */
  readonly payload: TPayload;
  readonly coalesce?: ChannelCoalescePolicy<InferSchemaOutput<TPayload>>;
  readonly presence?: TPresence;
  readonly slowSubscriber?: SlowSubscriberPolicy;
  /** Required for resource channels; optional extra check for actor and tenant channels. */
  readonly authorizeSubscription?: ChannelSubscriptionPolicy;
}

export interface Channel<
  TId extends string,
  TScope extends ChannelScope,
  TPayload extends RuntimeSchema,
  TPresence extends boolean,
> {
  readonly kind: "ship.channel";
  readonly id: TId;
  readonly scope: TScope;
  readonly payload: TPayload;
  readonly coalesce?: ChannelCoalescePolicy<InferSchemaOutput<TPayload>>;
  readonly presence: TPresence;
  readonly slowSubscriber: SlowSubscriberPolicy;
  readonly authorizeSubscription?: ChannelSubscriptionPolicy;
  /** Effect token an operation binds to obtain the typed publish capability. */
  readonly publication: ChannelPublicationToken<Channel<TId, TScope, TPayload, TPresence>>;
}

export interface AnyChannel {
  readonly kind: "ship.channel";
  readonly id: string;
  readonly scope: ChannelScope;
  readonly payload: RuntimeSchema;
  readonly coalesce?: ChannelCoalescePolicy<never>;
  readonly presence: boolean;
  readonly slowSubscriber: SlowSubscriberPolicy;
  readonly authorizeSubscription?: ChannelSubscriptionPolicy;
  readonly publication: EffectDependencyToken<unknown> & { readonly channelId: string };
}

export interface ChannelPublicationToken<TChannel extends AnyChannel>
  extends EffectDependencyToken<ChannelPublisher<TChannel>> {
  readonly channelId: TChannel["id"];
}

/** The value a channel's publication token resolves to inside an operation. */
export type ChannelScopeInput<TChannel extends AnyChannel> = TChannel["scope"] extends "tenant"
  ? TenantScope
  : string;

export interface ChannelPublishOptions {
  /**
   * Durable path only: a repeated key suppresses a duplicate publication
   * intent within the outbox retention window. Immediate publication keeps
   * no record to compare against and ignores it.
   */
  readonly dedupeKey?: string;
}

export interface ChannelPublisher<TChannel extends AnyChannel> {
  readonly kind: "ship.channel-publisher";
  readonly channel: TChannel;
  /**
   * On a `transaction: "none"` operation resolves once the backend accepted
   * the publication; acceptance is not delivery. On a `transaction: "write"`
   * operation resolves once a publication intent is recorded in the unit of
   * work; the mounted dispatcher publishes it after commit.
   */
  publish(
    scope: ChannelScopeInput<TChannel>,
    payload: InferSchemaInput<TChannel["payload"]>,
    options?: ChannelPublishOptions,
  ): Promise<void>;
}

/**
 * A publisher with its channel type erased: what a generic bridge holds when
 * it publishes to channels it does not know statically. `publish()` still
 * validates the scope against the channel's scope kind and the payload
 * against the channel's schema at runtime; nothing is weaker than the typed
 * path except the compile-time check. Every `ChannelPublisher<TChannel>` is
 * assignable to it; {@link narrowChannelPublisher} goes back the other way.
 */
export interface AnyChannelPublisher {
  readonly kind: "ship.channel-publisher";
  readonly channel: AnyChannel;
  publish(
    scope: string | TenantScope,
    payload: unknown,
    options?: ChannelPublishOptions,
  ): Promise<void>;
}

export type ChannelDefinitionDiagnosticCode =
  | "SHIP_CHANNEL_DEFINITION_INVALID"
  | "SHIP_CHANNEL_ID_INVALID"
  | "SHIP_CHANNEL_SCOPE_INVALID"
  | "SHIP_CHANNEL_PAYLOAD_INVALID"
  | "SHIP_CHANNEL_COALESCE_INVALID"
  | "SHIP_CHANNEL_PRESENCE_INVALID"
  | "SHIP_CHANNEL_SLOW_SUBSCRIBER_INVALID"
  | "SHIP_CHANNEL_AUTHORIZATION_REQUIRED"
  | "SHIP_CHANNEL_AUTHORIZATION_INVALID";

export class InvalidChannelDefinitionError extends Error {
  readonly code: ChannelDefinitionDiagnosticCode;
  readonly channelId?: string;
  readonly field?: string;

  constructor(
    code: ChannelDefinitionDiagnosticCode,
    message: string,
    options: { readonly channelId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidChannelDefinitionError";
    this.code = code;
    this.channelId = options.channelId;
    this.field = options.field;
  }
}

export function defineChannel<
  const TId extends string,
  const TScope extends ChannelScope,
  const TPayload extends RuntimeSchema,
  const TPresence extends boolean = false,
>(
  definition: ChannelDefinition<TId, TScope, TPayload, TPresence>,
): Channel<TId, TScope, TPayload, TPresence> {
  assertChannelDefinition(definition);
  const channel = {
    kind: "ship.channel" as const,
    id: definition.id,
    scope: definition.scope,
    payload: definition.payload,
    ...(definition.coalesce
      ? {
          coalesce: Object.freeze({
            windowMs: definition.coalesce.windowMs,
            key: definition.coalesce.key,
          }),
        }
      : {}),
    presence: (definition.presence ?? false) as TPresence,
    slowSubscriber: definition.slowSubscriber ?? ("drop-oldest" as const),
    ...(definition.authorizeSubscription
      ? { authorizeSubscription: definition.authorizeSubscription }
      : {}),
  } as {
    -readonly [TKey in keyof Channel<TId, TScope, TPayload, TPresence>]: Channel<
      TId,
      TScope,
      TPayload,
      TPresence
    >[TKey];
  };
  channel.publication = Object.freeze({
    kind: "ship.dependency" as const,
    id: `${definition.id}${PUBLICATION_SUFFIX}`,
    scope: "effect" as const,
    delivery: "immediate" as const,
    channelId: definition.id,
  }) as ChannelPublicationToken<Channel<TId, TScope, TPayload, TPresence>>;
  const frozen = Object.freeze(channel);
  publicationChannels.set(channel.publication, frozen as unknown as AnyChannel);
  return frozen;
}

const publicationChannels = new WeakMap<object, AnyChannel>();

/** Resolves the channel a publication token was created for; undefined for foreign tokens. */
export function channelForPublication(token: DependencyToken): AnyChannel | undefined {
  return publicationChannels.get(token);
}

export function isChannel(value: unknown): value is AnyChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.channel" &&
    typeof Reflect.get(value, "id") === "string" &&
    CHANNEL_ID_PATTERN.test(Reflect.get(value, "id")) &&
    isChannelScope(Reflect.get(value, "scope")) &&
    isRuntimeSchema(Reflect.get(value, "payload")) &&
    isChannelPublicationToken(Reflect.get(value, "publication"))
  );
}

export function isChannelPublicationToken(
  value: unknown,
): value is EffectDependencyToken<unknown> & { readonly channelId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    isEffectDependencyToken(value as DependencyToken) &&
    typeof Reflect.get(value, "channelId") === "string" &&
    Reflect.get(value, "id") === `${Reflect.get(value, "channelId")}${PUBLICATION_SUFFIX}`
  );
}

function isChannelScope(value: unknown): value is ChannelScope {
  return value === "actor" || value === "tenant" || value === "resource";
}

function assertChannelDefinition(
  definition: unknown,
): asserts definition is ChannelDefinition<string, ChannelScope, RuntimeSchema, boolean> {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    fail("SHIP_CHANNEL_DEFINITION_INVALID", "channel definition must be an object");
  }
  const id = Reflect.get(definition, "id");
  const channelId = typeof id === "string" ? id : undefined;
  if (!channelId || !CHANNEL_ID_PATTERN.test(channelId)) {
    fail(
      "SHIP_CHANNEL_ID_INVALID",
      "channel id must contain at least two lowercase dot-separated segments",
      channelId,
      "id",
    );
  }
  const scope = Reflect.get(definition, "scope");
  if (!isChannelScope(scope)) {
    fail(
      "SHIP_CHANNEL_SCOPE_INVALID",
      "channel scope must be one of actor, tenant, or resource",
      channelId,
      "scope",
    );
  }
  if (!isRuntimeSchema(Reflect.get(definition, "payload"))) {
    fail(
      "SHIP_CHANNEL_PAYLOAD_INVALID",
      "channel payload must be a Standard Schema",
      channelId,
      "payload",
    );
  }
  const coalesce = Reflect.get(definition, "coalesce");
  if (coalesce !== undefined) {
    const windowMs =
      typeof coalesce === "object" && coalesce ? Reflect.get(coalesce, "windowMs") : 0;
    const key = typeof coalesce === "object" && coalesce ? Reflect.get(coalesce, "key") : undefined;
    if (
      typeof coalesce !== "object" ||
      coalesce === null ||
      !Number.isSafeInteger(windowMs) ||
      windowMs <= 0 ||
      windowMs > MAX_COALESCE_WINDOW_MS ||
      typeof key !== "function"
    ) {
      fail(
        "SHIP_CHANNEL_COALESCE_INVALID",
        `coalesce must declare a positive integer windowMs of at most ${MAX_COALESCE_WINDOW_MS} and a key(payload) function`,
        channelId,
        "coalesce",
      );
    }
  }
  const presence = Reflect.get(definition, "presence");
  if (presence !== undefined && typeof presence !== "boolean") {
    fail("SHIP_CHANNEL_PRESENCE_INVALID", "presence must be a boolean", channelId, "presence");
  }
  const slowSubscriber = Reflect.get(definition, "slowSubscriber");
  if (
    slowSubscriber !== undefined &&
    slowSubscriber !== "drop-oldest" &&
    slowSubscriber !== "disconnect"
  ) {
    fail(
      "SHIP_CHANNEL_SLOW_SUBSCRIBER_INVALID",
      "slowSubscriber must be drop-oldest or disconnect",
      channelId,
      "slowSubscriber",
    );
  }
  const authorize = Reflect.get(definition, "authorizeSubscription");
  if (authorize !== undefined && typeof authorize !== "function") {
    fail(
      "SHIP_CHANNEL_AUTHORIZATION_INVALID",
      "authorizeSubscription must be a function",
      channelId,
      "authorizeSubscription",
    );
  }
  if (scope === "resource" && authorize === undefined) {
    fail(
      "SHIP_CHANNEL_AUTHORIZATION_REQUIRED",
      "resource channels must declare authorizeSubscription(actor, resourceRef, context)",
      channelId,
      "authorizeSubscription",
    );
  }
}

function fail(
  code: ChannelDefinitionDiagnosticCode,
  message: string,
  channelId?: string,
  field?: string,
): never {
  throw new InvalidChannelDefinitionError(code, message, { channelId, field });
}

// ---------------------------------------------------------------------------
// Runtime errors
// ---------------------------------------------------------------------------

export type RealtimeErrorCode =
  | "SHIP_REALTIME_CHANNEL_INVALID"
  | "SHIP_REALTIME_SCOPE_KEY_INVALID"
  | "SHIP_REALTIME_TENANT_SCOPE_REQUIRED"
  | "SHIP_REALTIME_PAYLOAD_INVALID"
  | "SHIP_REALTIME_BACKEND_INVALID"
  | "SHIP_REALTIME_BACKEND_UNAVAILABLE"
  | "SHIP_REALTIME_DISPATCH_FAILED"
  | "SHIP_REALTIME_RUNNER_INVALID";

export class RealtimeError extends Error {
  readonly code: RealtimeErrorCode;
  readonly channelId?: string;
  readonly issues?: readonly SchemaIssue[];

  constructor(
    code: RealtimeErrorCode,
    message: string,
    options: {
      readonly channelId?: string;
      readonly issues?: readonly SchemaIssue[];
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RealtimeError";
    this.code = code;
    this.channelId = options.channelId;
    this.issues = options.issues;
  }
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export interface RealtimeBackendHealth {
  readonly ok: boolean;
  readonly adapter: string;
  readonly detail?: string;
}

/** The publish-only half of a backend. Sufficient for an API process that never hosts subscribers. */
export interface RealtimePublishBackend {
  readonly kind: "ship.realtime-backend";
  readonly id: string;
  /**
   * Hands one validated payload to the backend. Resolution means the backend
   * accepted the publication for delivery; it never means a subscriber received it.
   */
  publish(channel: AnyChannel, scopeKey: string, payload: unknown): Promise<void>;
  health(): Promise<RealtimeBackendHealth>;
  close(): Promise<void>;
  /** Optional operator-facing introspection; see {@link RealtimeIntrospection}. */
  readonly introspection?: RealtimeIntrospection;
}

/** What one backend process knows about a channel: its live subscriptions and last publish. */
export interface RealtimeChannelState {
  readonly channelId: string;
  /** Live subscriptions this backend holds for the channel (0 for a publish-only backend). */
  readonly subscribers: number;
  /** Distinct scope keys with at least one live subscription. */
  readonly scopes: number;
  /** When this backend last accepted a publication for the channel. */
  readonly lastPublishedAt?: Date;
  readonly lastScopeKey?: string;
}

/**
 * Backend-neutral introspection an operator console reads. Counts are what
 * this backend instance observes: a gateway answers for its own connections,
 * so a multi-gateway deployment reads the console from each gateway or
 * aggregates elsewhere.
 */
export interface RealtimeIntrospection {
  readonly kind: "ship.realtime-introspection";
  channels(): Promise<readonly RealtimeChannelState[]>;
}

export function isRealtimeIntrospection(value: unknown): value is RealtimeIntrospection {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.realtime-introspection" &&
    typeof Reflect.get(value, "channels") === "function"
  );
}

export interface RealtimeSubscriptionRequest {
  readonly channelId: string;
  readonly scopeKey: string;
  readonly actor?: OperationActor;
  /** Adapter-owned identity of the connection that owns the subscription. */
  readonly connectionId: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export type RealtimeSubscriptionFailureReason =
  | "channel-not-found"
  | "forbidden"
  | "scope-invalid"
  | "unavailable";

export type RealtimeSubscribeResult =
  | { readonly ok: true; readonly subscriptionId: string }
  | { readonly ok: false; readonly reason: RealtimeSubscriptionFailureReason };

export type RealtimeAuthorizationDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RealtimeSubscriptionFailureReason };

export type RealtimeEvent =
  | {
      readonly kind: "message";
      readonly channelId: string;
      readonly scopeKey: string;
      /** Per (channel, scope key) sequence within one backend process. Gaps and resets are expected. */
      readonly seq: number;
      /** ISO-8601 acceptance time recorded by the publishing backend. */
      readonly publishedAt: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "presence";
      readonly channelId: string;
      readonly scopeKey: string;
      readonly event: "joined" | "left";
      readonly actorId: string;
      readonly count: number;
    };

export type RealtimeEventSink = (event: RealtimeEvent) => void;

/** Members per snapshot page when the request names no `limit`. */
export const REALTIME_PRESENCE_DEFAULT_LIMIT = 100;
/** Upper bound for one snapshot page; a larger `limit` is clamped, never honoured. */
export const REALTIME_PRESENCE_MAX_LIMIT = 1_000;

/**
 * One page of a scope key's membership. `count` is the whole membership,
 * `actorIds` is the page (sorted, at most `limit` long) and `nextCursor` is
 * present exactly when members follow the page. Presence membership is
 * bounded per page, never per scope key: a scope key with more members than
 * the limit overflows into further pages rather than truncating silently.
 */
export interface RealtimePresenceSnapshot {
  /** Distinct actors present for the scope key across every gateway. */
  readonly count: number;
  /** The requested page of actor ids, sorted. */
  readonly actorIds: readonly string[];
  /** Opaque cursor for the next page; absent on the last page. */
  readonly nextCursor?: string;
}

export interface RealtimePresencePage {
  /** Opaque cursor returned as `nextCursor` by the previous page. */
  readonly cursor?: string;
  /** Members per page; defaults to {@link REALTIME_PRESENCE_DEFAULT_LIMIT}, clamped to {@link REALTIME_PRESENCE_MAX_LIMIT}. */
  readonly limit?: number;
}

export interface RealtimePresenceRequest extends RealtimePresencePage {
  readonly channelId: string;
  readonly scopeKey: string;
  readonly actor?: OperationActor;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export type RealtimePresenceFailureReason =
  | RealtimeSubscriptionFailureReason
  | "presence-disabled"
  | "page-invalid";

export type RealtimePresenceResult =
  | { readonly ok: true; readonly snapshot: RealtimePresenceSnapshot }
  | { readonly ok: false; readonly reason: RealtimePresenceFailureReason };

export interface RealtimePresenceActorRequest {
  readonly channelId: string;
  readonly scopeKey: string;
  /** The actor whose presence is queried; not necessarily the caller. */
  readonly actorId: string;
  readonly actor?: OperationActor;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export type RealtimePresenceActorResult =
  | { readonly ok: true; readonly online: boolean }
  | { readonly ok: false; readonly reason: RealtimePresenceFailureReason };

export interface RealtimePresence {
  /** Gated by the same subscription authorization as the channel itself. Paged; see {@link RealtimePresenceSnapshot}. */
  snapshot(request: RealtimePresenceRequest): Promise<RealtimePresenceResult>;
  /**
   * Whether `actorId` holds at least one live subscription to the scope key
   * on any gateway sharing the backend. A multi-connection actor is online
   * once; an actor whose last connection closed is offline everywhere. Gated
   * like `snapshot`.
   */
  actorOnline(request: RealtimePresenceActorRequest): Promise<RealtimePresenceActorResult>;
}

/**
 * Pages a scope key's distinct members the same way on every backend. The
 * cursor is the last actor id of the previous page, so a page boundary stays
 * stable while members join or leave; it is opaque to callers.
 */
export function pagePresenceMembers(
  members: Iterable<string>,
  page: RealtimePresencePage = {},
): RealtimePresenceResult {
  if (page.cursor !== undefined && typeof page.cursor !== "string") {
    return { ok: false, reason: "page-invalid" };
  }
  if (page.limit !== undefined && (!Number.isSafeInteger(page.limit) || page.limit < 1)) {
    return { ok: false, reason: "page-invalid" };
  }
  const limit = Math.min(
    page.limit ?? REALTIME_PRESENCE_DEFAULT_LIMIT,
    REALTIME_PRESENCE_MAX_LIMIT,
  );
  const sorted = [...new Set(members)].sort();
  const start =
    page.cursor === undefined ? 0 : sorted.findIndex((actorId) => actorId > page.cursor!);
  const from = start === -1 ? sorted.length : start;
  const actorIds = Object.freeze(sorted.slice(from, from + limit));
  const last = actorIds[actorIds.length - 1];
  const hasMore = from + limit < sorted.length && last !== undefined;
  return {
    ok: true,
    snapshot: Object.freeze({
      count: sorted.length,
      actorIds,
      ...(hasMore ? { nextCursor: last } : {}),
    }),
  };
}

/** Transport-neutral subscriber-side contract every realtime adapter must satisfy. */
export interface RealtimeBackend extends RealtimePublishBackend {
  /** Authorizes, registers, and starts delivering to `sink`. Fails closed. */
  subscribe(
    request: RealtimeSubscriptionRequest,
    sink: RealtimeEventSink,
  ): Promise<RealtimeSubscribeResult>;
  unsubscribe(subscriptionId: string): Promise<void>;
  /** Releases every subscription owned by a connection, firing presence departures. */
  disconnect(connectionId: string): Promise<void>;
  readonly presence?: RealtimePresence;
}

export function isRealtimePublishBackend(value: unknown): value is RealtimePublishBackend {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.realtime-backend" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "publish") === "function" &&
    typeof Reflect.get(value, "health") === "function" &&
    typeof Reflect.get(value, "close") === "function"
  );
}

export function isRealtimeBackend(value: unknown): value is RealtimeBackend {
  return (
    isRealtimePublishBackend(value) &&
    typeof Reflect.get(value, "subscribe") === "function" &&
    typeof Reflect.get(value, "unsubscribe") === "function" &&
    typeof Reflect.get(value, "disconnect") === "function"
  );
}

// ---------------------------------------------------------------------------
// Publisher capability
// ---------------------------------------------------------------------------

export function channelScopeKey(channel: AnyChannel, scope: unknown): string {
  if (channel.scope === "tenant") {
    if (!isTenantScope(scope)) {
      throw new RealtimeError(
        "SHIP_REALTIME_TENANT_SCOPE_REQUIRED",
        `tenant channel ${JSON.stringify(channel.id)} must be published with an authentic tenant scope`,
        { channelId: channel.id },
      );
    }
    return assertScopeKey(channel, String(scope.tenantId));
  }
  if (typeof scope !== "string") {
    throw new RealtimeError(
      "SHIP_REALTIME_SCOPE_KEY_INVALID",
      `${channel.scope} channel ${JSON.stringify(channel.id)} must be published with a string scope key`,
      { channelId: channel.id },
    );
  }
  return assertScopeKey(channel, scope);
}

function assertScopeKey(channel: AnyChannel, scopeKey: string): string {
  if (!REALTIME_SCOPE_KEY_PATTERN.test(scopeKey)) {
    throw new RealtimeError(
      "SHIP_REALTIME_SCOPE_KEY_INVALID",
      `scope key for channel ${JSON.stringify(channel.id)} must match ${REALTIME_SCOPE_KEY_PATTERN}`,
      { channelId: channel.id },
    );
  }
  return scopeKey;
}

export async function validateChannelPayload(
  channel: AnyChannel,
  payload: unknown,
): Promise<unknown> {
  const result = await channel.payload["~standard"].validate(payload);
  if (result.issues) {
    throw new RealtimeError(
      "SHIP_REALTIME_PAYLOAD_INVALID",
      `payload rejected by channel ${JSON.stringify(channel.id)} schema`,
      { channelId: channel.id, issues: result.issues },
    );
  }
  return result.value;
}

/** Binds one channel to a backend, validating scope and payload before hand-off. */
export function createChannelPublisher<TChannel extends AnyChannel>(
  channel: TChannel,
  backend: RealtimePublishBackend,
): ChannelPublisher<TChannel> {
  if (!isChannel(channel)) {
    throw new RealtimeError(
      "SHIP_REALTIME_CHANNEL_INVALID",
      "createChannelPublisher requires a channel created by defineChannel()",
    );
  }
  if (!isRealtimePublishBackend(backend)) {
    throw new RealtimeError(
      "SHIP_REALTIME_BACKEND_INVALID",
      "createChannelPublisher requires a realtime backend with publish(), health(), and close()",
      { channelId: channel.id },
    );
  }
  const publisher = Object.freeze({
    kind: "ship.channel-publisher" as const,
    channel,
    publish: async (scope: ChannelScopeInput<TChannel>, payload: unknown): Promise<void> => {
      const scopeKey = channelScopeKey(channel, scope);
      const value = await validateChannelPayload(channel, payload);
      await backend.publish(channel, scopeKey, value);
    },
  });
  publisherBackends.set(publisher, backend);
  return publisher;
}

const publisherBackends = new WeakMap<object, RealtimePublishBackend>();

/**
 * @internal Publishes an already validated payload under an already validated
 * scope key through the backend an immediate publisher was created with. The
 * realtime publication dispatcher uses it to deliver a committed intent whose
 * scope was authenticated when it was recorded.
 */
export async function publishChannelKey(
  publisher: ChannelPublisher<AnyChannel>,
  scopeKey: string,
  payload: unknown,
): Promise<void> {
  const backend = publisherBackends.get(publisher);
  if (!backend) {
    throw new RealtimeError(
      "SHIP_REALTIME_BACKEND_INVALID",
      "publishChannelKey requires a publisher created by createChannelPublisher()",
      { channelId: publisher.channel.id },
    );
  }
  await backend.publish(publisher.channel, assertScopeKey(publisher.channel, scopeKey), payload);
}

export function channelPublisherProvider<TChannel extends AnyChannel>(
  channel: TChannel,
  backend: RealtimePublishBackend,
): Provider<ChannelPublisher<TChannel>, Record<never, never>, "singleton"> {
  return valueProvider(
    channel.publication as DependencyToken<ChannelPublisher<TChannel>, unknown>,
    createChannelPublisher(channel, backend),
  );
}

export function channelPublisherProviders(
  backend: RealtimePublishBackend,
  channels: readonly AnyChannel[],
): readonly Provider<ChannelPublisher<AnyChannel>, Record<never, never>, "singleton">[] {
  return Object.freeze(channels.map((channel) => channelPublisherProvider(channel, backend)));
}

export function isChannelPublisher(value: unknown): value is AnyChannelPublisher {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.channel-publisher" &&
    isChannel(Reflect.get(value, "channel")) &&
    typeof Reflect.get(value, "publish") === "function"
  );
}

/**
 * Recovers the typed publisher from an erased one. The channel must be the
 * very declaration the publisher was created for; a publisher for another
 * channel, or a channel that merely shares the id, is rejected so a bridge
 * cannot publish one channel's payload shape under another channel's type.
 */
export function narrowChannelPublisher<TChannel extends AnyChannel>(
  publisher: AnyChannelPublisher,
  channel: TChannel,
): ChannelPublisher<TChannel> {
  if (!isChannelPublisher(publisher)) {
    throw new RealtimeError(
      "SHIP_REALTIME_CHANNEL_INVALID",
      "narrowChannelPublisher requires a channel publisher",
      { channelId: isChannel(channel) ? channel.id : undefined },
    );
  }
  if (publisher.channel !== channel) {
    throw new RealtimeError(
      "SHIP_REALTIME_CHANNEL_INVALID",
      `publisher for channel ${JSON.stringify(publisher.channel.id)} cannot be narrowed to channel ${JSON.stringify(isChannel(channel) ? channel.id : "?")}`,
      { channelId: publisher.channel.id },
    );
  }
  return publisher as unknown as ChannelPublisher<TChannel>;
}

// ---------------------------------------------------------------------------
// Publisher registry (derived from channel declarations, never hand-built)
// ---------------------------------------------------------------------------

/**
 * Every publisher the framework created for a set of declared channels,
 * keyed by channel id. A call site outside the kernel (a legacy bridge, a
 * transport adapter) publishes through it by channel id or narrows to a
 * typed publisher; it never assembles a channel-to-dependency map by hand.
 * The same publisher instances back the `providers` an application binds,
 * so the registry and operations share one backend hand-off.
 */
export interface ChannelPublisherRegistry {
  readonly kind: "ship.channel-publisher-registry";
  /** Declared channels in id order. */
  readonly channels: readonly AnyChannel[];
  /** One singleton provider per channel, binding its publication token. */
  readonly providers: readonly Provider<
    ChannelPublisher<AnyChannel>,
    Record<never, never>,
    "singleton"
  >[];
  has(channelId: string): boolean;
  /** The erased publisher for a channel id; undefined when no listed channel has that id. */
  get(channelId: string): AnyChannelPublisher | undefined;
  /** The typed publisher for a listed channel; `SHIP_REALTIME_CHANNEL_INVALID` otherwise. */
  for<TChannel extends AnyChannel>(channel: TChannel): ChannelPublisher<TChannel>;
  /**
   * Publishes by channel id. Scope and payload are validated by the channel's
   * declaration exactly as through the typed publisher; an unknown id is
   * `SHIP_REALTIME_CHANNEL_INVALID` rather than a silent no-op.
   */
  publish(
    channelId: string,
    scope: string | TenantScope,
    payload: unknown,
    options?: ChannelPublishOptions,
  ): Promise<void>;
}

/** A source of channel declarations: an explicit list, or anything that composes modules (a compiled application). */
export type ChannelPublisherRegistrySource =
  | readonly AnyChannel[]
  | { readonly modules: readonly AnyModule[] };

export function createChannelPublisherRegistry(
  source: ChannelPublisherRegistrySource,
  backend: RealtimePublishBackend,
): ChannelPublisherRegistry {
  const listed = Array.isArray(source)
    ? source
    : (source as { readonly modules: readonly AnyModule[] }).modules.flatMap(
        (module) => module.channels,
      );
  const channels = [...listed].sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map<string, AnyChannelPublisher>();
  const providers: Provider<ChannelPublisher<AnyChannel>, Record<never, never>, "singleton">[] = [];
  for (const channel of channels) {
    const publisher = createChannelPublisher(channel, backend);
    if (byId.has(channel.id)) {
      throw new RealtimeError(
        "SHIP_REALTIME_CHANNEL_INVALID",
        `channel ${JSON.stringify(channel.id)} is listed more than once`,
        { channelId: channel.id },
      );
    }
    byId.set(channel.id, publisher);
    providers.push(
      valueProvider(
        channel.publication as DependencyToken<ChannelPublisher<AnyChannel>, unknown>,
        publisher,
      ),
    );
  }
  const require = (channelId: string): AnyChannelPublisher => {
    const publisher = byId.get(channelId);
    if (!publisher) {
      throw new RealtimeError(
        "SHIP_REALTIME_CHANNEL_INVALID",
        `channel ${JSON.stringify(channelId)} is not declared in this publisher registry`,
        { channelId },
      );
    }
    return publisher;
  };
  return Object.freeze({
    kind: "ship.channel-publisher-registry" as const,
    channels: Object.freeze(channels),
    providers: Object.freeze(providers),
    has: (channelId: string) => byId.has(channelId),
    get: (channelId: string) => byId.get(channelId),
    for: <TChannel extends AnyChannel>(channel: TChannel): ChannelPublisher<TChannel> =>
      narrowChannelPublisher(require(isChannel(channel) ? channel.id : ""), channel),
    publish: async (
      channelId: string,
      scope: string | TenantScope,
      payload: unknown,
      options?: ChannelPublishOptions,
    ) => require(channelId).publish(scope, payload, options),
  });
}

// ---------------------------------------------------------------------------
// Subscription authorization (framework-owned enforcement, ADR-0004 / ADR-0008)
// ---------------------------------------------------------------------------

export interface SubscriptionAuthorizerOptions {
  /** Required to authorize tenant channels. Tenant ids are never trusted raw. */
  readonly tenantScopes?: TenantScopeAuthority;
}

export interface SubscriptionAuthorizationRequest {
  readonly channel: AnyChannel;
  readonly scopeKey: string;
  readonly actor?: OperationActor;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export type SubscriptionAuthorizer = (
  request: SubscriptionAuthorizationRequest,
) => Promise<RealtimeAuthorizationDecision>;

/**
 * Every subscription needs a resolved actor. Actor channels admit only the
 * actor's own id, tenant channels require an authentic tenant scope issued by
 * the application's authority, and resource channels defer to the channel's
 * policy. Any thrown policy fails closed.
 */
export function createSubscriptionAuthorizer(
  options: SubscriptionAuthorizerOptions = {},
): SubscriptionAuthorizer {
  return async (request) => {
    const { channel, scopeKey, actor } = request;
    if (!REALTIME_SCOPE_KEY_PATTERN.test(scopeKey)) return { ok: false, reason: "scope-invalid" };
    if (!isOperationActor(actor)) return { ok: false, reason: "forbidden" };
    const context = Object.freeze({ requestId: request.requestId, signal: request.signal });

    if (channel.scope === "actor" && scopeKey !== actor.id) {
      return { ok: false, reason: "scope-invalid" };
    }
    if (channel.scope === "tenant") {
      if (!options.tenantScopes) return { ok: false, reason: "unavailable" };
      try {
        await options.tenantScopes.issue({
          tenantId: scopeKey,
          requestId: request.requestId,
          actor,
        });
      } catch (error) {
        return error instanceof TenantCapabilityError &&
          error.code === "SHIP_TENANT_SCOPE_FORBIDDEN"
          ? { ok: false, reason: "forbidden" }
          : { ok: false, reason: "unavailable" };
      }
    }
    if (channel.authorizeSubscription) {
      let allowed: unknown;
      try {
        allowed = await channel.authorizeSubscription(actor, scopeKey, context);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (allowed !== true) return { ok: false, reason: "forbidden" };
    }
    return { ok: true };
  };
}

/** The synthetic operation an actor resolver sees when a realtime connection is established. */
export function realtimeHandshakeOperation(access: OperationAccess = authenticatedAccess()): {
  readonly id: "realtime.connect";
  readonly access: OperationAccess;
} {
  if (!isOperationAccess(access)) {
    throw new TypeError("realtime handshake access must be a kernel access declaration");
  }
  return Object.freeze({ id: "realtime.connect" as const, access });
}

// ---------------------------------------------------------------------------
// Coalescing (shared by every backend)
// ---------------------------------------------------------------------------

export interface PublicationCoalescer {
  /** Returns true when the publication was absorbed into a pending window. */
  push(scopeKey: string, payload: unknown, flush: (payload: unknown) => void): boolean;
  /** Delivers every pending payload now and cancels timers. */
  drain(): void;
}

/**
 * Collapses publications sharing one (scope key, coalesce key) inside the
 * channel's window into the latest payload. Channels without a coalesce
 * policy get a pass-through coalescer.
 */
export function createPublicationCoalescer(channel: AnyChannel): PublicationCoalescer {
  const policy = channel.coalesce as ChannelCoalescePolicy<unknown> | undefined;
  if (!policy) {
    return Object.freeze({
      push: (_scopeKey: string, payload: unknown, flush: (payload: unknown) => void) => {
        flush(payload);
        return false;
      },
      drain: () => undefined,
    });
  }
  const pending = new Map<
    string,
    { payload: unknown; flush: (payload: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  return Object.freeze({
    push: (scopeKey: string, payload: unknown, flush: (payload: unknown) => void) => {
      const key = `${scopeKey} ${policy.key(payload)}`;
      const existing = pending.get(key);
      if (existing) {
        existing.payload = payload;
        existing.flush = flush;
        return true;
      }
      const timer = setTimeout(() => {
        const entry = pending.get(key);
        pending.delete(key);
        entry?.flush(entry.payload);
      }, policy.windowMs);
      timer.unref?.();
      pending.set(key, { payload, flush, timer });
      return false;
    },
    drain: () => {
      for (const [key, entry] of [...pending]) {
        clearTimeout(entry.timer);
        pending.delete(key);
        entry.flush(entry.payload);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Compilation and graph projection helpers used by application.ts
// ---------------------------------------------------------------------------

export interface ChannelGraphNode {
  readonly id: string;
  readonly moduleId: string;
  readonly scope: ChannelScope;
  /** `projectable` is false when no client manifest can be built from the payload schema. */
  readonly payload: { readonly vendor: string; readonly projectable: boolean };
  readonly presence: boolean;
  readonly coalesce?: { readonly windowMs: number };
  readonly slowSubscriber: SlowSubscriberPolicy;
  readonly publishers: readonly string[];
}

export function collectChannelOwners(
  appId: string,
  modules: readonly AnyModule[],
  diagnostics: ApplicationDiagnostic[],
): ReadonlyMap<string, { readonly module: AnyModule; readonly channel: AnyChannel }> {
  const owners = new Map<string, { module: AnyModule; channel: AnyChannel }>();
  for (const module of [...modules].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const channel of [...module.channels].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const previous = owners.get(channel.id);
      if (previous) {
        diagnostics.push({
          code: "SHIP_CHANNEL_ID_DUPLICATE",
          severity: "error",
          message: `channel id ${JSON.stringify(channel.id)} is declared by both ${JSON.stringify(previous.module.id)} and ${JSON.stringify(module.id)}`,
          hint: "Declare each channel in exactly one module and import that module where it is published.",
          appId,
          moduleId: module.id,
          providerId: channel.publication.id,
          path: "channels",
        });
        continue;
      }
      owners.set(channel.id, { module, channel });
      if (!isManifestProjectable(channel.payload)) {
        diagnostics.push({
          code: "SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE",
          severity: "warning",
          message: `channel ${JSON.stringify(channel.id)} payload (vendor ${JSON.stringify(channel.payload["~standard"].vendor)}) carries no client-manifest projection`,
          hint: "Declare the payload with a Zod v4 schema, or wrap it with contractSchema() from @sixthsummit/ship-contract so the manifest can carry its JSON Schema; the contract build fails otherwise.",
          appId,
          moduleId: module.id,
          providerId: channel.publication.id,
          path: "channels",
        });
      }
    }
  }
  return owners;
}

export function checkOperationPublications(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  owners: ReadonlyMap<string, { readonly module: AnyModule; readonly channel: AnyChannel }>,
  diagnostics: ApplicationDiagnostic[],
): void {
  const context = { appId, moduleId: module.id, operationId: operation.id };
  const declaredIds = new Set(operation.publishes.map((channel) => channel.id));
  const boundPublications = Object.entries(operation.dependencies).flatMap(([name, token]) =>
    isChannelPublicationToken(token) ? [{ name, channelId: token.channelId }] : [],
  );
  const boundIds = new Set(boundPublications.map((item) => item.channelId));

  for (const channel of [...operation.publishes].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const owner = owners.get(channel.id);
    if (!owner || owner.channel !== channel) {
      diagnostics.push({
        code: "SHIP_CHANNEL_UNDECLARED",
        severity: "error",
        message: `operation ${JSON.stringify(operation.id)} publishes to channel ${JSON.stringify(channel.id)} that no module declares`,
        hint: "Add the channel instance to the owning module's channels list.",
        ...context,
        providerId: channel.publication.id,
        path: "publishes",
      });
    } else if (
      owner.module.id !== module.id &&
      !module.imports.includes(owner.module.id) &&
      module.id !== REALTIME_PUBLICATION_MODULE_ID
    ) {
      diagnostics.push({
        code: "SHIP_CHANNEL_IMPORT_REQUIRED",
        severity: "error",
        message: `operation ${JSON.stringify(operation.id)} publishes to channel ${JSON.stringify(channel.id)} from module ${JSON.stringify(owner.module.id)} without importing it`,
        hint: `Add ${JSON.stringify(owner.module.id)} to ${JSON.stringify(module.id)} imports.`,
        ...context,
        providerId: channel.publication.id,
        path: "publishes",
      });
    }
    if (!boundIds.has(channel.id)) {
      diagnostics.push({
        code: "SHIP_OPERATION_PUBLISH_UNBOUND",
        severity: "error",
        message: `operation ${JSON.stringify(operation.id)} declares publication to ${JSON.stringify(channel.id)} without binding its publication token`,
        hint: "Bind channel.publication in the operation dependencies or remove the declaration.",
        ...context,
        providerId: channel.publication.id,
        path: "publishes",
      });
    }
  }
  for (const bound of boundPublications.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (declaredIds.has(bound.channelId)) continue;
    diagnostics.push({
      code: "SHIP_OPERATION_PUBLISH_UNDECLARED",
      severity: "error",
      message: `operation ${JSON.stringify(operation.id)} binds publication to channel ${JSON.stringify(bound.channelId)} without declaring it in publishes`,
      hint: `Add the channel to the operation publishes list.`,
      ...context,
      providerId: `${bound.channelId}${PUBLICATION_SUFFIX}`,
      path: `dependencies.${bound.name}`,
    });
  }
  // A read transaction is read-only, so it cannot record a publication
  // intent; only "none" (immediate) and "write" (outbox) operations publish.
  if (operation.publishes.length > 0 && operation.transaction === "read") {
    diagnostics.push({
      code: "SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN",
      severity: "error",
      message: `read operation ${JSON.stringify(operation.id)} publishes to a realtime channel`,
      hint: 'Publish from a transaction: "none" operation, or from a transaction: "write" operation with defineRealtimePublicationModule() mounted so the intent commits with the change.',
      ...context,
      path: "publishes",
    });
  }
}

export function projectChannels(modules: readonly AnyModule[]): readonly ChannelGraphNode[] {
  const publishers = new Map<string, string[]>();
  for (const module of modules) {
    for (const operation of module.operations) {
      for (const channel of operation.publishes) {
        const list = publishers.get(channel.id) ?? [];
        list.push(operation.id);
        publishers.set(channel.id, list);
      }
    }
  }
  const nodes: ChannelGraphNode[] = [];
  for (const module of modules) {
    for (const channel of module.channels) {
      nodes.push(
        Object.freeze({
          id: channel.id,
          moduleId: module.id,
          scope: channel.scope,
          payload: Object.freeze({
            vendor: channel.payload["~standard"].vendor,
            projectable: isManifestProjectable(channel.payload),
          }),
          presence: channel.presence,
          ...(channel.coalesce
            ? { coalesce: Object.freeze({ windowMs: channel.coalesce.windowMs }) }
            : {}),
          slowSubscriber: channel.slowSubscriber,
          publishers: Object.freeze([...new Set(publishers.get(channel.id) ?? [])].sort()),
        }),
      );
    }
  }
  return Object.freeze(nodes.sort((left, right) => left.id.localeCompare(right.id)));
}
