import type { AnyOperation } from "@sixthsummit/ship-core";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { HonoAdapterError } from "./diagnostics.js";
import { isHttpTransport } from "./transport.js";

/**
 * Response headers every Ship HTTP response may carry and a browser client
 * reads: the request id the migration guide tells consumers to surface, and
 * the declared read-cache marker. Always exposed; consumers add their own.
 */
const DEFAULT_EXPOSE_HEADERS = ["X-Request-Id", "X-Ship-Cache"] as const;
/**
 * Request headers a Ship client sends on every call. Merged into an explicit
 * `allowHeaders` list so a consumer allowlist cannot lock the framework's own
 * headers out of a preflight.
 */
const DEFAULT_ALLOW_HEADERS = ["Content-Type", "X-Request-Id"] as const;

/**
 * Cross-origin policy for the adapter. The shape matches the compatibility
 * distribution's `CorsOptions` (`createApp({ cors })` in `@sixthsummit/ship-api`)
 * so an application moving between the two tiers passes the same object.
 */
export interface HonoCorsOptions {
  /**
   * Allowed origins: one origin, an explicit allowlist, or a per-request
   * resolver returning the matched origin (`null`/`undefined` denies).
   *
   * `"*"` is accepted only while `credentials` is not `true`. Browsers refuse
   * the wildcard-plus-credentials pairing, and a server that emits it is one
   * non-compliant client away from a CSRF bypass, so the adapter refuses to
   * construct under that combination instead of failing at request time.
   */
  readonly origin:
    | string
    | readonly string[]
    | ((origin: string, context: Context) => string | null | undefined);
  /** Methods allowed on cross-origin requests. Defaults to Hono's list. */
  readonly allowMethods?: readonly string[];
  /**
   * Request headers permitted in a preflight. When omitted the preflight
   * reflects the browser's `Access-Control-Request-Headers`; when set,
   * `Content-Type` and `X-Request-Id` are always included.
   */
  readonly allowHeaders?: readonly string[];
  /**
   * Response headers the browser exposes to client code. `X-Request-Id`,
   * `X-Ship-Cache` and every header declared on an operation error are
   * always exposed; list any header your operations set through `respond()`.
   */
  readonly exposeHeaders?: readonly string[];
  /** Preflight cache duration in seconds (`Access-Control-Max-Age`). */
  readonly maxAge?: number;
  /**
   * Allow cookies and `Authorization` on cross-origin requests. Requires an
   * explicit origin allowlist or resolver, never `"*"`.
   */
  readonly credentials?: boolean;
}

/** Validates the policy at construction so a misconfiguration is a boot error. */
export function assertCorsOptions(options: unknown): asserts options is HonoCorsOptions {
  if (typeof options !== "object" || options === null) {
    throw corsInvalid("cors must be an object with an origin");
  }
  const origin = Reflect.get(options, "origin");
  const originIsList = Array.isArray(origin);
  if (
    !(
      (typeof origin === "string" && origin.length > 0) ||
      typeof origin === "function" ||
      (originIsList && origin.length > 0 && origin.every(isNonEmptyString))
    )
  ) {
    throw corsInvalid(
      "cors.origin must be an origin string, a non-empty list of origins, or a resolver function",
    );
  }
  for (const name of ["allowMethods", "allowHeaders", "exposeHeaders"] as const) {
    const value = Reflect.get(options, name);
    if (value !== undefined && !(Array.isArray(value) && value.every(isNonEmptyString))) {
      throw corsInvalid(`cors.${name} must be a list of header or method names`);
    }
  }
  const maxAge = Reflect.get(options, "maxAge");
  if (maxAge !== undefined && (!Number.isSafeInteger(maxAge) || maxAge < 0)) {
    throw corsInvalid("cors.maxAge must be a non-negative integer number of seconds");
  }
  const credentials = Reflect.get(options, "credentials");
  if (credentials !== undefined && typeof credentials !== "boolean") {
    throw corsInvalid("cors.credentials must be a boolean");
  }
  if (credentials !== true) return;

  if (origin === "*") {
    throw corsInvalid(
      "cors.origin: '*' is incompatible with credentials: true. " +
        "Pass an explicit allowlist (string[] of origins) instead.",
    );
  }
  if (originIsList && origin.length === 1 && origin[0] === "*") {
    throw corsInvalid(
      "cors.origin: ['*'] is incompatible with credentials: true. " +
        "Pass an explicit allowlist (string[] of origins) instead.",
    );
  }
  if (originIsList && origin.includes("*")) {
    throw corsInvalid(
      "cors.origin contains '*' alongside other entries, which is ambiguous " +
        "under credentials: true. Pass only explicit origins.",
    );
  }
}

/**
 * Builds the global middleware. Hono's `cors()` answers every `OPTIONS`
 * request itself, so an application that declares an `http.options(...)`
 * operation cannot also enable CORS: the operation would never run.
 */
export function createCorsMiddleware(
  options: HonoCorsOptions,
  operations: readonly AnyOperation[],
): MiddlewareHandler {
  const optionsOperation = operations.find(
    (operation) =>
      isHttpTransport(operation.transport) && operation.transport.metadata.method === "OPTIONS",
  );
  if (optionsOperation) {
    throw corsInvalid(
      `cors answers every OPTIONS request as a preflight, so operation ${JSON.stringify(optionsOperation.id)} would never run. Remove the OPTIONS transport or the cors option.`,
    );
  }

  // Unset keys are omitted rather than forwarded as `undefined`: Hono merges
  // options by spread, so an explicit `undefined` replaces its default (for
  // `allowMethods` that dropped `Access-Control-Allow-Methods` from every
  // preflight and broke browser-issued DELETE/PUT/PATCH).
  type HonoCorsConfig = NonNullable<Parameters<typeof cors>[0]>;
  const config: HonoCorsConfig = {
    origin: options.origin as HonoCorsConfig["origin"],
    exposeHeaders: mergeHeaderNames(
      DEFAULT_EXPOSE_HEADERS,
      declaredErrorHeaders(operations),
      options.exposeHeaders ?? [],
    ),
  };
  if (options.allowMethods) config.allowMethods = Array.from(options.allowMethods);
  if (options.allowHeaders) {
    config.allowHeaders = mergeHeaderNames(DEFAULT_ALLOW_HEADERS, options.allowHeaders);
  }
  if (options.maxAge !== undefined) config.maxAge = options.maxAge;
  if (options.credentials !== undefined) config.credentials = options.credentials;
  return cors(config);
}

/** Headers declared on operation errors, which a browser client reads through `result.metadata`. */
function declaredErrorHeaders(operations: readonly AnyOperation[]): readonly string[] {
  const names: string[] = [];
  for (const operation of operations) {
    for (const error of operation.errors) {
      for (const header of error.headers ?? []) names.push(header);
    }
  }
  return names.sort((left, right) => left.localeCompare(right, "en"));
}

function mergeHeaderNames(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const name of list) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(name);
    }
  }
  return merged;
}

function corsInvalid(message: string): HonoAdapterError {
  return new HonoAdapterError("SHIP_HONO_CORS_INVALID", message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
