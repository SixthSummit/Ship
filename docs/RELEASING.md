# Releasing ShipAPI

The root [Ship release guide](../RELEASE_GUIDE.md) is authoritative for npmjs publication, selective CI, initial setup, alpha snapshots and stable versioning. Releases remain manually dispatched and disabled until launch.

## Published package set

| Package | Ownership |
| --- | --- |
| `@sixthsummit/ship-core` | Operation kernel, graph, execution, access, and capabilities |
| `@sixthsummit/ship-hono` | Hono HTTP and credential adapter |
| `@sixthsummit/ship-drizzle` | Drizzle unit of work and repository primitives |
| `@sixthsummit/ship-contract` | Browser-safe structural client and backend projectors |
| `@sixthsummit/ship-auth-firebase` | Optional Firebase Admin actor adapter |
| `@sixthsummit/ship-cache-redis` | Redis declared-read-cache backend |
| `@sixthsummit/ship-jobs-bullmq` | BullMQ jobs backend |
| `@sixthsummit/ship-realtime-socketio` | Socket.IO + Redis realtime gateway |
| `@sixthsummit/ship-webhooks` | Provider webhook verifiers |
| `@sixthsummit/ship-observability-otel` | Optional OpenTelemetry adapter |
| `@sixthsummit/ship-testing` | Development-only parity and PostgreSQL fixtures |
| `@sixthsummit/ship-cli` | Application graph, contract, and migration tools |
| `@sixthsummit/ship-api` | V4 compatibility distribution and legacy scaffold tooling |
| `@sixthsummit/ship-api-mcp-server` | Optional local development MCP server |
| `@sixthsummit/ship-api-claude-plugin` | Optional Claude Code integration |

The docs application is private and never published. Focused packages have
independent versions; the release evidence records their exact tested set.

## Verification and acceptance

Run `pnpm ci:api` for API source, coverage, integration, parity, edge, packed-artifact, reproducibility, consumer and runtime-audit checks. Run `pnpm ci:angular` when shared contract or transport behavior changes. Inspect `pnpm release:preview` before versioning; version and changelog edits use `pnpm version-packages` on a release branch.

Consumers must install exact published versions from npm in a clean environment and verify their own runtime, database, auth and rollout behavior. Local `pnpm candidate:pack -- --output /private/tmp/ship-candidate` provides archive identities for pre-publication rehearsal; it does not establish npm or production acceptance. V4 adoption requirements remain in [ADR-0012](./rearchitecture/decisions/0012-v4-replacement-and-release-boundary.md).
