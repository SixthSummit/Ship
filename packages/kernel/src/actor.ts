import type { OperationAccess } from "./access.js";

const ACTOR_RESOLVER_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const IDENTITY_PROVIDER_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

/** Verified external identity, distinct from an application-owned actor row. */
export interface OperationIdentity {
  readonly provider: string;
  readonly subject: string;
}

export function operationIdentity(definition: OperationIdentity): OperationIdentity {
  if (!isOperationIdentity(definition)) {
    throw new TypeError(
      "operation identity must have a lowercase provider id and non-empty subject",
    );
  }
  return Object.freeze({ provider: definition.provider, subject: definition.subject });
}

export type OperationActorKind = "human" | "system" | "provider";

/** Audit attribution for work performed on behalf of another actor. Never used for authorization. */
export interface OperationActorAttribution {
  readonly actorId: string;
}

interface OperationActorBase {
  readonly id: string;
  readonly kind: OperationActorKind;
  /** Complete permission snapshot for this invocation. */
  readonly permissions?: ReadonlySet<string>;
}

/** An authenticated end user resolved from transport credentials. */
export interface HumanOperationActor extends OperationActorBase {
  readonly kind: "human";
}

/**
 * Framework- or application-scheduled work such as an outbox dispatcher or job
 * runner. System status grants no implicit privilege: permission and tenant
 * checks still apply to every invocation.
 */
export interface SystemOperationActor extends OperationActorBase {
  readonly kind: "system";
  readonly onBehalfOf?: OperationActorAttribution;
}

/**
 * An external party whose call was verified against a named provider (for
 * example a signed webhook). Construct one only after verification succeeds.
 */
export interface ProviderOperationActor extends OperationActorBase {
  readonly kind: "provider";
  readonly provider: string;
  readonly onBehalfOf?: OperationActorAttribution;
}

export type OperationActor = HumanOperationActor | SystemOperationActor | ProviderOperationActor;

/**
 * An actor snapshot built before actor kinds existed (ship-core 1.0, or a
 * nested 1.0 copy pulled in by an older adapter). It carries no `kind` and is
 * always a human actor; it can never claim system or provider status.
 */
export interface LegacyOperationActor {
  readonly id: string;
  readonly kind?: undefined;
  /** Complete permission snapshot for this invocation. */
  readonly permissions?: ReadonlySet<string>;
}

/**
 * Any actor the framework accepts at an input boundary (resolver results,
 * `executor.run`). Boundaries normalise it with `normalizeOperationActor()`, so
 * handlers always see an `OperationActor` whose `kind` is present.
 */
export type OperationActorInput = OperationActor | LegacyOperationActor;

interface ActorDefinitionBase {
  readonly id: string;
  readonly permissions?: Iterable<string>;
}

export interface HumanActorDefinition extends ActorDefinitionBase {
  readonly kind?: "human";
}

export interface SystemActorDefinition extends ActorDefinitionBase {
  readonly kind: "system";
  readonly onBehalfOf?: OperationActorAttribution;
}

export interface ProviderActorDefinition extends ActorDefinitionBase {
  readonly kind: "provider";
  readonly provider: string;
  readonly onBehalfOf?: OperationActorAttribution;
}

export type OperationActorDefinition =
  | HumanActorDefinition
  | SystemActorDefinition
  | ProviderActorDefinition;

export function operationActor(definition: HumanActorDefinition): HumanOperationActor;
export function operationActor(definition: SystemActorDefinition): SystemOperationActor;
export function operationActor(definition: ProviderActorDefinition): ProviderOperationActor;
export function operationActor(definition: OperationActorDefinition): OperationActor;
/**
 * Freezes an actor snapshot. A definition without `kind` is a human actor so
 * credential-resolved actors keep working unchanged; system and provider
 * actors must name their kind explicitly.
 */
export function operationActor(definition: OperationActorDefinition): OperationActor {
  if (typeof definition !== "object" || definition === null) {
    throw new TypeError("operation actor definition must be an object");
  }
  const kind = definition.kind ?? "human";
  const actor = {
    id: definition.id,
    kind,
    ...(definition.permissions ? { permissions: permissionSnapshot(definition.permissions) } : {}),
    ...(kind === "provider" ? { provider: Reflect.get(definition, "provider") } : {}),
    ...(kind !== "human" && Reflect.get(definition, "onBehalfOf") !== undefined
      ? { onBehalfOf: freezeAttribution(Reflect.get(definition, "onBehalfOf")) }
      : {}),
  };
  if (!isOperationActor(actor)) {
    throw new TypeError(
      "operation actor must have a non-empty id, a known kind, string permissions, and a lowercase provider id for provider actors",
    );
  }
  return Object.freeze(actor);
}

