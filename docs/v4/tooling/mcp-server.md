# MCP server

> **Optional compatibility tooling:** this server introspects the monolithic
> development route registry. New operation applications use the compiled graph
> through `ship-api inspect` and `affected` without requiring a running server.

`@sixthsummit/ship-api-mcp-server` — four tools that let agents introspect and exercise the running dev server: `list_routes`, `describe_route`, `find_route_collisions`, and `execute_route`. The last one is the framework's load-bearing differentiator.

## Why an MCP server

LLM agents writing code against an unfamiliar API have two failure modes:

1. **They invent endpoints that don't exist.** "POST /accounts/create" sounds plausible; it isn't a route.
2. **They invent request shapes that don't validate.** "Pass `{ email, name }`" — but the route requires `displayName`, not `name`.

Both surface only when the code runs. Both waste cycles — the agent writes a chunk of code, runs it, gets a 404 or 400, debugs, retries. The MCP server cuts that loop short by giving the agent direct access to the running app's route registry and pre-flight schema validation.

Agents iterate against **the real middleware chain**, not a static schema document, not the agent's prior model of the API. Schema errors come back as schema errors with field-by-field detail. 404s come back with "did you mean..." suggestions. The agent learns and adjusts in tighter loops.

## How it connects

The MCP server runs as a separate process — Claude Code launches it via `npx -y @sixthsummit/ship-api-mcp-server` when a tool is called. It connects to the running dev server over HTTP:

```
Claude Code  ↔  MCP server  ↔  ship-api dev (http://localhost:3000)
   stdio          (this)              HTTP
```

The dev server exposes `/dev/routes.json` (registered by `InitDevRoutes` at boot priority 85) which dumps the route registry as JSON. The MCP server caches this for 5 seconds — tight enough that code-change reloads are picked up almost immediately, loose enough that agents calling tools in tight loops aren't hammering the dev server.

`SHIP_API_DEV_URL` controls the target (default `http://localhost:3000`). Override per-environment if your dev server runs on a different port.

**The dev server has to be running** for any of the four tools to work. The MCP server doesn't spawn one — that's `ship-api dev`'s job.

## `list_routes`

Lists every registered route, with optional filtering. Cheap — used at the start of an agent task to map the surface area.

**Input:**

```ts
{
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "WS";
  path?: string;          // substring match, not glob
  module?: string;        // exact module name
  tag?: string;           // matches against route's tags array
  limit?: number;         // default 200
}
```

Filters AND-combine. Empty input returns everything (subject to `limit`).

**Output:**

```ts
{
  count: number;          // matches returned (after filters, before limit)
  truncated: boolean;     // true if matches > limit
  routes: Array<{
    method: string;
    path: string;
    module?: string;
    auth: { required: boolean; provider?: string };
    permissions: string[];
    schemas: { json?: boolean; query?: boolean; param?: boolean; header?: boolean };
    rateLimit?: { windowMs: number; max: number; scope?: string };
    idempotent?: boolean;
    deprecated?: boolean;
  }>;
}
```

Note: `schemas` is a *boolean per slot* — "does this route declare a JSON body schema?" — not the schema itself. Use `describe_route` for the full schema.

**Example agent invocation:**

> "What POST routes does the accounts module expose?"

Agent calls `list_routes({ method: "POST", module: "accounts" })`. Gets back:

```json
{
  "count": 1,
  "truncated": false,
  "routes": [{
    "method": "POST",
    "path": "/accounts",
    "module": "accounts",
    "auth": { "required": true, "provider": "firebase" },
    "permissions": ["accounts:create"],
    "schemas": { "json": true }
  }]
}
```

Agent now knows the route exists, requires auth, requires the `accounts:create` permission, and accepts a JSON body. Doesn't yet know the body shape — that's `describe_route`.

## `describe_route`

Full detail for one route, including the JSON Schema for each registered Zod schema.

**Input:**

```ts
{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "WS";
  path: string;           // exact match (e.g., "/accounts/:id")
}
```

**Output:** the full `RouteEntry`, or `null` if not found:

```ts
{
  method: string;
  path: string;
  module?: string;
  auth: { required: boolean; provider?: string };
  permissions: string[];
  rateLimit?: { windowMs; max; scope? };
  idempotent?: boolean;
  schemas: {
    json?: JsonSchema;    // converted via z.toJSONSchema()
    query?: JsonSchema;
    param?: JsonSchema;
    header?: JsonSchema;
  };
  description?: string;
  tags?: string[];
  deprecated?: boolean;
}
```

The `JsonSchema` values are real, fully-formed JSON Schema documents — agents can read them, suggest valid request bodies, and (most usefully) hand them to `execute_route` for pre-flight validation.

**Example:**

