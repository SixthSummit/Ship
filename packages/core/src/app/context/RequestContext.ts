import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Canonical per-request context for the framework.
 *
 * One `AsyncLocalStorage` instance shared across the whole stack so the same
 * `requestId` / `userId` / `tenantId` flow into:
 *   - the pino logger's mixin (every log line auto-includes them)
 *   - `DrizzleEntityService` lifecycle hooks (audit / CDC / multi-tenant scoping)
 *   - OTel span attributes (via the framework's `withSpan` helper, when wired)
 *
 * The shape is intentionally narrow: framework-stable fields up top, free-form
 * overflow under `extra` so consumers can attach module-specific data without
 * mutating the type. The optional `tx` field is populated inside
 * `withTransaction(...)` so lifecycle hooks know they're inside an active
 * transaction (and what `tx` to use for nested writes).
 *
 * `tx` is typed `unknown` here to avoid a circular dep on Drizzle types from
 * the context layer; callers cast to `DrizzleTx` (or equivalent) at the use
 * site. This keeps `RequestContext` a pure type primitive that both the
 * logger and the data layer can depend on without importing each other.
 */
export interface RequestContext {
  /** Stable per-request identifier propagated end-to-end. */
  requestId?: string;

  /** Authenticated account identifier set by `requireAuth`. */
  userId?: string;

  /**
   * Active tenant for the request, published by `resolveTenant()`. Read the
   * active tenant from here — never from `account.tenantId` directly — so a
   * future one-tenant-per-user → membership move (Model A → B) stays a
   * one-middleware change. `undefined` for single-tenant products.
   */
  tenantId?: string;

  /**
   * Active database transaction handle when running inside `withTransaction`.
   * `unknown` here to avoid a context → Drizzle dependency.
   */
  tx?: unknown;

  /**
   * Free-form extras included under their own keys in log lines and
   * available to lifecycle hooks. Use sparingly; prefer first-class fields
   * if a value is framework-wide.
   */
  extra?: Record<string, unknown>;
}

/**
 * The single framework-wide `AsyncLocalStorage`. All context-aware code
 * (logger, services, hooks, tracing) reads from this one store.
 */
export const requestContextStore = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStore.run(ctx, fn);
}

/**
 * Mutate the *current* context if one is active. Returns `false` if no context
 * exists (e.g., called outside an HTTP request). Useful from middleware that
 * resolves a user mid-request, or from `withTransaction` setting `tx`.
 */
export function setRequestContextField<K extends keyof RequestContext>(
  key: K,
  value: RequestContext[K],
): boolean {
  const ctx = requestContextStore.getStore();
  if (!ctx) return false;
  ctx[key] = value;
  return true;
}
