# @sixthsummit/ship-api-claude-plugin

## 0.1.2

### Patch Changes

- 8f71663: License the framework under Apache-2.0, include LICENSE and NOTICE in published packages, and update package documentation.

  Remove application-specific documentation and replace client-derived regression fixtures with synthetic framework examples.

## 0.1.1

### Patch Changes

- [#174](https://github.com/SixthSummit/ship-api/pull/174) [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Log why a readiness check that returned a failure failed. A check that returns `{ ok: false, error: "..." }` (the documented shape) used to leave no cause in either the `/readyz` body or the log. The warn-level `Readiness check failed` line now includes that string as `reason`, truncated to 200 characters. The string is written by the app author, so it must not contain secrets. Thrown errors are still logged by `errorCode` / `errorName` / `syscall` only, never the message. The `/readyz` body stays generic. `HealthCheckFailure` gains an optional `reason` field for `runAll({ onCheckFailure })` callers.

  The pool's idle-connection error log now uses the same field names as the readiness log (`errorCode`, `errorName`, `syscall`) instead of `code` / `errorName`.

## 0.1.0

### Patch Changes

- [#98](https://github.com/SixthSummit/ship-api/pull/98) [`302b06d`](https://github.com/SixthSummit/ship-api/commit/302b06d421570b75de3028e82aec473ca66ee487) Thanks [@selosindis](https://github.com/selosindis)! - Initial release. A Claude Code plugin for ShipAPI v4: four agents (`ship-architect`, `ship-codegen`, `ship-reviewer`, `qa-brief`), slash commands (`/ship:new-module`, `/ship:lint-conventions`, `/ship:add-job`, and more), five skills auto-synced from `.cursor/rules/`, three hooks (migration-edit block, post-edit review hint, and a commit reminder), and the bundled MCP server.

- [#104](https://github.com/SixthSummit/ship-api/pull/104) [`82d46ab`](https://github.com/SixthSummit/ship-api/commit/82d46ab498e9adeb83e6d23b261608ec36c73f5e) Thanks [@selosindis](https://github.com/selosindis)! - Fix the typed-client contract: route definers are now generic over Hono's schema parameter (`defineXxxRoutes<S extends Schema>(app: Hono<AppEnv, S>, deps)`), so chaining multiple modules accumulates route types instead of each module wiping out the previous one's. The non-generic `app: Hono<AppEnv>` signature widened an already-chained app — `hc<ShipApiClient>()` consumers got a client that typed zero routes.

  Also fixed everywhere the broken shape was taught or scaffolded: the template `index.ts` now captures the chained return and exports `ShipApiClient` from the end of the chain, the `g module` generator emits the schema-generic signature, and docs/rules/skills show the correct pattern. A tsc-enforced type assertion (`modules/typed-client.typecheck.ts`) now fails `type-check` if any definer signature regresses.

  If you scaffolded an app or generated modules from an earlier alpha: change your route definers to the schema-generic signature, capture each `defineXxxRoutes(...)` return, chain modules off the previous return, and point `export type ShipApiClient` at the final capture.

- Updated dependencies [[`302b06d`](https://github.com/SixthSummit/ship-api/commit/302b06d421570b75de3028e82aec473ca66ee487)]:
  - @sixthsummit/ship-api-mcp-server@0.1.0

## 0.1.0-alpha.2

### Patch Changes

- [#104](https://github.com/SixthSummit/ship-api/pull/104) [`82d46ab`](https://github.com/SixthSummit/ship-api/commit/82d46ab498e9adeb83e6d23b261608ec36c73f5e) Thanks [@selosindis](https://github.com/selosindis)! - Fix the typed-client contract: route definers are now generic over Hono's schema parameter (`defineXxxRoutes<S extends Schema>(app: Hono<AppEnv, S>, deps)`), so chaining multiple modules accumulates route types instead of each module wiping out the previous one's. The non-generic `app: Hono<AppEnv>` signature widened an already-chained app — `hc<ShipApiClient>()` consumers got a client that typed zero routes.

  Also fixed everywhere the broken shape was taught or scaffolded: the template `index.ts` now captures the chained return and exports `ShipApiClient` from the end of the chain, the `g module` generator emits the schema-generic signature, and docs/rules/skills show the correct pattern. A tsc-enforced type assertion (`modules/typed-client.typecheck.ts`) now fails `type-check` if any definer signature regresses.

  If you scaffolded an app or generated modules from an earlier alpha: change your route definers to the schema-generic signature, capture each `defineXxxRoutes(...)` return, chain modules off the previous return, and point `export type ShipApiClient` at the final capture.

## 0.1.0-alpha.1

### Patch Changes

- [#98](https://github.com/SixthSummit/ship-api/pull/98) [`302b06d`](https://github.com/SixthSummit/ship-api/commit/302b06d421570b75de3028e82aec473ca66ee487) Thanks [@selosindis](https://github.com/selosindis)! - Initial release. A Claude Code plugin for ShipAPI v4: four agents (`ship-architect`, `ship-codegen`, `ship-reviewer`, `qa-brief`), slash commands (`/ship:new-module`, `/ship:lint-conventions`, `/ship:add-job`, and more), five skills auto-synced from `.cursor/rules/`, three hooks (migration-edit block, post-edit review hint, and a commit reminder), and the bundled MCP server.

- Updated dependencies [[`302b06d`](https://github.com/SixthSummit/ship-api/commit/302b06d421570b75de3028e82aec473ca66ee487)]:
  - @sixthsummit/ship-api-mcp-server@0.1.0-alpha.1
