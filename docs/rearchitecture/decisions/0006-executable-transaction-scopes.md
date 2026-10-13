# ADR-0006: Make transaction declarations executable scopes

- **Status:** Accepted
- **Date:** 2026-09-03
- **Scope:** Operation execution, dependency resolution, PostgreSQL transactions, and nested work
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md) · [ADR-0003](./0003-operation-results-and-errors.md)

## Context

ShipAPI v4 records an active transaction in request context, but services created with the base database can continue writing through that connection. An operation may therefore appear transactional while domain, audit, or nested writes escape the rollback boundary.

The new operation declaration already includes `transaction: "none" | "read" | "write"`. Leaving that value as documentation and asking each handler to remember a transaction wrapper would preserve the same defect in a cleaner-looking API.

## Decision

Transaction mode controls operation execution:

1. A database module defines a `unitOfWorkDependency()` and binds it to one singleton unit-of-work controller.
2. Every `read` or `write` operation must depend on exactly one such token. A `none` operation cannot depend on one.
3. The executor completes access and input validation before opening a transaction.
4. The controller opens the declared read-only or read-write scope and constructs a frozen map of repositories/capabilities from the active Drizzle transaction.
5. Operation dependency resolution substitutes that scoped map for the controller. Handlers never receive the controller or base database.
6. Providers cannot depend on transaction-scoped tokens; scoped domain repositories are injected directly into the operation so their lifetime is visible.
7. Success commits. Declared failures, unexpected failures, output validation failures, provider failures, and cancellation cross the transaction boundary as failures and therefore roll back. Declared failures become typed result values only after rollback.

The compiled graph marks unit-of-work providers and dependencies. Invalid composition fails with stable diagnostics before server startup.

The Drizzle adapter sets PostgreSQL transactions to `read only` or `read write`. Nested calls on the same unit of work join the active scope by default and reuse the exact capability instances. A joined failure marks the entire transaction rollback-only even if outer work catches it. An adapter may choose `nested: "reject"`. A nested write can never join an active read-only scope.

Async context is used only inside the Drizzle adapter to recognize an already-active controller. It does not expose a database or transaction through ambient request context; all handler access remains an explicit typed dependency.

## Consequences

- `transaction` is an enforced execution policy rather than decorative graph metadata.
- Domain and audit repositories are constructed from the same transaction and roll back together.
- Joined work cannot be caught and converted into a partial outer commit; recovery requires a future explicit savepoint policy.
- Direct calls, Hono routes, tests, and future adapters receive identical transactional behavior through the executor.
- Access denials and invalid input do not consume a database transaction.
- Repository constructors can accept the Drizzle transaction while operation handlers see only domain methods.
- A consumer can still deliberately capture and misuse its base connection in custom code; the framework no longer supplies that escape path, and the database module should keep its base provider private.
- External network, queue, storage, and email effects remain outside database atomicity and require a later explicit effect decision.

## Rejected alternatives

### Ask every handler to call `unitOfWork.run()`

Rejected because the operation's transaction declaration could disagree with runtime behavior and omission would remain invisible until a failure path.

### Keep propagating a transaction through `RequestContext`

Rejected because preconstructed services can retain the base connection and silently ignore ambient transaction state.

### Inject the raw Drizzle transaction into handlers

Rejected because it spreads ORM details, arbitrary query access, and physical schema knowledge across application logic.

### Open a savepoint for every nested call

Rejected as the default because a nested operation is normally part of the caller's atomic action. Explicit savepoint semantics can be added later only with a concrete recovery use case.
