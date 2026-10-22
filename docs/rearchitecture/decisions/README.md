# ShipAPI architecture decision records

Public documentation retains framework decisions and omits private application
identities, deployment records, and client-specific acceptance evidence.

Architecture decision records capture consequential decisions for the ShipAPI redesign, including the context, decision, consequences, and rejected alternatives.

## Process

1. Copy the structure of the most recent ADR into the next zero-padded number.
2. Use one of these statuses: `Proposed`, `Accepted`, `Rejected`, `Superseded`, or `Deprecated`.
3. Link the ADR from the index below and record the addition in the rearchitecture changelog.
4. Do not rewrite an accepted decision to hide a later change. Add a new ADR that supersedes it.
5. Use ADRs for decisions with meaningful architectural consequences. Ordinary implementation details belong in code, tests, or pull requests.

## Index

| ADR | Status | Decision |
|---|---|---|
| [0001](./0001-operation-centric-application-kernel.md) | Accepted | Adopt an operation-centric application kernel as the redesign direction |
| [0002](./0002-pnpm-first-defer-turborepo.md) | Accepted | Adopt pnpm for workspace correctness; add Turborepo only from measured need |
| [0003](./0003-operation-results-and-errors.md) | Accepted | Use status-indexed success schemas and declared error codes |
| [0004](./0004-credential-actor-and-access-boundary.md) | Accepted | Separate transport credentials, actor resolution, and operation access |
| [0005](./0005-http-wire-and-representation-contract.md) | Accepted | Project one stable HTTP wire and representation contract |
| [0006](./0006-executable-transaction-scopes.md) | Accepted | Make transaction declarations executable scopes |
| [0007](./0007-domain-repositories-and-named-projections.md) | Accepted | Keep domain repositories explicit and dynamic reads named |
| [0008](./0008-authorized-tenant-capabilities.md) | Accepted | Require authorized tenant scopes and audited privileged bypasses |
| [0009](./0009-client-safe-contract-projections.md) | Accepted | Project a client-safe manifest, OpenAPI document, and structural operation client |
| [0010](./0010-declared-immediate-effects.md) | Accepted | Declare immediate external effects directly and keep them outside transactions |
| [0011](./0011-explicit-bounded-request-bodies.md) | Accepted | Declare bounded JSON, raw, and multipart request bodies per operation |
| [0012](./0012-v4-replacement-and-release-boundary.md) | Accepted | Make the replacement kernel the v4 GA target and retain an incremental compatibility line |
| [0013](./0013-primitive-form-projection-and-joint-fixture.md) | Accepted | Generate explicit primitive form bindings and verify retained real joint artifacts |
| [0014](./0014-actor-kinds-and-durable-outbox-delivery.md) | Accepted | Declare explicit actor kinds and compose durable outbox delivery, idempotency and retention from framework primitives |
| [0015](./0015-declared-jobs-and-schedules.md) | Accepted | Declare jobs and schedules as system-actor operations with per-key single-runner leases, backpressure, dead-letter recovery, retention and authenticated HTTP triggers |
| [0016](./0016-streaming-response-representation.md) | Accepted | Declare streaming responses as validated frames over SSE with adapter-owned limits and a client stream handle |
| [0017](./0017-declared-realtime-publication.md) | Accepted | Declare realtime publication as kernel channels with a transport-neutral backend contract and a Socket.IO + Redis gateway adapter |
| [0018](./0018-inbound-webhook-operations.md) | Accepted | Declare inbound webhooks as bounded raw-body operations with a pure verifier contract, provider actors after verification, executor idempotency, durable receipt, replay and retention; provider protocols live in an optional adapter package |
| [0019](./0019-declared-read-cache.md) | Accepted | Declare read caching per operation with framework-owned, actor- and tenant-scoped keys and durable tag invalidation |
| [0020](./0020-current-architecture-agent-tooling.md) | Proposed | Replace compatibility MCP and Claude tooling with operation-oriented inspection and evidence-driven workflows |
| [0021](./0021-schema-safety-gates.md) | Accepted | Enforce the production column rules with a migration linter, make migrations a gated release step that refuses to run at boot, and fail CI on physical schema drift |