```json
{
  "method": "POST",
  "path": "/accounts",
  "module": "accounts",
  "auth": { "required": true, "provider": "firebase" },
  "permissions": ["accounts:create"],
  "schemas": {
    "json": {
      "type": "object",
      "properties": {
        "firebaseUid": { "type": "string", "minLength": 1, "maxLength": 128 },
        "email": { "type": "string", "format": "email", "maxLength": 320 },
        "emailVerified": { "type": "boolean" },
        "displayName": { "type": "string", "minLength": 1, "maxLength": 200 },
        "isActive": { "type": "boolean" },
        "roleId": { "type": "string", "format": "uuid" }
      },
      "required": ["email"],
      "additionalProperties": false
    }
  }
}
```

Agents reading this know exactly: `email` is required, the rest are optional, no extra properties allowed (`additionalProperties: false` because the route uses `.strict()`).

## `find_route_collisions`

Detects accidentally-shadowed routes. Two flavors:

- **Exact collision** — two registrations for the same `(method, path)`. Hono lets you do this; the second registration "wins" but the first stays in the registry, confusing introspection. Always a bug.
- **Path pattern overlap** — registered routes whose path patterns might catch overlapping requests. `GET /users/:id` and `GET /users/me` overlap because `:id` is a parameter that could match `me`. Sometimes intentional (the more-specific route wins because it's registered first), sometimes a bug.

**Input:**

```ts
{
  method: "GET" | ...;
  path: string;
  includePathPatternOverlap?: boolean;    // default false
}
```

**Output:**

```ts
{
  collisions: RouteEntry[];   // exact (method, path) matches
  overlaps: RouteEntry[];     // pattern-overlap matches (only when flag is true)
}
```

The pattern-overlap check is conservative: if either segment is a parameter (starts with `:` or `{`), it's considered to potentially overlap a literal segment. The result might include false positives (two routes that overlap in theory but where the more-specific one always wins in practice) — that's why the flag is opt-in.

## `execute_route` — the differentiator

This is the load-bearing tool. The framework exists in part to make this work cleanly: agents call routes through the real middleware chain, with pre-flight schema validation, getting actionable errors instead of opaque 500s.

**Input:**

```ts
{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  path: string;                              // e.g., "/accounts/123"
  headers?: Record<string, string>;          // e.g., { authorization: "Bearer ..." }
  body?: unknown;                            // validated pre-flight against route's JSON schema
  baseUrl?: string;                          // override SHIP_API_DEV_URL
}
```

**Output:**

```ts
{
  ok: boolean;
  reason: "not-found" | "schema-mismatch" | "network" | "executed";
  entry?: { method; path; auth; permissions; module };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    json?: unknown;                          // parsed if Content-Type is application/json
  };
  validationErrors?: Array<{                 // when reason === "schema-mismatch"
    path: string;                            // dot-notation, e.g., "address.zipCode"
    message: string;                         // "required property missing", etc.
  }>;
  durationMs?: number;
  error?: string;                            // when reason === "network"
}
```

### The pre-flight validation flow

1. Agent calls `execute_route({ method, path, body, ... })`.
2. MCP server looks up the route in the registry. If not found → `{ ok: false, reason: "not-found" }`. **No HTTP request is made.**
3. If the route declares a JSON body schema, validate the supplied `body` against it.
4. If validation fails → `{ ok: false, reason: "schema-mismatch", validationErrors: [...] }`. **No HTTP request is made.**
5. If validation succeeds (or the route has no schema), forward to `${baseUrl}${path}` with the supplied method, headers, and body.
6. Return the response: status, headers, body. Parse `body` as JSON if `Content-Type: application/json`.

Steps 2 and 4 are why this tool matters. Without them, an agent calling a non-existent route gets a 404 (network fetch, server response, parse the 404 body, decide what to do); an agent submitting a malformed body gets a 400 with whatever the framework's error handler returns. With them, the agent gets a structured "not found, here's what does exist" or "schema mismatch, here are the field-level errors" — actionable in one tool call.

### The JSON Schema validator

The MCP server includes a small inline JSON Schema validator (not Ajv). It covers the subset Zod 4's `toJSONSchema()` produces:

- **String** — `type`, `minLength`, `maxLength`, `pattern`, `format` (`uuid`, `email`)
- **Number** — `type`, `minimum`, `maximum`
- **Object** — `type`, `properties`, `required`, `additionalProperties` (specifically `false`)
- **Array** — `type`, `items`
- **Enum** — `enum` array
- **Composition** — `anyOf`, `oneOf`

Errors carry dot-notation paths (`"address.zipCode"`, `"items[0].name"`) and human-readable messages (`"required property missing"`, `"length below minimum"`).

The validator is intentionally narrow. Adding full Ajv would balloon the server's footprint and surface the long tail of JSON Schema features that Zod 4 doesn't emit. The narrow validator catches the 95% of agent mistakes (missing required fields, wrong types, invalid enums) without the bloat.

### Worked example: agent iterating against the API

```
agent: list_routes({ module: "posts" })
→ [{ method: "POST", path: "/posts", auth: { required: true }, permissions: ["posts:create"], schemas: { json: true } }, ...]

agent: describe_route({ method: "POST", path: "/posts" })
→ {
    schemas: {
      json: {
        type: "object",
        properties: { title: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 }, published: { type: "boolean" } },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
  }

agent: execute_route({ method: "POST", path: "/posts", body: { title: "Hello" }, headers: { authorization: "Bearer ..." } })
→ {
    ok: false,
    reason: "schema-mismatch",
    entry: { method: "POST", path: "/posts", auth: { required: true, provider: "firebase" }, permissions: ["posts:create"], module: "posts" },
    validationErrors: [{ path: "body", message: "required property missing" }],
  }

agent: (notes the missing field, retries)
agent: execute_route({ method: "POST", path: "/posts", body: { title: "Hello", body: "World", published: true }, headers: { ... } })
→ {
    ok: true,
    reason: "executed",
    response: { status: 201, json: { id: "...", title: "Hello", body: "World", published: true, createdAt: "...", ... } },
    durationMs: 47,
  }
```

Three tool calls — including one that surfaced a schema mismatch — and the agent has working code. Without the MCP server, the same flow takes a code edit, a manual run, a 400 response, a debug session.

### What `execute_route` doesn't do

- **It doesn't bypass auth.** Routes requiring `requireAuth` still require auth. The agent has to supply a valid `Authorization: Bearer ...` header (or whatever the route's `AuthProvider` consumes).
- **It doesn't bypass permissions.** A token without `posts:create` gets a 403 just like in production.
- **It doesn't bypass rate limits.** Iterate too aggressively and the rate limit fires. Test routes with rate limits set narrowly enough that one user can hit 5+ requests/sec.
- **It doesn't run in a sandbox.** Side effects happen — rows are created, jobs are enqueued, emails are sent (if your dev environment isn't isolated). For destructive operations, point the agent at a dedicated dev environment, not your local development setup with real connections to production-shaped services.

