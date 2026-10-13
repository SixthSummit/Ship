# @sixthsummit/ship-api-mcp-server

## 0.1.2

### Patch Changes

- 8f71663: License the framework under Apache-2.0, include LICENSE and NOTICE in published packages, and update package documentation.

  Remove application-specific documentation and replace client-derived regression fixtures with synthetic framework examples.
- 8f71663: Require the patched MCP SDK while preserving the MCP server API. Consolidate framework tooling and dependency security checks in the Ship workspace.

## 0.1.1

### Patch Changes

- [#129](https://github.com/SixthSummit/ship-api/pull/129) [`da6920e`](https://github.com/SixthSummit/ship-api/commit/da6920efd6525ce6de43e94fb51d7adf2474d2c5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Move the `ship-api create` scaffold template's `@sixthsummit/ship-observability-otel`
  pin from `^0.1.0-alpha.0` to the published stable `^1.0.0`, and make the MCP
  server advertise its own `package.json` version to clients instead of a
  hard-coded `0.1.0-alpha.0` default.

## 0.1.0

### Patch Changes

- [#98](https://github.com/SixthSummit/ship-api/pull/98) [`302b06d`](https://github.com/SixthSummit/ship-api/commit/302b06d421570b75de3028e82aec473ca66ee487) Thanks [@selosindis](https://github.com/selosindis)! - Initial release. An MCP server exposing ShipAPI route-registry introspection to Claude Code, Cursor, and other LLM agents: `list_routes`, `describe_route`, `find_route_collisions`, and `execute_route` — which drives routes through the real middleware chain in a running dev server with pre-flight schema validation, surfacing schema errors as schema errors rather than opaque 500s. Localhost-guarded.

## 0.1.0-alpha.1

### Patch Changes

- [#98](https://github.com/SixthSummit/ship-api/pull/98) [`302b06d`](https://github.com/SixthSummit/ship-api/commit/302b06d421570b75de3028e82aec473ca66ee487) Thanks [@selosindis](https://github.com/selosindis)! - Initial release. An MCP server exposing ShipAPI route-registry introspection to Claude Code, Cursor, and other LLM agents: `list_routes`, `describe_route`, `find_route_collisions`, and `execute_route` — which drives routes through the real middleware chain in a running dev server with pre-flight schema validation, surfacing schema errors as schema errors rather than opaque 500s. Localhost-guarded.