export function humanActor(definition: Omit<HumanActorDefinition, "kind">): HumanOperationActor {
  return operationActor({ ...definition, kind: "human" });
}

export function systemActor(definition: Omit<SystemActorDefinition, "kind">): SystemOperationActor {
  return operationActor({ ...definition, kind: "system" });
}

/** Call only after the provider's verification step (signature, token, or allowlist) has succeeded. */
export function providerActor(
  definition: Omit<ProviderActorDefinition, "kind">,
): ProviderOperationActor {
  return operationActor({ ...definition, kind: "provider" });
}

function freezeAttribution(value: unknown): OperationActorAttribution {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "actorId") !== "string" ||
    Reflect.get(value, "actorId").trim().length === 0
  ) {
    throw new TypeError("operation actor onBehalfOf must name a non-empty actorId");
  }
  return Object.freeze({ actorId: Reflect.get(value, "actorId") as string });
}

export function permissionSnapshot(permissions: Iterable<string>): ReadonlySet<string> {
  return Object.freeze(new ImmutableStringSet(permissions));
}

export interface ActorResolutionRequest<TCredential> {
  readonly credential: TCredential | undefined;
  readonly operation: {
    readonly id: string;
    readonly access: OperationAccess;
  };
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export type ActorResolutionFailureReason = "invalid-credential" | "forbidden" | "unavailable";

export type ActorResolutionFailure = {
  readonly ok: false;
  readonly reason: ActorResolutionFailureReason;
};

/**
 * What callers of `resolver.resolve()` receive: any actor has its `kind`. This
 * is the 1.0 contract, so code that passes `resolution.actor` on as an
 * `OperationActor` keeps compiling.
 */
export type ActorResolution =
  | { readonly ok: true; readonly identity?: OperationIdentity; readonly actor?: OperationActor }
  | ActorResolutionFailure;

/** @deprecated Same as `ActorResolution`; kept for code written against 1.1 alphas. */
export type NormalizedActorResolution = ActorResolution;

/**
 * What a resolver definition may return. Its actor may predate actor kinds (see
 * `OperationActorInput`); `defineActorResolver()` normalises it before any
 * caller sees it.
 */
export type ActorResolutionResult =
  | {
      readonly ok: true;
      readonly identity?: OperationIdentity;
      readonly actor?: OperationActorInput;
    }
  | ActorResolutionFailure;

export interface ActorResolver<TCredential = unknown> {
  readonly id: string;
  resolve(request: ActorResolutionRequest<TCredential>): ActorResolution | Promise<ActorResolution>;
}

/** The argument to `defineActorResolver()`: like `ActorResolver`, but may return a kind-less actor. */
export interface ActorResolverDefinition<TCredential = unknown> {
  readonly id: string;
  resolve(
    request: ActorResolutionRequest<TCredential>,
  ): ActorResolutionResult | Promise<ActorResolutionResult>;
}

/**
 * Validates a resolver definition and returns a resolver whose results are
 * normalised, so every caller gets actors with a `kind`. A result that is not a
 * valid resolution is passed through unchanged for the request boundary to
 * reject, as before.
 */
export function defineActorResolver<TCredential>(
  resolver: ActorResolverDefinition<TCredential>,
): ActorResolver<TCredential> {
  if (!ACTOR_RESOLVER_ID_PATTERN.test(resolver.id)) {
    throw new TypeError(
      `actor resolver id must be a lowercase dot-separated identifier; received ${JSON.stringify(resolver.id)}`,
    );
  }
  if (typeof resolver.resolve !== "function") {
    throw new TypeError("actor resolver must define resolve(request)");
  }
  const resolve = resolver.resolve.bind(resolver);
  const normalize = (result: ActorResolutionResult): ActorResolution =>
    normalizeActorResolution(result) ?? (result as ActorResolution);
  return Object.freeze({
    ...resolver,
    resolve(request: ActorResolutionRequest<TCredential>) {
      const result = resolve(request);
      return result instanceof Promise ? result.then(normalize) : normalize(result);
    },
  });
}

export function isActorResolver(value: unknown): value is ActorResolver {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "string" &&
    ACTOR_RESOLVER_ID_PATTERN.test(Reflect.get(value, "id")) &&
    typeof Reflect.get(value, "resolve") === "function"
  );
}

/**
 * True for any value a resolver may return, including a success whose actor
 * predates actor kinds. Request boundaries should call
 * `normalizeActorResolution()` instead, which also fills in the actor kind.
 */
export function isActorResolution(value: unknown): value is ActorResolutionResult {
  return normalizeActorResolution(value) !== undefined;
}

