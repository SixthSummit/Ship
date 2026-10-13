# `@sixthsummit/ship-core`

The dependency-free Ship application kernel. It defines operations, modules,
providers, application compilation, execution, access policy, transaction
capabilities, and tenant capabilities without importing an HTTP framework,
database driver, auth provider, logger, or telemetry SDK.

Use adapter packages to project this graph onto a transport or infrastructure.

External clients use `effectDependency(id, { delivery: "immediate" })` and must
be declared directly by each operation that calls them. Immediate effects
cannot run inside a database transaction; persist an outbox command in the
transaction and dispatch it from a separate operation when durable delivery is
required.

Actors carry an explicit `kind` (`human`, `system`, `provider`); `systemAccess()`
and `providerAccess(id)` restrict operations by kind without granting any
implicit privilege.

Durable delivery is composed from `defineOutbox`, `outboxDependency` (bound in a
`transaction: "write"` operation), `defineOutboxDispatcher` and
`defineOutboxCleanup`, backed by an `OutboxBackend` adapter. Delivery is
at-least-once with deduplication. `startOutboxDispatchRunner(executor,
"<outbox>.dispatch", { intervalMs?, maxPassesPerCycle? })` runs a dispatcher
in a process: a full batch is followed by the next pass at once, a short or
empty batch waits the interval, and `stop()` returns after the in-flight
pass. An outbox may declare `expectedRatePerSecond` and its dispatcher
`roundsPerSecond`; the compiler then warns
`SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE` when `batchSize x
roundsPerSecond` is below the rate. Operations may declare `idempotency` backed by
an `IdempotencyStore`; duplicates replay the stored result and in-flight keys
fail with `IDEMPOTENT_IN_FLIGHT`.

Inbound webhooks are declared with `defineWebhook`: a bounded raw-body POST
operation with `providerAccess`, a pure `WebhookVerifier` bound through
`webhookVerifierToken` with a rotatable `WebhookSecretSource`, executor
idempotency with an `inFlight` policy, and an inline `handler` or
`receive: { mode: "enqueue" }` that persists the event and an outbox intent
together. `response: { mode: "json" | "text" | "binary" | "empty" }` declares
the acknowledgement the provider receives (TwiML as `text/xml`, a bodiless
status `200`) with failures always in the JSON envelope. `webhookIntent`,
`defineWebhookReplay` (optionally mounted with `transport: { path }`) and
`defineWebhookCleanup` complete the receive-then-process path; the verifier
helpers use WebCrypto only.

Background work is declared with `defineJob` (schedule, interval, enqueue or
http trigger; per-key single-runner or parallel concurrency; bounded retry;
retention, where `0` means "collect on the next cleanup sweep"; declared
`errors` that end a run without a retry) and compiles into a system-access
operation in the same graph. Job ids are namespaced by the owning module id
like every operation id, and `defineJobManagement({ prefix })` takes that
module id as its prefix.
`jobDependency(job)` gives an operation a typed enqueuer, `defineJobManagement`
generates the `ship.jobs:manage` dead-letter operations, `defineJobCleanup`
sweeps runs and outboxes on one schedule, and `startJobRuntime` binds a
`JobBackend` adapter and a `LockProvider`. Delivery is at-least-once. The
returned runtime exposes `liveness()` — per job, the last start, completion and
failure this process observed and the lag since the last success — for a
worker health surface (`jobLivenessRoute` in `@sixthsummit/ship-hono`).

Read caching is a declaration on the operation: `cache: { ttlMs, scope, vary?,
tags?, tenant? }` with framework-derived keys, and `invalidates` on writes
records durable purge intents. `scope` names the key, not HTTP cacheability —
`Cache-Control` projects `public` only for `publicAccess()` reads. Plain tags
purge every entry; `{ tag, scope: "actor" }` and
`{ tag, scope: "tenant", tenant }` purge only the writing subject's entries.
`defineCacheInvalidationModule({ cache, outbox, backend? })` is mounted once
and may own the `cacheBackendDependency` binding for every module that imports
`ship-cache`.

## Framework permissions

Some generated operations are gated by permission slugs the framework owns.
Grant them in your authorization model when you mount the module that
introduces them; `ship-api inspect app` lists them per module.

| Slug                   | Introduced by                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `ship.outbox:manage`   | any `defineOutboxDispatcher({ deadLetter: true })`, so also `defineCacheInvalidationModule` and `defineRealtimePublicationModule` |
| `ship.jobs:manage`     | `defineJobManagement`                                                                               |
| `ship.webhooks:replay` | `defineWebhookReplay`                                                                               |

Declared caching introduces no slug of its own.
