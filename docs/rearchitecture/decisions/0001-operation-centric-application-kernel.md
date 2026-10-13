# ADR-0001: Adopt an operation-centric application kernel

- **Status:** Accepted
- **Date:** 2026-09-03
- **Scope:** Redesign direction and prototype acceptance criteria
- **Related RFC:** [Re-envision ShipAPI as an agent-native application kernel](../../AGENT_NATIVE_REARCHITECTURE_RFC.md)

## Context

ShipAPI already supports multiple client applications, so weaknesses in the framework are repeated across migrations, feature work, debugging, documentation, and upgrades.

The current v4 architecture contains useful runtime components but no single authoritative application model. Hono routes, registry metadata, client inference, module conventions, scaffolds, service behavior, documentation, skills, prompts, and MCP tools can describe the same application differently.

Several concrete failures follow from this separation:

- runtime routing and route tooling require explicit parity tests;
- transaction context does not ensure services use the active transaction;
- generic service results and relations are insufficiently typed;
- authorization and tenancy depend on conventions that non-HTTP execution can bypass;
- copied modules and templates have unclear upgrade ownership;
- documentation and agent instructions can claim behavior that source does not implement;
- one dependency audit gate combines published runtime, optional tooling, test dependencies, and the docs site.

Adding more instructions would improve navigation but would not remove these failure modes. Repairing each v4 abstraction independently would also commit client migrations to concepts that the redesign would later remove.

## Decision

ShipAPI will pursue an operation-centric application kernel as its redesign direction.

### Authoritative application model

An operation is the primary callable unit. It declares a stable ID, typed input and output schemas, errors, access policy, transaction mode, explicit dependencies, and its handler.

Modules explicitly provide operations and dependencies. An application explicitly composes modules and adapters. These declarations form one validated application graph without global registries, import-time mutation, decorators, or source rewriting.

### Derived transports and tooling

The Hono router, route inventory, collision checks, OpenAPI, client types, diagnostics, focused execution, and machine-readable graph are derived from the same application graph.

HTTP is an adapter. Tests and tools can execute an operation directly through the same kernel policy and dependency path. HTTP integration tests continue to prove request/response translation.

### Explicit correctness boundaries

- Database writes use transaction-scoped repositories and services created by a unit of work. Transactional code cannot reach the base write connection through those capabilities.
- Authorization is enforced at the operation boundary even when execution does not enter through HTTP.
- Tenant-scoped repositories require an explicit tenant capability; privileged bypass is separate and auditable.
- External effects and idempotency strategy are visible at the operation boundary. A database transaction is never represented as making an external effect atomic.
- Domain repositories replace a universal entity service as the primary persistence abstraction. Shared typed query helpers remain allowed.

### Agent-native feedback model

Repository correctness will be carried by conventional code structure, TypeScript, Biome, graph validation, structured diagnostics, and executable tests. Agent prompts, skills, editor rules, and MCP tools are optional adapters over these capabilities and cannot be their source of truth.

### Scope control

The replacement begins with the smallest kernel, Hono adapter, Drizzle unit of work, auth/policy seams, graph diagnostics, and packed-consumer proof. Existing jobs, queues, sockets, cache, tenancy, outbox, and other optional features are not automatically reimplemented.

Representative synthetic applications exercise the acceptance patterns. Application-specific schemas, policies, integrations, and accounting remain outside framework core.

This decision accepts the architecture direction. It does not decide the final package names, whether the release is v4 or v5, when existing clients migrate, or when current APIs are deprecated.

## Consequences

### Positive

- Runtime and tooling views can no longer drift when they derive from one graph.
- Missing access policy, route collisions, invalid dependencies, and unsafe execution boundaries can fail before runtime.
- Operations become locally understandable and directly testable.
- Client applications receive concrete types without depending on one deeply chained Hono router type.
- Migration completeness can be proven by mapping every legacy method/path to one operation ID or an approved removal.
- Agents and unfamiliar engineers can follow code, types, diagnostics, and examples without memorizing framework-specific prose.
- Optional integrations can be packaged, versioned, and audited independently.

### Negative

- The compiler and graph schema become critical framework surfaces that require compatibility and conformance testing.
- The redesign requires meaningful upfront investment before it reduces migration work.
- Existing clients will need an explicit migration path; this is not a drop-in v4 patch.
- The team must resist rebuilding speculative feature parity before representative applications require it.

### Risks

- The operation declaration could become an oversized configuration language. Fields require a demonstrated invariant or derived artifact before inclusion.
- Generated artifacts could become another source of truth. They must remain reproducible projections and must not be hand-edited.
- A framework-specific compiler could obscure ordinary TypeScript. Runtime behavior remains ordinary executable code, and diagnostics must identify concrete source locations.
- A single application could overfit the kernel. Domain behavior stays behind application-owned policies and repositories; framework acceptance uses synthetic fixtures.

## Alternatives considered

### Repair the current v4 abstractions

This would address immediate inconsistencies, but preserve multiple application descriptions, generic-service weaknesses, route-registry parity work, and prompt-heavy guidance. It is reasonable only if short-term compatibility is more valuable than a robust multi-client foundation.

### Keep the architecture and expand agent instructions

Rejected because instructions cannot enforce transaction usage, authorization, route completeness, type safety, dependency boundaries, or runtime/tooling parity.

### Use plain Hono independently in every client

This would remove framework ceremony but duplicate security, database, error, observability, testing, and migration decisions across clients. The client portfolio justifies a small shared kernel, provided it remains smaller than the applications using it.

### Generate conventional applications from templates

Templates improve initial structure but fork immediately and cannot enforce ongoing agreement between routes, policies, clients, tests, and tools. Templates may remain an onboarding mechanism, not the architecture.

## Validation

This decision is validated when framework conformance proves:

- `/me` with Firebase and full role/direct-permission behavior;
- typed CRUD with audit and soft delete;
- a query-heavy read;
- a nested transactional write with rollback injection;
- an authenticated multipart upload;
- an idempotent Stripe webhook;
- an exact binary download;
- packed-consumer build and preview execution using public package surfaces.

Failure of a pattern that requires bypassing the kernel triggers redesign rather than a consumer-specific escape hatch.

## Follow-up decisions

Separate ADRs are required for:

1. release/version boundary and current-client support policy;
2. operation result and error model;
3. external-effect declarations and idempotency contracts;
4. generated versus type-level client strategy;
5. module-boundary enforcement;
6. package and adapter decomposition;
7. graph artifact compatibility and versioning.
