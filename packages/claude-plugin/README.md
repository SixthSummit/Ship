# @sixthsummit/ship-api-claude-plugin

Claude Code plugin for [ShipAPI](https://github.com/SixthSummit/Ship) v4.

## What's inside

**Agents** — invoke directly via `Agent` tool or as part of slash command flows:

| Agent            | When                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ship-reviewer`  | Review a diff against v4 conventions (auto-fires on `Edit`/`Write` to `modules/**/*.ts` via PostToolUse hook, or manual via `/ship:lint-conventions`)                                                   |
| `ship-architect` | Design a new module from a feature description — returns a plan, no code                                                                                                                                |
| `ship-codegen`   | Execute a module plan — generator scaffold + customization + tests + verify                                                                                                                             |
| `qa-brief`       | Generate a Sherpa-ready QA brief from a backend diff (plain-English flows the QA pastes into Sherpa's `/explore`). Manual via `/ship:sherpa-brief` or fired headless by the `sherpa-brief.yml` workflow |

**Slash commands**:

| Command                                  | What                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/ship:lint-conventions [--diff\|--all]` | Run ship-reviewer over the branch's changes                                                                                           |
| `/ship:new-module <description>`         | architect → codegen pipeline for a new module                                                                                         |
| `/ship:add-job <job-name> -m <module>`   | Scaffold a BullMQ job stub via `ship-api g job`                                                                                       |
| `/ship:add-cron <cron-name> -m <module>` | Scaffold a `defineCron({ schedule, handler })` file at `modules/<module>/cron/<cron-name>.cron.ts`                                    |
| `/ship:add-migration <migration-name>`   | Generate a Drizzle SQL migration via `npm run db:generate` (never hand-write — the PreToolUse hook blocks edits to migration files)   |
| `/ship:trace-request <request-id>`       | Filter local pino logs by `requestId`; surface chronological log + OTel trace pointers                                                |
| `/ship:sherpa-brief [--base <ref>]`      | Generate a Sherpa-ready QA brief from the current branch's diff — same brief the `sherpa-brief.yml` workflow emits, previewed locally |

**Skills** — auto-loaded when working in a ShipAPI repo:

| Skill                     | Loads when                                               |
| ------------------------- | -------------------------------------------------------- |
| `ship-api-conventions`    | Editing TS files in a ShipAPI repo                       |
| `ship-module-pattern`     | Designing or scaffolding a new module                    |
| `ship-drizzle-migrations` | Schema edits or any drizzle-kit / migration work         |
| `ship-bullmq-jobs`        | Defining or debugging background jobs + cron             |
| `ship-otel-debugging`     | Tracing requests, debugging latency, OTel / metrics work |

The skills cite `.cursor/rules/*.mdc` as their authoritative source — the canonical project guidelines. Edit there; SKILL.md files are condensed summaries.

**MCP server** — `@sixthsummit/ship-api-mcp-server` runs as a stdio MCP server that exposes the framework's route registry to the agent. Tools:

| Tool                                           | What                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_routes(filter?)`                         | Compact filterable route table (method / path / module / tag / limit).                                                                                                                                                                                                                                                                                              |
| `describe_route(method, path)`                 | Full RouteEntry including JSON Schema per input target — agents use this before generating client-side request code.                                                                                                                                                                                                                                                |
| `find_route_collisions(method, path)`          | Pre-flight scaffold check — returns the colliding entry or null.                                                                                                                                                                                                                                                                                                    |
| `execute_route(method, path, headers?, body?)` | **The load-bearing differentiator.** Drives the route through the running dev server. Pre-flight: validates the body against the route's schema (returns schema errors _as_ schema errors, not as opaque 500s). Returns the actual response with timing. Agents iterate against the real middleware chain instead of imagining responses from a static schema dump. |

The plugin's `.mcp.json` registers the server and points it at `http://localhost:3000` by default (override via `SHIP_API_DEV_URL`). Run `ship-api dev` to expose `/dev/routes.json`; the MCP tools resolve the route registry from that endpoint.

> **Loopback only by default.** `execute_route` refuses non-loopback `baseUrl` / `SHIP_API_DEV_URL` values (anything outside `localhost` / `127.0.0.0/8` / `::1` / `0.0.0.0`) and returns `reason: "remote-not-allowed"`. This guards against an LLM agent — or a stale developer config — redirecting the dev workflow at a production URL with locally cached prod auth headers. Set `SHIP_API_MCP_ALLOW_REMOTE=1` in the MCP server's env to opt in; every non-loopback call is logged to stderr.

**Hooks** — fire automatically on tool events:

| Event                      | What                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUse` (Edit/Write)  | **Blocks** edits to `src/db/migrations/*.sql` (drift from `drizzle-kit generate`); the agent gets a clear message redirecting to the schema source                         |
| `PostToolUse` (Edit/Write) | After touching `modules/**/*.ts` or `packages/core/src/**/*.ts`, surfaces a hint to invoke `ship-reviewer` before declaring done                                           |
| `Stop`                     | When the session touched ShipAPI source, reminds to run `type-check` + `lint` + `test` before commit. Idempotent per session — fires once per turn-pair, not on every Stop |

## Install

The plugin is published to npm (alpha):

```sh
npm install -D @sixthsummit/ship-api-claude-plugin
```

Manual install via Claude Code's plugin config:

```jsonc
// ~/.claude/settings.json or .claude/settings.local.json
{
  "plugins": ["@sixthsummit/ship-api-claude-plugin"],
}
```

## Activation

The plugin activates inside ShipAPI projects — Claude Code looks for the marker file `ship-api.config.ts` at the workspace root. Outside a ShipAPI repo the plugin's components stay dormant (no skill auto-load, no PostToolUse hook fires).

## Status

This is the **alpha** of the v4 plugin. Tracked work:

- [x] ship-reviewer / ship-architect / ship-codegen / qa-brief agents
- [x] Slash commands: `/ship:lint-conventions`, `/ship:new-module`, `/ship:add-job`, `/ship:add-cron`, `/ship:add-migration`, `/ship:trace-request`, `/ship:sherpa-brief`
- [x] Five skills: `ship-api-conventions`, `ship-module-pattern`, `ship-drizzle-migrations`, `ship-bullmq-jobs`, `ship-otel-debugging`
- [x] PreToolUse / PostToolUse / Stop hooks
- [x] CI lint script verifying skills are in sync with `.cursor/rules/` (`npm run check:skills` is part of `npm run ci`)
- [x] Bundled MCP server (`@sixthsummit/ship-api-mcp-server` registered via `.mcp.json` — list_routes / describe_route / find_route_collisions / execute_route tools)
- [x] `execute_route` MCP tool — drives a route through the running dev server with pre-flight schema validation

## Repo layout

This package lives at `packages/claude-plugin/` in the ShipAPI monorepo. See the root [README](../../README.md) for the full picture.
