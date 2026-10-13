/**
 * Symbol-keyed metadata tags that middleware factories attach to their
 * returned `MiddlewareHandler` so `createApp` can pick them up at route-
 * registration time and populate the route registry.
 *
 * Each tag has a stable type so the registry-extraction logic is type-safe.
 * Symbol-keyed (rather than string-keyed) so consumer middleware can't
 * accidentally collide with framework tags.
 *
 * Middleware that wants to be discoverable in the registry attaches the tag
 * via `(handler as Tagged<...>)[SCHEMA_META] = { ... }` after construction.
 * Code that reads tags uses `getMetaTag(handler, SCHEMA_META)` to safely
 * extract the value.
 */

import type { ZodType } from "zod";

export const SCHEMA_META = Symbol.for("ship-api.schema-meta");
export const AUTH_META = Symbol.for("ship-api.auth-meta");
export const PERMISSION_META = Symbol.for("ship-api.permission-meta");
export const RATE_LIMIT_META = Symbol.for("ship-api.rate-limit-meta");
export const IDEMPOTENCY_META = Symbol.for("ship-api.idempotency-meta");

export interface SchemaMeta {
  target: "json" | "query" | "param" | "header";
  schema: ZodType;
  description?: string;
  example?: unknown;
}

export interface AuthMeta {
  /** `false` when `requireAuth({ optional: true })` was used. */
  required: boolean;
  /** Provider name (`"firebase"`, `"clerk"`, etc.) for documentation/observability. */
  providerName?: string;
}

export interface PermissionMeta {
  permissions: string[];
}

export interface RateLimitMeta {
  windowMs: number;
  max: number;
  scope?: string;
}

export interface IdempotencyMeta {
  ttlSec: number;
  scope?: string;
}

/** Type-safe getter for a tag on a middleware handler. */
export function getMetaTag<T>(handler: unknown, tag: symbol): T | undefined {
  if (handler === null || handler === undefined) return undefined;
  if (typeof handler !== "function" && typeof handler !== "object") return undefined;
  return (handler as Record<symbol, T | undefined>)[tag];
}

/** Type-safe setter — middleware factories use this to tag their result. */
export function setMetaTag<T>(handler: object, tag: symbol, value: T): void {
  (handler as Record<symbol, T>)[tag] = value;
}
