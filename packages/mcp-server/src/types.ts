/**
 * Shape of the `/dev/routes.json` payload the MCP server consumes.
 *
 * Mirrors the framework's `RouteEntry` shape, but treats schemas as
 * pre-serialized JSON Schema (the framework converts via Zod v4's native
 * `z.toJSONSchema()` before emitting). This keeps the MCP server free of
 * a Zod runtime dep — it just ferries JSON between the framework and the
 * LLM agent.
 *
 * The MCP server doesn't import the framework directly; the JSON dump
 * is the contract.
 */

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "WS";

export interface JsonSchema {
  $schema?: string;
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface RouteEntry {
  method: RouteMethod;
  path: string;
  module?: string;
  auth: { required: boolean; provider?: string };
  permissions: string[];
  rateLimit?: { windowMs: number; max: number; scope?: string };
  idempotent?: boolean;
  schemas: {
    json?: JsonSchema | { _present: true };
    query?: JsonSchema | { _present: true };
    param?: JsonSchema | { _present: true };
    header?: JsonSchema | { _present: true };
  };
  description?: string;
  tags?: string[];
  deprecated?: boolean;
}

export interface RoutesDump {
  ok: boolean;
  count: number;
  routes: RouteEntry[];
}

/** Filter accepted by `list_routes`. */
export interface RouteFilter {
  method?: RouteMethod;
  path?: string;
  module?: string;
  tag?: string;
}
