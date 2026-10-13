# ShipAPI v4 direction

> Historical planning/evidence record. Status, versions, branches, and test counts
> below describe the original checkpoint, not the current release. Current release
> instructions are in `docs/RELEASING.md`; package changelogs record shipped changes.

- **Architecture:** operation-centric application kernel
- **Decision:** accepted for v4 GA
- **Current state:** alpha; controlled client previews are next
- **Compatibility:** existing route-first v4 APIs remain supported through v4

## Why the direction changed

The original v4 alpha assembled useful Hono, Drizzle, auth, jobs, cache,
observability, and agent tooling, but its composition model had no single source
of application truth. Routes, middleware order, schemas, request context,
generic services, client types, route registries, generators, and copied modules
could drift independently.

Migration costs increase when framework plumbing is repeated across routes.
Transaction, identity, schema, and external-effect boundaries need explicit owners.

V4 now targets a smaller invariant:

```text
operation → compiled graph → executor and adapters
```

The operation graph owns identity, input/output/error contracts, access,
transactions, dependencies, effects, and transports. Hono, Drizzle, Firebase,
OpenTelemetry, OpenAPI, clients, CLI inspection, and migration checks are
focused adapters or projections.

## What this enables

- Test business operations without an HTTP server.
- Enforce authorization for direct and HTTP execution at the same boundary.
- Make transaction-scoped repositories impossible to replace accidentally with
  a base connection inside a protected handler.
- Expose external effects and reject false atomicity at graph compilation.
- Generate routes, client contracts, OpenAPI, and inventories from one graph.
- Give agents stable diagnostics and ordinary TypeScript conventions instead of
  relying on prompt or plugin compliance.
- Install only the runtime adapters an application actually uses.
- Account for a legacy migration by stable operation ID and exact method/path.

## What it does not claim

The framework does not infer domain models, sanitize arbitrary uploads, decide
money semantics, make third-party effects transactional, repair production data,
or remove the need for preview/canary/rollback evidence. It does not move application business policy into core. It does not treat jobs, caches, streams, or sockets as target
features until a real consumer and conformance suite require them.

## Adoption

Install exact released package versions, run framework and application contract
tests, and verify deployment and rollback independently. The framework supplies
synthetic consumer and conformance fixtures; application-specific migration plans
remain with their applications.

See [ADR 0012](rearchitecture/decisions/0012-v4-replacement-and-release-boundary.md)
and the [release guide](RELEASING.md).
