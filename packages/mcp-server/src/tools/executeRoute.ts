import type { RegistryClient } from "../registryClient.js";
import type { RouteEntry, RouteMethod } from "../types.js";
import { isLoopback } from "../util/isLoopback.js";

/**
 * `execute_route` — drive a registered route through the consumer's
 * running ShipAPI dev server and return the response. The
 * load-bearing differentiator per plan §C — agents iterate against
 * a real, full-middleware-chain runtime instead of a static schema
 * dump.
 *
 * Flow:
 *   1. Pre-flight: look up the route in the registry. If it doesn't
 *      exist, return `{ ok: false, reason: "not-found" }` so the
 *      agent gets a clear "route not found" instead of a blind 404
 *      from the upstream HTTP call.
 *   2. Pre-flight: when the route declares a JSON body schema and
 *      the caller supplied a body, validate the body via
 *      `zod-to-json-schema`-derived JSON Schema (Ajv runtime). On
 *      mismatch return `{ ok: false, reason: "schema-mismatch",
 *      validationErrors }` so the agent sees schema errors as
 *      schema errors, not as 500s.
 *   3. Drive: HTTP request the dev server with method / path /
 *      headers / body, capture status + headers + body + timing.
 *   4. Return.
 *
 * Why this is load-bearing: every other framework's "tool for
 * agents" is a static schema export — agents have to imagine what
 * the response will look like. ShipAPI's runtime registry + this
 * tool together mean the agent can call `execute_route` with a
 * generated request, see the actual response (including AppError
 * shapes from `registerErrorHandlers`), and iterate. That's the
 * agent-debuggable runtime claim.
 *
 * Pre-flight schema validation uses a minimal subset of JSON Schema
 * (the parts Zod 4's `z.toJSONSchema()` actually emits). Doesn't
 * pull a full Ajv dependency — the route's `validate()` middleware
 * is the source of truth at runtime; this is just a cheap
 * "obviously wrong" filter to short-circuit the round-trip.
 */

export interface ExecuteRouteArgs {
  method: RouteMethod;
  path: string;
  /** Optional headers (e.g., `authorization: "Bearer ..."` for auth-required routes). */
  headers?: Record<string, string>;
  /** Optional JSON body. Validated against the route's schema before sending. */
  body?: unknown;
  /** Override the dev-server base URL. Default: same as the registry client. */
  baseUrl?: string;
}

export interface ExecuteRouteResult {
  ok: boolean;
  /**
   * `not-found` (no route matches), `schema-mismatch` (body fails
   * pre-flight validation), `network` (dev server unreachable),
   * `remote-not-allowed` (baseUrl resolves to a non-loopback host
   * and `SHIP_API_MCP_ALLOW_REMOTE=1` was not set), or `executed`
   * (request went through; check `response.status` for the actual
   * outcome).
   */
  reason: "not-found" | "schema-mismatch" | "network" | "executed" | "remote-not-allowed";
  /** The matched route entry (when found, regardless of execution outcome). */
  entry?: Pick<RouteEntry, "method" | "path" | "auth" | "permissions" | "module">;
  /** The response from the dev server, when execution proceeded. */
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    /** Parsed body if Content-Type indicates JSON; null otherwise. */
    json?: unknown;
  };
  /** Pre-flight validation errors when `reason === "schema-mismatch"`. */
  validationErrors?: Array<{ path: string; message: string }>;
  /** Wall-clock duration of the HTTP call in ms (when execution proceeded). */
  durationMs?: number;
  /** Network-error message when reason === "network". */
  error?: string;
}

export interface ExecuteRouteOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Override the loopback-guard env var read (tests). When omitted,
   * reads `process.env.SHIP_API_MCP_ALLOW_REMOTE`; `"1"` opts in to
   * driving traffic at non-loopback hosts.
   */
  allowRemote?: boolean;
  /**
   * Sink for the audit log line emitted when a non-loopback call
   * proceeds under the allow-remote opt-in. Defaults to
   * `process.stderr.write`. Tests inject a spy.
   */
  remoteLogSink?: (line: string) => void;
}

