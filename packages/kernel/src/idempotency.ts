import type { DependencyToken } from "./dependency.js";
import { isDependencyToken } from "./dependency.js";

const STORE_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

export type IdempotencyClaim = "claimed" | "duplicate" | "in-flight";

/**
 * Invocation context passed to every store call. `scope` is the active
 * unit-of-work capability map when the operation runs inside a transaction;
 * transaction-aware stores use it to record the claim and result atomically
 * with the business change. `now` keeps expiry deterministic in tests.
 */
export interface IdempotencyContext {
  readonly scope?: object;
  readonly now: Date;
}

export interface IdempotencyStore {
  readonly kind: "ship.idempotency-store";
  claim(key: string, ttlMs: number, context: IdempotencyContext): Promise<IdempotencyClaim>;
  complete(key: string, result: unknown, context: IdempotencyContext): Promise<void>;
  release(key: string, context: IdempotencyContext): Promise<void>;
  readResult(key: string, context: IdempotencyContext): Promise<unknown | undefined>;
}

export interface IdempotencyStoreDependencyToken
  extends DependencyToken<IdempotencyStore, IdempotencyStore> {
  readonly scope: "idempotency";
}

/** The success result the executor stores and replays for duplicate keys. */
export interface StoredIdempotentResult {
  readonly status: number;
  readonly data: unknown;
  /** JSON-safe marker for an undefined success body (JSONB omits undefined properties). */
  readonly dataUndefined?: true;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface OperationIdempotency<TInput = unknown> {
  /** Derives the caller-supplied key from validated input. Must return a non-empty string. */
  readonly key: (input: TInput) => string;
  /** How long a claim or completed result blocks re-execution. */
  readonly windowMs: number;
  readonly store: IdempotencyStoreDependencyToken;
}

export function idempotencyStoreDependency(id: string): IdempotencyStoreDependencyToken {
  if (typeof id !== "string" || !STORE_ID_PATTERN.test(id)) {
    throw new TypeError(
      `idempotency store id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
    );
  }
  return Object.freeze({
    kind: "ship.dependency" as const,
    id,
    scope: "idempotency" as const,
  }) as IdempotencyStoreDependencyToken;
}

export function isIdempotencyStoreDependencyToken(
  value: unknown,
): value is IdempotencyStoreDependencyToken {
  return isDependencyToken(value) && value.scope === "idempotency";
}

export function isIdempotencyStore(value: unknown): value is IdempotencyStore {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.idempotency-store" &&
    ["claim", "complete", "release", "readResult"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}

export function isOperationIdempotency(value: unknown): value is OperationIdempotency {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "key") === "function" &&
    typeof Reflect.get(value, "windowMs") === "number" &&
    Number.isInteger(Reflect.get(value, "windowMs")) &&
    Reflect.get(value, "windowMs") > 0 &&
    isIdempotencyStoreDependencyToken(Reflect.get(value, "store"))
  );
}

export function isStoredIdempotentResult(value: unknown): value is StoredIdempotentResult {
  if (typeof value !== "object" || value === null) return false;
  const status = Reflect.get(value, "status");
  const dataUndefined = Reflect.get(value, "dataUndefined");
  const headers = Reflect.get(value, "headers");
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 200 &&
    status <= 299 &&
    "data" in value &&
    (dataUndefined === undefined ||
      (dataUndefined === true && Reflect.get(value, "data") === null)) &&
    (headers === undefined ||
      (typeof headers === "object" &&
        headers !== null &&
        Object.values(headers).every((item) => typeof item === "string")))
  );
}
