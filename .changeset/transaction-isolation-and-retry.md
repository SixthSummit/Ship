---
"@sixthsummit/ship-core": minor
"@sixthsummit/ship-drizzle": minor
"@sixthsummit/ship-contract": minor
"@sixthsummit/ship-cli": patch
---

Declare the isolation level and a retry policy on the operation transaction (ADR-0027).

`transaction` now also accepts `{ mode, isolation?, retry?: { on, attempts } }`; the string form stays valid and means the defaults. `isolation` is `"read committed"` (default), `"repeatable read"` or `"serializable"`, applied by the Drizzle unit of work to the outermost transaction only. `retry.on` lists `"serialization"` (SQLSTATE 40001), `"deadlock"` (40P01) or declared error codes of the operation, and `attempts` (1 to 5) bounds the total. On a listed failure the executor discards the aborted unit of work, waits a short jittered backoff and re-runs the handler with a fresh unit of work and the same validated input; nothing else is retried, effects run once after the committing attempt, and results carry `attempts`. Compile diagnostics `SHIP_OPERATION_TRANSACTION_ISOLATION_FORBIDDEN`, `SHIP_OPERATION_TRANSACTION_ISOLATION_INVALID`, `SHIP_OPERATION_TRANSACTION_RETRY_FORBIDDEN` and `SHIP_OPERATION_TRANSACTION_RETRY_INVALID` report misuse. `UnitOfWork.run` takes an optional `{ isolation }` and a unit of work may expose `classifyFailure`; `@sixthsummit/ship-drizzle` exports `classifyPostgresTransactionFailure`. Contracts and the graph project the resolved policy only when it differs from the defaults, so existing fingerprints are unchanged; the CLI graph output renders the policy.