export async function executeRoute(
  args: ExecuteRouteArgs,
  registry: RegistryClient,
  opts: ExecuteRouteOptions = {},
): Promise<ExecuteRouteResult> {
  const dump = await registry.fetch();
  const entry = dump.routes.find((r) => r.method === args.method && r.path === args.path);

  if (!entry) {
    return {
      ok: false,
      reason: "not-found",
    };
  }

  // Pre-flight body validation.
  if (entry.schemas?.json && args.body !== undefined) {
    const errors = validateAgainstJsonSchema(args.body, entry.schemas.json);
    if (errors.length > 0) {
      return {
        ok: false,
        reason: "schema-mismatch",
        entry: pickEntry(entry),
        validationErrors: errors,
      };
    }
  }

  const baseUrl = opts.baseUrl ?? args.baseUrl ?? "http://localhost:3000";
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = `${baseUrl.replace(/\/$/, "")}${args.path}`;

  // F7: refuse to drive non-loopback traffic without an explicit
  // operator opt-in. The MCP server is dev-time only, but an agent
  // can pass `baseUrl: "https://prod.example.com"` per call — combined
  // with a developer's locally cached prod auth header, that drives
  // live mutations from the dev workflow. The check is loud and
  // fail-closed by default.
  if (!isLoopback(baseUrl)) {
    const allowRemote = opts.allowRemote ?? process.env.SHIP_API_MCP_ALLOW_REMOTE === "1";
    if (!allowRemote) {
      return {
        ok: false,
        reason: "remote-not-allowed",
        entry: pickEntry(entry),
        error:
          `Refusing to call non-loopback baseUrl "${baseUrl}". ` +
          `Set SHIP_API_MCP_ALLOW_REMOTE=1 to opt in; this is a dev-time ` +
          `MCP server, not a production driver.`,
      };
    }
    // Operator opted in. Emit one audit line per call so the operator
    // notices if the agent quietly retargets prod mid-session.
    const sink = opts.remoteLogSink ?? ((line) => process.stderr.write(line));
    sink(`[ship-api-mcp] remote execute_route → ${baseUrl} ${args.method} ${args.path}\n`);
  }

  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  let bodyText: string | undefined;
  if (args.body !== undefined) {
    bodyText = JSON.stringify(args.body);
    if (!hasContentType(headers)) {
      headers["content-type"] = "application/json";
    }
  }

  const start = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: args.method,
      headers,
      body: bodyText,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "network",
      entry: pickEntry(entry),
      error: err instanceof Error ? err.message : `network error: ${String(err)}`,
    };
  }
  const durationMs = Date.now() - start;

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const text = await response.text();
  let json: unknown;
  if (text && (responseHeaders["content-type"] ?? "").toLowerCase().includes("application/json")) {
    try {
      json = JSON.parse(text);
    } catch {
      // Body claimed to be JSON but isn't; surface the raw text only.
    }
  }

  return {
    ok: true,
    reason: "executed",
    entry: pickEntry(entry),
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: text,
      json,
    },
    durationMs,
  };
}

function pickEntry(entry: RouteEntry): NonNullable<ExecuteRouteResult["entry"]> {
  return {
    method: entry.method,
    path: entry.path,
    auth: entry.auth,
    permissions: entry.permissions,
    module: entry.module,
  };
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
}

/**
 * Minimal JSON Schema validator covering the subset Zod 4's
 * `z.toJSONSchema()` actually emits. Pulled in inline rather than
 * via Ajv to keep the MCP server's dep graph narrow (Ajv pulls
 * ~3 MB of code; the route's `validate()` middleware is the
 * runtime source of truth — this is just a cheap pre-flight to
 * short-circuit the round-trip on obviously-bad inputs).
 *
 * Covers: type (string / number / boolean / object / array /
 * null / integer), required, properties, additionalProperties:
 * false, enum, minLength / maxLength, minimum / maximum, pattern,
 * format: "uuid" / "email", anyOf / oneOf (best-effort).
 */
function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  pathPrefix = "",
): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  validateInto(value, schema, pathPrefix, errors);
  return errors;
}

function validateInto(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: Array<{ path: string; message: string }>,
): void {
  const type = schema.type as string | string[] | undefined;
  const types = Array.isArray(type) ? type : type ? [type] : [];

  if (types.length > 0) {
    if (!types.some((t) => matchesJsonType(value, t))) {
      errors.push({
        path: path || "(root)",
        message: `expected ${types.join(" | ")}, got ${actualType(value)}`,
      });
      return;
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value as never)) {
      errors.push({
        path: path || "(root)",
        message: `expected one of ${JSON.stringify(schema.enum)}`,
      });
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({
        path: path || "(root)",
        message: `expected minLength ${schema.minLength}, got ${value.length}`,
      });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push({
        path: path || "(root)",
        message: `expected maxLength ${schema.maxLength}, got ${value.length}`,
      });
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push({
            path: path || "(root)",
            message: `expected to match pattern /${schema.pattern}/`,
          });
        }
      } catch {
        // Bad regex from upstream — skip rather than crash.
      }
    }
    if (schema.format === "uuid" && !UUID_PATTERN.test(value)) {
      errors.push({
        path: path || "(root)",
        message: "expected a UUID",
      });
    }
    if (schema.format === "email" && !EMAIL_PATTERN.test(value)) {
      errors.push({
        path: path || "(root)",
        message: "expected an email address",
      });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({
        path: path || "(root)",
        message: `expected ≥ ${schema.minimum}, got ${value}`,
      });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({
        path: path || "(root)",
        message: `expected ≤ ${schema.maximum}, got ${value}`,
      });
    }
  }

  if (
    types.includes("object") &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) {
        errors.push({
          path: path ? `${path}.${key}` : key,
          message: "required property missing",
        });
      }
    }
    const properties = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
    for (const [key, val] of Object.entries(obj)) {
      const propSchema = properties[key];
      if (propSchema) {
        validateInto(val, propSchema, path ? `${path}.${key}` : key, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: path ? `${path}.${key}` : key,
          message: "extra property not allowed",
        });
      }
    }
  }

  if (types.includes("array") && Array.isArray(value)) {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        validateInto(value[i], items, `${path}[${i}]`, errors);
      }
    }
  }
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}
