# ADR-0027: Declare the isolation level and a retry policy on the operation transaction

- **Status:** Accepted
- **Date:** 2026-11-08
- **Scope:** The `transaction` declaration, executor retry of transactional operations, the unit-of-work contract, the Drizzle adapter's transaction configuration and failure classification, graph and contract projection
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md) · [ADR-0003](./0003-operation-results-and-errors.md) · [ADR-0006](./0006-executable-transaction-scopes.md) · [ADR-0009](./0009-client-safe-contract-projections.md) · [ADR-0010](./0010-declared-immediate-effects.md) · [ADR-0014](./0014-actor-kinds-and-durable-outbox-delivery.md)

## Context

ADR-0006 made `transaction: "none" | "read" | "write"` an executable scope:
the executor opens the unit of work, the Drizzle adapter sets the access mode,
and declared failures roll back before they become results. Two things an
application still cannot say, so it falls back to hand-written
`db.transaction(...)` calls the compiler cannot see:

1. **Isolation.** The unit of work always opens at PostgreSQL's default
   `READ COMMITTED`. An operation whose guard and write must share one
   snapshot (a participant check followed by a cursor update, a reconcile of
   embedded objects followed by the row upsert) has no way to ask for
   `REPEATABLE READ` or `SERIALIZABLE`.
2. **Retry.** When a transaction aborts with a serialization failure (SQLSTATE
   `40001`) or a deadlock (`40P01`), the executor rolls back and reports a
   failure. Applications wrap the whole handler in their own retry loop.
   PostgreSQL documents that applications using `SERIALIZABLE` or
   `REPEATABLE READ` must be prepared to retry, so offering (1) without (2)
   would be a trap.

A handler-level loop cannot prove the replay is safe. The executor can: on a
transactional operation no immediate effect may run before commit (ADR-0010),
outbox intents, idempotency claims and cache-invalidation intents live inside
the transaction (ADR-0014, ADR-0019) and roll back with it, and the validated
input is the executor's to replay unchanged.

## Decision

### The declaration accepts an object; the string form is unchanged

```ts
transaction: "write";
transaction: {
  mode: "none" | "read" | "write",
  isolation?: "read committed" | "repeatable read" | "serializable", // default "read committed"
  retry?: { on: ReadonlyArray<"serialization" | "deadlock" | DeclaredErrorCode>, attempts: 1..5 },
};
```

`"write"` means `{ mode: "write" }`. `defineOperation` checks the shape only
(`SHIP_OPERATION_TRANSACTION_INVALID`) and freezes a copy; `transactionMode()`
and `transactionPolicy()` resolve either form so the rest of the kernel reads
`mode`, `isolation` and `retry` from one place. Value rules are compile
diagnostics so one `defineApp` reports every violation together:
`SHIP_OPERATION_TRANSACTION_ISOLATION_FORBIDDEN` and
`SHIP_OPERATION_TRANSACTION_RETRY_FORBIDDEN` (either on a `none` operation),
`SHIP_OPERATION_TRANSACTION_ISOLATION_INVALID` (unknown level) and
`SHIP_OPERATION_TRANSACTION_RETRY_INVALID` (attempts outside 1 to 5, an empty
or repeated `on`, an error code the operation does not declare).

### The unit of work takes the isolation level and classifies transient failures

`UnitOfWork.run(mode, work, { isolation? })` gains an options argument. The
Drizzle adapter folds `isolationLevel` into the single `SET TRANSACTION`
statement it already issues for the access mode, on the outermost scope only;
a nested `run` joins the open transaction and never changes its level. The
executor passes the level only when it differs from `read committed`, so an
operation that declares nothing opens exactly the transaction it opened before.

`UnitOfWork.classifyFailure?(error)` is a small optional contract:
`"serialization"` for SQLSTATE `40001`, `"deadlock"` for `40P01`, otherwise
`undefined`. The Drizzle adapter implements it by reading `code` anywhere in
the `cause` chain, because a `pg` error reaches the executor wrapped by Drizzle
and again by the kernel's handler-failure diagnostic. An adapter that cannot
classify leaves it out; the executor then retries declared error codes only.

### Retry lives in the executor and nowhere else

On a failure that crossed the transaction boundary the executor asks: is this
an `OperationFailure` whose code is listed in `retry.on`, or does the unit of
work classify it as a listed transient kind? If so, and attempts remain, and
the request is not cancelled, it waits a full-jitter backoff over an
exponential window (0 to 20 ms, 0 to 40 ms, ..., capped at 500 ms) and opens a
fresh unit of work for the same validated input. Anything else is final on the
attempt it happened: unlisted declared failures, unexpected handler errors,
output schema failures, cancellation. Effects run once, after the attempt
that commits, because every effect a transactional operation may declare is
recorded inside the transaction that rolled back.

Results of an operation with a retry policy carry `attempts`, the number of
transactions opened (`ship.operation.transaction.attempts` for telemetry).
Operations without a policy are unchanged in shape and behaviour.

### Projection keeps existing fingerprints

The compiled graph, the client contract (`transaction`) and OpenAPI
(`x-ship-transaction`) project the resolved `{ mode, isolation, retry? }` only
when it carries more than the defaults. A string declaration, or an object form
whose values are the defaults, projects as the mode string, so no existing
consumer's contract fingerprint changes; declaring a non-default policy changes
the fingerprint, which is intended because the behaviour the contract describes
changed.

## Consequences

- Isolation and retry are declared next to the transaction they govern and
  visible in the graph, the contract, OpenAPI and the CLI, instead of hidden in
  handler code.
- A consumer that needs `SERIALIZABLE` gets the retry PostgreSQL requires from
  the component that can prove it is safe, with a bounded attempt count.
- Retrying a declared error code is possible for conflicts the handler detects
  itself (a stale version, a lost claim), with the same once-only effect
  guarantee.
- The string form and every existing contract are untouched; adapters that
  implement `UnitOfWork` from before this decision keep working because both
  additions are optional.
- Jobs and inline webhook operations keep the string form for now; their
  declarations compile to operations and can adopt the object form in a later
  change without a kernel change.

## Rejected alternatives

### A handler-level `retry()` helper

Rejected because a handler cannot know whether an effect already ran, whether
the transaction fully rolled back, or whether its own partial state is safe to
replay; the executor knows all three.

### Always setting the isolation level explicitly

Rejected because it would change every existing transaction's statement and
override a server-side `default_transaction_isolation` a consumer may have set
deliberately. The level is sent only when the declaration asks for one that
differs from the default.

### Retrying every failure a fixed number of times

Rejected because most failures are deterministic and a replay would repeat
them while delaying the answer. Only the two SQLSTATEs PostgreSQL documents as
"retry the transaction" and codes the operation names are retried.

### Projecting the object form verbatim

Rejected because `{ mode: "write" }` and `"write"` describe the same behaviour;
projecting them differently would change fingerprints for a declaration
change that changed nothing.
