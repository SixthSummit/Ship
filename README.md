# Ship

Apache-2.0 frameworks for TypeScript APIs and Angular applications. ShipAPI and ShipAngular share this pnpm/Turborepo workspace while retaining separate packages and independent versions.

## Get started

Use Node 24.22.1 or newer in the Node 24 line (Node 22.23.4+ and Node 26.12.1+ are also supported) and the pinned pnpm 10.34.6.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm run ci
```

`pnpm build` runs the Turbo package graph, including both documentation sites. `pnpm run ci` checks both frameworks and builds current API artifacts for joint conformance. Browser conformance needs Chromium: `pnpm --filter ship-angular exec playwright install chromium`.

## What Ship offers

ShipAPI is an operation kernel: an operation declares its id, schemas, errors,
access, transaction mode, dependencies and transport once, and the compiled
graph projects direct execution, Hono routes, the browser-safe client contract,
OpenAPI, diagnostics and impact analysis from that one declaration. ShipAngular
consumes the contract through typed, signal-first operation clients.

Declared capabilities ship as focused packages, each with a feature page under
[`docs/v4/`](docs/v4/):

| Capability | Page |
| --- | --- |
| Jobs and schedules, durable outbox, idempotency | [ADR-0014](docs/rearchitecture/decisions/0014-actor-kinds-and-durable-outbox-delivery.md), [ADR-0015](docs/rearchitecture/decisions/0015-declared-jobs-and-schedules.md) |
| Realtime channels (Socket.IO + Redis) | [realtime](docs/v4/realtime.md) |
| Streaming responses (SSE) | [streaming](docs/v4/streaming.md) |
| Inbound webhooks with provider verifiers | [ADR-0018](docs/rearchitecture/decisions/0018-inbound-webhook-operations.md) |
| Declared read cache | [ADR-0019](docs/rearchitecture/decisions/0019-declared-read-cache.md) |
| Managed storage (disk, S3/R2, GCS) | [storage](docs/v4/features/storage.md) |
| Transactional mail | [mail](docs/v4/features/mail.md) |
| Operator console | [console](docs/v4/features/console.md) |
| First-party credential auth (MFA, cookie sessions) | [auth-credentials](docs/v4/features/auth-credentials.md) |
| Rich text fields | [rich-text](docs/v4/features/rich-text.md) |
| Schema safety (migration linter, gated release step) | [schema-safety](docs/v4/features/schema-safety.md) |
| Web Push | [guide](angular/docs/guides/WEB_PUSH.md) |
| OpenTelemetry observability | [observability](docs/v4/features/observability.md) |

## Packages and documentation

- [ShipAPI](API_README.md): operation kernel, HTTP transport, contracts, adapters, and the compatibility API distribution. Source: `packages/`, `modules/`, and `libraries/`.
- [ShipAngular](angular/README.md): signal-first Angular framework and typed operation clients. Source: `packages/angular/`.
- [Web Push](angular/docs/guides/WEB_PUSH.md): optional Angular PWA notifications and a Node VAPID sender.
- Documentation sites: `apps/docs/` (API) and `apps/angular-docs/` (Angular). Canonical content is in `docs/` and `angular/docs/`.
- [API architecture decisions](docs/rearchitecture/decisions/README.md), [monorepo decisions](docs/architecture/README.md), [changelogs](CHANGELOG.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [releases](RELEASE_GUIDE.md).

```sh
pnpm api:ci                       # API checks, builds, and unit tests
pnpm --filter ship-angular lint   # Angular lint and import checks
pnpm --filter @sixthsummit/ship-angular test
pnpm docs:dev                     # API documentation
pnpm --filter ship-angular docs:dev
pnpm test:joint                   # Fresh API artifacts consumed by Angular
```

Client applications, private deployment records, and customer-specific fixtures do not belong in this repository. Examples and fixtures must be synthetic and framework-focused.

## Release status

This public repository distributes independently versioned packages under `@sixthsummit` on npmjs. Pushes to `dev` and `main` prepare eligible releases automatically; publishing requires approval in the `npm` environment and is gated by `SHIP_PUBLISH_ENABLED`. CI selects API, Angular and docs checks from the complete change set and previews pending Changesets versions. Development and alpha snapshots use `dev`; stable releases use `main`. See the [release guide](RELEASE_GUIDE.md).

## License

[Apache License 2.0](LICENSE). Existing attribution is retained in [NOTICE](NOTICE) and package notices.
