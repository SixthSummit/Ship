# ADR-0008: Require authorized tenant capabilities

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** Tenant authorization, repository construction, privileged bypass, and audit evidence
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md) · [ADR-0004](./0004-credential-actor-and-access-boundary.md) · [ADR-0006](./0006-executable-transaction-scopes.md) · [ADR-0007](./0007-domain-repositories-and-named-projections.md)

## Context

Tenant isolation is not reliable when the current tenant is ambient request state, a repository constructor accepts a raw tenant ID, or bypass is a boolean. Those designs make ordinary and privileged access look alike, let non-HTTP execution omit middleware, and leave no dependable evidence when a cross-tenant path is used.

A globally callable scope constructor would also be decorative security: application code could mint proof for any path or body tenant ID without first checking the authenticated actor's membership.

## Decision

ShipAPI uses process-local, nominal tenant capabilities that cannot be fabricated from a structurally similar object.

1. `createTenantScopeAuthority()` defines the application-owned membership policy. Its asynchronous `authorize` callback receives the requested tenant, invocation ID, and validated `OperationActor`. Only an affirmative boolean result issues an immutable `TenantScope`; denial, dependency failure, and invalid results have distinct stable diagnostics.
2. `createTenantRepository()` captures the active Drizzle transaction and returns a transaction-scoped factory. `forTenant(scope)` constructs the domain repository only from an authentic scope. The unit-of-work capability map contains this factory, never the base connection.
3. `tenantPredicate()` pairs an authentic scope with a non-null PostgreSQL tenant column of the same TypeScript identifier type. Domain repositories still own their explicit query methods and predicates.
4. Privileged repository APIs are a separate type returned only by `withBypass()`. A scoped-only factory has no privileged method. A bypass must be issued by `createTenantBypassAuthority()` for an authenticated actor with a request ID and human-readable reason.
5. Bypass issuance and every privileged repository construction synchronously record immutable audit events. If the sink throws or returns a promise, access fails closed before the privileged repository is constructed.

Tenant scopes and bypasses are invocation capabilities, not tokens or wire values. They are not serialized, stored, accepted from clients, or reconstructed from shape.

## Consequences

- HTTP, jobs, tests, and direct execution use the same tenant authorization boundary.
- A route parameter alone is insufficient to open a tenant repository; an application policy must authorize the operation actor first.
- Normal and cross-tenant repository surfaces can expose different methods, so broad reads cannot leak into scoped types.
- Audit evidence names the authority, actor, request, reason, and repository for every privileged construction site.
- Domain repositories remain responsible for applying the tenant predicate to each relevant read and write. Their conformance tests must attempt cross-tenant IDs, not merely assert generated SQL text.
- Authorization lookup may be asynchronous, while bypass auditing is deliberately synchronous. An audit adapter may enqueue durable delivery, but it must acknowledge locally before access continues.

## Rejected alternatives

### Export a direct tenant-scope constructor

Rejected because any handler could turn untrusted tenant input into apparently trusted evidence without running a membership policy.

### Store the current tenant in ambient async-local state

Rejected because repository requirements disappear from signatures, background execution becomes inconsistent, and nested work can inherit the wrong tenant invisibly.

### Add an `isAdmin` or `bypassTenant` boolean

Rejected because booleans erase who authorized the bypass, why it exists, and which repositories used it.

### Automatically rewrite every Drizzle query

Rejected because implicit query mutation is difficult to inspect, cannot safely infer every join or write invariant, and would recreate a universal persistence abstraction. Explicit domain repositories plus adversarial PostgreSQL fixtures keep ownership visible.
