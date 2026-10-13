# ADR-0012: Make the replacement kernel the v4 GA target

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** Product version, compatibility support, package ownership, and consumer rollout
- **Related:** [ADR-0002](./0002-pnpm-first-defer-turborepo.md) · [ADR-0009](./0009-client-safe-contract-projections.md)

## Context

ShipAPI's existing v4 line has not reached GA. Direct consumers use alpha
releases, while older applications use v2, v3, vendored tarballs, or copied
framework source. Calling the replacement v5 would imply a stable v4 contract
that does not exist and would preserve the route-first composition model as the
foundation merely because it was numbered first.

The framework supplies minimal and customized packed consumers to verify the
operation, transport, transaction, and contract boundaries. Application data and
deployment responsibilities remain outside the framework.

## Decision

### Product and version boundary

The operation-centric replacement kernel is the ShipAPI v4 GA target. It does
not become v5 and it does not remain an experiment.

The focused packages are the target architecture:

- `@sixthsummit/ship-core` owns the infrastructure-independent kernel;
- `@sixthsummit/ship-hono` owns HTTP projection and credentials;
- `@sixthsummit/ship-drizzle` owns transaction and repository primitives;
- `@sixthsummit/ship-contract` owns the browser-safe contract and client;
- `@sixthsummit/ship-auth-firebase` and
  `@sixthsummit/ship-observability-otel` are optional provider adapters;
- `@sixthsummit/ship-testing` and `@sixthsummit/ship-cli` are development and
  tooling trust zones.

`@sixthsummit/ship-api` remains the v4 compatibility distribution. It may
re-export focused packages and retain the current alpha APIs, but new
applications and migrations target the focused packages. The compatibility
package does not define the new kernel by wrapping it in old base classes,
route registries, or copied framework modules.

The focused packages retain independent package versions. Changesets records
their compatibility ranges, and every consumer pins direct dependencies exactly
with a lockfile. The verified release manifest, not matching version strings,
defines one tested package set.

### Existing-client support

Current v4 alpha clients migrate incrementally. The Hono `hc<typeof app>` seam
and route-first APIs remain available through the v4 compatibility distribution
for the v4 stable line. They are not the target contract for new work.

Any later deprecation follows the published policy: announce it in a v4 minor,
ship at least one later v4 minor carrying it, and remove it no earlier than v5.
Security and user-facing correctness fixes remain allowed on compatibility
surfaces; new framework capabilities belong on the operation kernel unless a
consumer-blocking bridge is required.

V2, v3, vendored, and embedded-source applications are replatforming projects,
not drop-in package upgrades. Their route catalogs, behavior fixtures, physical
schemas, and operational gates are the migration contract. The kernel will not
grow TypeORM or Express compatibility layers solely to imitate their internals.

### Framework release boundary

The original application rollout details are omitted from the public record.
Framework candidates require repository verification and packed ShipAngular joint
conformance; application owners separately approve their migrations and traffic.
The current release mechanics are documented in `docs/RELEASING.md`.

### Ownership

ShipAPI maintainers own the public core, contract, CLI, package graph, release
manifest, and compatibility distribution. The same team owns correctness and
security of each framework-provided adapter it publishes.

Consumer teams own domain repositories, physical schemas, actor resolution,
business policy, provider semantics, and deployment. ShipAngular maintainers own
Angular DI, reactive state, SSR isolation, browser transport, and presentation
adaptation around the structural client.

Every release or migration manifest must replace these role owners with named
primary and backup people. This ADR assigns responsibility; it cannot invent the
organization's current staffing.

### Deliberate non-scope

Turborepo remains deferred. Current pnpm-filtered gates are deterministic and
the evidence does not show caching is required to make the architecture usable.
A later measured ADR may revisit it.

Jobs, caches, queues, streaming, and sockets that exist in the compatibility
package do not automatically move into the target core. Each becomes a focused
adapter only after a real consumer and executable conformance suite require it.

## Consequences

- The organization avoids an artificial v5 migration before v4 ever stabilizes.
- Existing v4 alpha clients keep a supported incremental path.
- The stable future contract is the operation graph and structural client, not
  a composed Hono type or the monolith's internal layout.
- Multiple focused versions require a release manifest and exact consumer pins;
  this is more explicit than assuming equal version numbers imply compatibility.
- Compatibility code lives longer through v4, but its ownership and removal
  rule are visible instead of being decided during a client emergency.

## Release acceptance

A candidate requires the repository verification gate, isolated dependency audits,
Changesets review, exact packed-package installation, and ShipAngular joint
contract proof. Maintainers own support and release duties; applications own
preview, rollout, and rollback evidence. Client-specific acceptance records are
kept outside the public framework repository.