/**
 * Normalises then validates a resolver result. A success actor without `kind`
 * becomes a frozen human actor (the same default `operationActor()` applies),
 * so a resolver built on ship-core 1.0 keeps working. Returns `undefined` when
 * the value is not a valid resolution.
 */
export function normalizeActorResolution(value: unknown): ActorResolution | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "ok") !== "boolean"
  ) {
    return undefined;
  }
  if (Reflect.get(value, "ok") === true) {
    const rawActor = Reflect.get(value, "actor");
    const identity = Reflect.get(value, "identity");
    const actor = rawActor === undefined ? undefined : normalizeOperationActor(rawActor);
    if (rawActor !== undefined && actor === undefined) return undefined;
    if (identity !== undefined && !isOperationIdentity(identity)) return undefined;
    return {
      ok: true,
      ...(actor ? { actor } : {}),
      ...(identity !== undefined ? { identity } : {}),
    };
  }
  const reason = Reflect.get(value, "reason");
  return reason === "invalid-credential" || reason === "forbidden" || reason === "unavailable"
    ? { ok: false, reason }
    : undefined;
}

/**
 * Returns the actor in its current shape, or `undefined` when the value is not
 * an actor. A valid actor is returned as is. An actor without `kind` (built on
 * ship-core 1.0) becomes a frozen human actor; it is rejected if it carries
 * `provider` or `onBehalfOf`, because only an explicit kind may claim those.
 */
export function normalizeOperationActor(value: unknown): OperationActor | undefined {
  if (isOperationActor(value)) return value;
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "kind") !== undefined ||
    Reflect.get(value, "provider") !== undefined ||
    Reflect.get(value, "onBehalfOf") !== undefined
  ) {
    return undefined;
  }
  const permissions = Reflect.get(value, "permissions");
  if (permissions !== undefined && !isStringSet(permissions)) return undefined;
  try {
    return operationActor({
      id: Reflect.get(value, "id") as string,
      ...(permissions !== undefined ? { permissions } : {}),
    });
  } catch {
    return undefined;
  }
}

export function isOperationActor(actor: unknown): actor is OperationActor {
  if (
    typeof actor !== "object" ||
    actor === null ||
    typeof Reflect.get(actor, "id") !== "string" ||
    Reflect.get(actor, "id").trim().length === 0 ||
    (Reflect.get(actor, "permissions") !== undefined &&
      !isStringSet(Reflect.get(actor, "permissions")))
  ) {
    return false;
  }
  const kind = Reflect.get(actor, "kind");
  const provider = Reflect.get(actor, "provider");
  const onBehalfOf = Reflect.get(actor, "onBehalfOf");
  if (kind === "human") return provider === undefined && onBehalfOf === undefined;
  if (kind !== "system" && kind !== "provider") return false;
  if (kind === "system" && provider !== undefined) return false;
  if (
    kind === "provider" &&
    (typeof provider !== "string" || !IDENTITY_PROVIDER_PATTERN.test(provider))
  ) {
    return false;
  }
  return (
    onBehalfOf === undefined ||
    (typeof onBehalfOf === "object" &&
      onBehalfOf !== null &&
      typeof Reflect.get(onBehalfOf, "actorId") === "string" &&
      Reflect.get(onBehalfOf, "actorId").trim().length > 0)
  );
}

export function isOperationIdentity(identity: unknown): identity is OperationIdentity {
  return (
    typeof identity === "object" &&
    identity !== null &&
    typeof Reflect.get(identity, "provider") === "string" &&
    IDENTITY_PROVIDER_PATTERN.test(Reflect.get(identity, "provider")) &&
    typeof Reflect.get(identity, "subject") === "string" &&
    Reflect.get(identity, "subject").trim().length > 0
  );
}

function isStringSet(value: unknown): value is ReadonlySet<string> {
  if (typeof value !== "object" || value === null) return false;

  try {
    if (
      typeof Reflect.get(value, "has") !== "function" ||
      typeof Reflect.get(value, Symbol.iterator) !== "function"
    ) {
      return false;
    }
    return [...(value as Iterable<unknown>)].every((item) => typeof item === "string");
  } catch {
    return false;
  }
}

class ImmutableStringSet implements ReadonlySet<string> {
  readonly #values: Set<string>;

  constructor(values: Iterable<string>) {
    this.#values = new Set(values);
    if ([...this.#values].some((value) => typeof value !== "string")) {
      throw new TypeError("permission snapshot values must be strings");
    }
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: string): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[string, string]> {
    return this.#values.entries();
  }

  keys(): SetIterator<string> {
    return this.#values.keys();
  }

  values(): SetIterator<string> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void): void {
    for (const value of this.#values) callbackfn(value, value, this);
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.#values[Symbol.iterator]();
  }
}
