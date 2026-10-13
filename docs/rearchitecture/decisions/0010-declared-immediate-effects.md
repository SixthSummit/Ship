# ADR-0010: Declare immediate external effects as direct capabilities

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** Operation declarations, dependency visibility, application graph, and transaction safety
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md) · [ADR-0006](./0006-executable-transaction-scopes.md) · [ADR-0014](./0014-actor-kinds-and-durable-outbox-delivery.md) supplies the framework-owned outbox primitives this decision leaves to composition

## Context

An ordinary dependency token cannot distinguish a pure service from a client
that sends email, publishes a message, uploads an object, or calls another
system. Hiding those calls in providers or lifecycle hooks makes retries,
rollback behavior, tests, and impact analysis unreliable.

Database transactions do not make network effects atomic. Allowing a handler
to send an immediate effect inside a declared transaction would let the
database roll back after the external system has already accepted the call.
Automatically delaying arbitrary calls until commit would require serializing
closures and inventing a workflow engine.

## Decision

The first effect seam is deliberately small:

1. Applications create external capabilities with
   `effectDependency(id, { delivery: "immediate" })`.
2. An operation using that token binds it directly in `dependencies` and names
   the same token in `effects`.
3. The application compiler rejects an effect dependency omitted from
   `effects`, a declared effect with no direct dependency, duplicate effect
   declarations, and effect dependencies hidden behind another provider.
4. Immediate effects are rejected on `read` and `write` transactional
   operations. They run only in operations with `transaction: "none"`.
5. The graph projects effect ID, delivery, dependency name, and selected
   provider so inspection and impact analysis can see the behavior.
6. The application selects the concrete adapter by binding the effect token to
   a provider. Tests bind a deterministic fake to the same token.

Transactional outbox delivery is composition, not a kernel magic mode. A
transactional operation writes an outbox command through its unit-of-work
capability. A separate non-transactional dispatch operation declares and calls
the immediate provider effect. The application owns payload, retry,
idempotency, lease, and reconciliation policy.

## Consequences

- External behavior is visible in the operation graph and replaceable in tests.
- A provider cannot conceal an external client from operation-level impact
  analysis.
- The compiler prevents the most dangerous false-atomicity shape instead of
  merely documenting it.
- The kernel does not prescribe email, queue, storage, webhook, or SDK types.
- Code can still bypass the capability model through globals such as `fetch`.
  Repository architecture checks should prohibit that in domain operations;
  no runtime framework can prove the absence of arbitrary JavaScript effects.
- A later delivery mode requires its own executable semantics and evidence. It
  must not be added as metadata alone.

## Rejected alternatives

### Treat every service dependency as a possible effect

Rejected because the graph could not distinguish pure computation or reads
from externally observable calls.

### Let providers depend on effect clients

Rejected because an apparently pure operation could then trigger an effect
transitively without declaring it.

### Permit immediate effects inside transactions with a warning

Rejected because warnings do not prevent a remote success followed by a local
rollback.

### Add generic `afterCommit()` callbacks

Rejected because callbacks disappear on process failure and provide no durable
delivery, retry, or reconciliation contract. Applications needing that
guarantee should use an outbox and an explicit dispatcher.
