const DEPENDENCY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

declare const dependencyValue: unique symbol;

/** A stable provider reference. The generic value exists only at type level. */
export type DependencyScope =
  | "unit-of-work"
  | "effect"
  | "outbox"
  | "idempotency"
  | "cache"
  | "job"
  | "attachment";
export type OutboxDependencyRole = "writer" | "backend";
export type JobDependencyRole = "backend" | "enqueue" | "lock";

export interface DependencyToken<TProviderValue = unknown, TResolvedValue = TProviderValue> {
  readonly kind: "ship.dependency";
  readonly id: string;
  readonly scope?: DependencyScope;
  readonly delivery?: "immediate";
  /**
   * Outbox tokens distinguish the transactional writer from the raw backend;
   * job tokens distinguish the backend, a per-job enqueuer and the lock provider.
   */
  readonly role?: OutboxDependencyRole | JobDependencyRole;
  readonly [dependencyValue]?: {
    readonly provider: TProviderValue;
    readonly resolved: TResolvedValue;
  };
}

export type DependencyBindings = Readonly<Record<string, DependencyToken>>;

export type DependencyProviderValue<TToken> =
  TToken extends DependencyToken<infer TProviderValue, unknown> ? TProviderValue : never;

export type ResolveDependencyBindings<TBindings extends DependencyBindings> = Readonly<{
  [TKey in keyof TBindings]: TBindings[TKey] extends DependencyToken<unknown, infer TResolvedValue>
    ? TResolvedValue
    : never;
}>;

export interface UnitOfWork<TCapabilities> {
  readonly kind: "ship.unit-of-work";
  readonly id: string;
  run<TResult>(
    mode: "read" | "write",
    work: (capabilities: TCapabilities) => TResult | Promise<TResult>,
  ): Promise<TResult>;
}

export interface UnitOfWorkDependencyToken<TCapabilities>
  extends DependencyToken<UnitOfWork<TCapabilities>, TCapabilities> {
  readonly scope: "unit-of-work";
}

/**
 * An external-effect capability that must be named by every operation using it.
 * Immediate effects are deliberately unavailable inside database transactions.
 */
export interface EffectDependencyToken<TValue = unknown> extends DependencyToken<TValue> {
  readonly scope: "effect";
  readonly delivery: "immediate";
}

export function dependency<TValue>(id: string): DependencyToken<TValue> {
  assertDependencyId(id);

  return Object.freeze({ kind: "ship.dependency", id }) as DependencyToken<TValue>;
}

/**
 * A provider token whose operation-facing value is the active transaction's
 * scoped capability map rather than the unit-of-work controller itself.
 */
export function unitOfWorkDependency<TCapabilities>(
  id: string,
): UnitOfWorkDependencyToken<TCapabilities> {
  assertDependencyId(id);
  return Object.freeze({
    kind: "ship.dependency" as const,
    id,
    scope: "unit-of-work" as const,
  }) as UnitOfWorkDependencyToken<TCapabilities>;
}

export function effectDependency<TValue>(
  id: string,
  options: { readonly delivery: "immediate" },
): EffectDependencyToken<TValue> {
  assertDependencyId(id);
  if (options?.delivery !== "immediate") {
    throw new TypeError("effect dependency delivery must be immediate");
  }
  return Object.freeze({
    kind: "ship.dependency" as const,
    id,
    scope: "effect" as const,
    delivery: options.delivery,
  }) as EffectDependencyToken<TValue>;
}

export function isDependencyToken(value: unknown): value is DependencyToken {
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "kind") !== "ship.dependency" ||
    typeof Reflect.get(value, "id") !== "string" ||
    !DEPENDENCY_ID_PATTERN.test(Reflect.get(value, "id"))
  ) {
    return false;
  }
  const scope = Reflect.get(value, "scope");
  const delivery = Reflect.get(value, "delivery");
  const role = Reflect.get(value, "role");
  if (
    scope !== undefined &&
    scope !== "unit-of-work" &&
    scope !== "effect" &&
    scope !== "outbox" &&
    scope !== "idempotency" &&
    scope !== "cache" &&
    scope !== "job" &&
    scope !== "attachment"
  ) {
    return false;
  }
  if (scope === "effect" ? delivery !== "immediate" : delivery !== undefined) return false;
  if (scope === "outbox") return role === "writer" || role === "backend";
  if (scope === "job") return role === "backend" || role === "enqueue" || role === "lock";
  return role === undefined;
}

export function isEffectDependencyToken(
  value: DependencyToken,
): value is EffectDependencyToken<unknown> {
  return isDependencyToken(value) && value.scope === "effect" && value.delivery === "immediate";
}

export function isUnitOfWorkDependencyToken(
  value: DependencyToken,
): value is UnitOfWorkDependencyToken<unknown> {
  return isDependencyToken(value) && value.scope === "unit-of-work";
}

export function isUnitOfWork(value: unknown): value is UnitOfWork<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.unit-of-work" &&
    typeof Reflect.get(value, "id") === "string" &&
    DEPENDENCY_ID_PATTERN.test(Reflect.get(value, "id")) &&
    typeof Reflect.get(value, "run") === "function"
  );
}

function assertDependencyId(id: string): void {
  if (!DEPENDENCY_ID_PATTERN.test(id)) {
    throw new TypeError(
      `dependency id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
    );
  }
}