## Configuration

The server reads from environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHIP_API_DEV_URL` | `http://localhost:3000` | The running dev server's base URL. |
| `SHIP_API_REGISTRY_TTL_MS` | `5000` | How long to cache `/dev/routes.json` data. |

For most projects the defaults work. Override `SHIP_API_DEV_URL` if your dev server runs on a non-default port. Override the cache TTL if you're seeing stale-route issues during rapid iteration (drop to `1000`) or if you want fewer registry refreshes (raise to `30000`).

## Tests

The MCP server's test suite (`packages/mcp-server/src/server.test.ts`) covers all four tools end-to-end:

- Tool registration — `listTools()` returns four tools with non-empty descriptions.
- `list_routes` — unfiltered, plus filtered by method / module / tag.
- `describe_route` — matching route, null when not found.
- `find_route_collisions` — exact match, plus pattern overlap when flag is set.
- `execute_route` — success path, not-found, schema-mismatch (the load-bearing test).
- Input validation — rejects missing required args (e.g., `method` for `describe_route`).

Tests run against a `StaticRegistryClient` (deterministic in-memory route data) over `InMemoryTransport.createLinkedPair()` — no child processes, no network. The framework runs them as part of `npm test`.

## Operational concerns

**Stale registry data is a real risk.** The 5-second cache is a balance, but if an agent is iterating very fast on schema changes, it might hit a window where the dev server has reloaded but the MCP server's cache hasn't refreshed. Symptom: schema-mismatch on a body that should validate. Mitigation: lower `SHIP_API_REGISTRY_TTL_MS`, or wait a moment between schema-touching edits.

**Don't expose the dev server publicly.** The MCP server connects to it directly; if `/dev/routes.json` is reachable from the internet, your route registry (paths, auth requirements, permissions) is too. The dev routes are registered only when `NODE_ENV !== "production"`; verify this stays true on any deploy.

**Don't run the MCP server against production.** The whole point is iteration against a development environment. Pointing it at a production dev URL is undefined behavior — best case, you spam your prod logs; worst case, agents do `execute_route` calls with real side effects.

**MCP tool calls go through Claude Code's tool-use API.** They're billed like any other tool call. For long-iterating agents, they add up. The introspection tools (`list_routes`, `describe_route`) are cheap; `execute_route` is more expensive (network round-trip plus the actual route's work). Profile if the cost surprises you.

## Source

- [`packages/mcp-server/src/server.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/mcp-server/src/server.ts) — the server bootstrap and tool registration
- [`packages/mcp-server/src/tools/`](https://github.com/sixthsummit/ship-api/tree/main/packages/mcp-server/src/tools) — `listRoutes`, `describeRoute`, `findRouteCollisions`, `executeRoute`
- [`packages/mcp-server/src/server.test.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/mcp-server/src/server.test.ts) — the test suite
- [`packages/core/src/app/registry/routes.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/registry/routes.ts) — the registry the server queries
- [tooling/claude-plugin](claude-plugin.md) — the plugin that bundles this server via `.mcp.json`
- [concepts/routes-and-validation](../concepts/routes-and-validation.md) — the route registry mechanism the server reads from
