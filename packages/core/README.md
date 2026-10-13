# @sixthsummit/ship-api

A TypeScript backend framework on **Hono + Drizzle + pluggable AuthProvider + BullMQ + OpenTelemetry**, designed to be edited by AI coding agents.

> This is the stable v4 route-first compatibility distribution. New operation-oriented applications use `@sixthsummit/ship-core` and its focused adapters. See [`CHANGELOG.md`](./CHANGELOG.md) for released versions.

## What ShipAPI is

A library + CLI for building production-grade TypeScript HTTP services. The defining bets:

- **Agent-debuggable runtime** — the bundled MCP server's `execute_route` tool runs an agent's request through the live middleware chain with pre-flight schema validation against the route registry. Schema errors come back as schema errors, not opaque 500s.
- **No-codegen typed client** — Drizzle table → `drizzle-zod` → `validate("json", schema)` → `c.req.valid("json")` → `hc<ShipApiClient>()` on the consumer. Schema changes propagate through TypeScript end-to-end. Web (Angular) and mobile (RN+Expo) consume the same `hc()` contract.
- **Production-scale plumbing in the box** — Redis sliding-window rate limit, Stripe-style idempotency, transactional outbox for queue-after-commit correctness, BullMQ jobs + cron via the same primitive, ES256 JWT cookie auth with key rotation, OpenTelemetry auto-instrumentation, `/livez` + `/readyz` with `HealthCheckRegistry`.

## Install

The framework publishes to **GitHub Packages**. Consumers need an `.npmrc` configured for the `@sixthsummit` scope:

```ini
# .npmrc (in your project root)
@sixthsummit:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then:

```sh
npx @sixthsummit/ship-api create my-app
cd my-app && npm install && npm run dev
```

## Public API surface

| Subpath                                      | What it exports                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sixthsummit/ship-api`                      | Default barrel: `createApp`, `defineEnv`, `requireAuth`, `requirePermission`, `validate`, `AppError` taxonomy, `DrizzleEntityService`, `defineJob`, `defineCron`, `OutboxEventEmitter`, schema/middleware primitives. |
| `@sixthsummit/ship-api/client`               | `hc<ShipApiClient>()` typed-client (web + mobile consume the same contract).                                                                                                                                          |
| `@sixthsummit/ship-api/observability/logger` | pino logger with request-id + trace correlation.                                                                                                                                                                      |
| `@sixthsummit/ship-api/observability/otel`   | OpenTelemetry SDK init (auto-instrumented).                                                                                                                                                                           |
| `@sixthsummit/ship-api/http/*`               | HTTP layer: middleware, streaming, WebSocket adapter, validate wrapper.                                                                                                                                               |

## CLI

The package ships a `ship-api` binary:

- `ship-api create <name>` — scaffold a v4 reference app from `templates/default/`.
- `ship-api dev` — start Docker Compose deps + `tsx watch` + `/livez` poll.
- `ship-api g {module|resource|service|schema|middleware|job|doctor}` — code generators.
- `ship-api migrate-orm <path> [--write]` — TypeORM → Drizzle codemod for consumers migrating up from v3.
- `ship-api add <module>` — installable feature modules.

## Documentation

- **Pitch + "what's not in v4.0"**: <https://github.com/SixthSummit/Ship/blob/main/docs/V4_LAUNCH.md>
- **Status tracker**: <https://github.com/SixthSummit/Ship/blob/main/docs/V4_STATUS.md>
- **Migrating from v3**: <https://github.com/SixthSummit/Ship/blob/main/docs/MIGRATION_V3_TO_V4.md>
- **Docs site**: <https://docs.shipapi.dev>
- **Repo**: <https://github.com/sixthsummit/ship-api>

## Companion packages

- [`@sixthsummit/ship-api-claude-plugin`](https://github.com/SixthSummit/Ship/tree/main/packages/claude-plugin) — Claude Code plugin: slash commands, agents, skills, hooks.
- [`@sixthsummit/ship-api-mcp-server`](https://github.com/SixthSummit/Ship/tree/main/packages/mcp-server) — MCP server exposing the route registry: `list_routes`, `describe_route`, `find_route_collisions`, `execute_route`.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
