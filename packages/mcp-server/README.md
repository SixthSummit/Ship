# @sixthsummit/ship-api-mcp-server

Stdio MCP server that exposes ShipAPI's runtime route registry to Claude Code, Cursor, and any other MCP-aware LLM agent. Pairs with the [Claude Code plugin](../claude-plugin/) — the plugin's `.mcp.json` registers this server automatically.

## What's inside

| Tool                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_routes(filter?)`                                            | Compact route table (method / path / module / tag / limit) for fast scanning. Routes registered without `validate` / `requireAuth` show up too — agents see exactly what's there, including unprotected endpoints (the `ship-reviewer` agent flags those as convention violations).                                                                                                              |
| `describe_route(method, path)`                                    | Full RouteEntry for a single route — auth requirement (with provider name), permission slugs, rate-limit policy, idempotency flag, deprecation flag, plus JSON Schema (`zod-to-json-schema`-derived) for each input target (`json` / `query` / `param` / `header`). Returns `null` when the route doesn't exist.                                                                                 |
| `find_route_collisions(method, path, includePathPatternOverlap?)` | Pre-flight scaffold check — returns `{ collisions: [...], overlaps: [...] }`. Empty arrays = safe to add.                                                                                                                                                                                                                                                                                        |
| `execute_route(method, path, headers?, body?)`                    | **The load-bearing differentiator.** Drives the route through the running dev server. Pre-flight: validates the body against the route's JSON Schema (returns `reason: "schema-mismatch"` with `validationErrors` when the body's wrong — schema errors come back as schema errors, not opaque 500s). Returns the actual response with timing. Agents iterate against the real middleware chain. |

## How it works

1. The server reads the route registry from `/dev/routes.json` on a running ShipAPI app (default `http://localhost:3000`, override via `SHIP_API_DEV_URL`).
2. Tools resolve the registry through a `RegistryClient` interface (`HttpRegistryClient` for live, `StaticRegistryClient` for tests).
3. The dev endpoint is exposed by the framework's `InitDevRoutes` bootstrapper at priority 85 — gated by `WORKER_MODE=local` (or equivalent dev-only flag), never exposed in production.

## Install + configure

The server is bundled into `@sixthsummit/ship-api-claude-plugin`. Installing the plugin gets you the MCP tools too. To use it directly in Claude Code without the plugin:

```jsonc
// ~/.claude/settings.json or .claude/settings.local.json
{
  "mcpServers": {
    "ship-api": {
      "command": "npx",
      "args": ["-y", "@sixthsummit/ship-api-mcp-server"],
      "env": { "SHIP_API_DEV_URL": "http://localhost:3000" },
    },
  },
}
```

> **Loopback only by default.** `execute_route` refuses non-loopback `baseUrl` / `SHIP_API_DEV_URL` values (anything outside `localhost` / `127.0.0.0/8` / `::1` / `0.0.0.0`) and returns `reason: "remote-not-allowed"`. Set `SHIP_API_MCP_ALLOW_REMOTE=1` in the env block above to opt in; every non-loopback call is logged to stderr. This is a dev-time MCP server, not a production driver — the guard defends the dev workflow from accidentally hitting prod with locally cached auth headers.

## Run + test

```sh
# From the repo root:
pnpm --filter @sixthsummit/ship-api-mcp-server test  # vitest
pnpm --filter @sixthsummit/ship-api-mcp-server build # tsc

# Run the binary directly (typically Claude Code spawns this; manual use is rare):
npx ship-api-mcp-server
```

## Architecture

```
┌────────────────────┐                 ┌─────────────────┐
│ Claude Code / IDE  │  stdio MCP      │  This server    │
│                    │ ───────────────▶│  (4 tools)      │
└────────────────────┘                 └────────┬────────┘
                                                │
                                       HTTP fetch
                                                ▼
                                ┌─────────────────────────┐
                                │ Running ShipAPI app     │
                                │   /dev/routes.json      │
                                │   /dev/* (execute path) │
                                └─────────────────────────┘
```

The server is stateless apart from a 5-second cache on the registry dump (so a code-change reload is picked up almost immediately without round-tripping per tool call). Tests construct a `StaticRegistryClient` with a pre-loaded dump.

## See also

- [`@sixthsummit/ship-api-claude-plugin`](../claude-plugin/) — the Claude Code plugin that bundles this server
- [v4 status](../../docs/V4_STATUS.md) — implementation status across the v4 modernization
- [AGENTS.md](../../AGENTS.md) — agent onboarding entry-point
