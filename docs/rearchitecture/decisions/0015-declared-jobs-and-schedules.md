# ADR-0015: Declared jobs and schedules

- **Status:** Accepted
- **Date:** 2026-09-18
- **Scope:** Job declaration, schedules, system-actor execution, per-key single-runner concurrency, backpressure, dead-letter recovery, retention, HTTP trigger authentication, adapter contracts
- **Related:** [ADR-0004](./0004-credential-actor-and-access-boundary.md) · [ADR-0006](./0006-executable-transaction-scopes.md) · [ADR-0008](./0008-authorized-tenant-capabilities.md) · [ADR-0010](./0010-declared-immediate-effects.md) · ADR-0014 "Explicit actor kinds and durable outbox delivery"

## Context

Background work in the compatibility line is a BullMQ registry: `defineJob({ queue, name, handler })` registers a handler that a `JobsManager` runs with whatever the process happens to have. Nothing in the application graph says which jobs exist, what input they accept, whether two of them may run at once, how many times they retry, what they may enqueue, or who may start them over HTTP. Tenant access inside a job was ambient, and a job that touched the database and an external system in one handler could commit after the external call failed.

ADR-0014 introduced `system` actors with no implicit privilege and a durable outbox with at-least-once delivery, and left scheduling the cleanup "to the job runner". This decision defines that runner as a declared capability of the kernel with the same graph, compiler and executor as every operation.

## Decision

### Declaration

`defineJob({ id, input, trigger, concurrency, retry, idempotency?, transaction, effects?, dependencies, errors?, handler, retention? })` compiles into an ordinary operation: `access: systemAccess()`, input `{ payload }`, output `200`, the declared `errors`, and a transport of kind `job` whose JSON metadata carries the trigger, concurrency, retry and retention declarations. A declared failure raised with `operationFailure` (for example a refused tenant) is a final outcome of the run and is never retried; an undeclared throw is a handler failure that consumes a retry attempt. The compiled application graph gains a `jobs` projection alongside `operations`, `providers` and `outboxes`, and every job also appears as an operation node so `inspect`, `affected`, contracts and tooling need no second code path.

`trigger` is one of `{ kind: "schedule", cron, tz }`, `{ kind: "interval", everyMs }`, `{ kind: "enqueue" }` or `{ kind: "http", access }`. A schedule without an IANA time zone is rejected (`SHIP_JOB_SCHEDULE_TZ_REQUIRED`); a job without `retry.attempts` is rejected (`SHIP_JOB_RETRY_ATTEMPTS_REQUIRED`) because unbounded retries hide failures.

### System actors and tenant authorization

Every run executes through the executor as a `system` actor with no permissions. Tenant authorization is re-done inside the handler on every invocation through the application's own `TenantScopeAuthority` (ADR-0008); nothing about tenant access is serialized into the run. The initiating user, when there is one, belongs in `onBehalfOf` attribution, never in the actor. A human actor cannot start a job directly; `checkOperationAccess` refuses it with `requiredActorKind: "system"`.

### Claim before effect

A job with `transaction: "read"` or `"write"` cannot bind an immediate effect; the existing `SHIP_OPERATION_EFFECT_TRANSACTION_FORBIDDEN` diagnostic (ADR-0010) applies unchanged. Such a job records its intent through `outboxDependency(outbox)` in the same transaction as its business change, and the outbox dispatcher performs the effect afterwards. There is no `afterCommit` mode.

### Per-key single-runner concurrency

`concurrency: { mode: "single-runner" | "parallel", max?, key?, reason?, leaseMs? }`:

- `max` is the per-process in-flight cap for the job and defaults to 1.
- A single-runner takes a lease on `(jobId, key)` from the bound `LockProvider` before the handler runs and heartbeats it while the handler is in flight; a second runner on any process observes the framework failure `JOB_LOCK_HELD` (409) and the backend retries after a backoff step without consuming an attempt. Single-runner is **per key, never per queue**: two keys of one job run concurrently.
- A keyless single-runner must declare `reason`; it compiles with the retained warning `SHIP_JOB_SINGLE_RUNNER_UNKEYED` so a global lock is a visible, justified choice. A single-runner without a lock provider bound fails compilation (`SHIP_JOB_LOCK_PROVIDER_MISSING`).

### Fairness policy and limits

When `key` identifies a tenant, the in-memory backend claims waiting runs round-robin across keys and never runs two single-runner runs of one key concurrently. The BullMQ backend keeps BullMQ's FIFO order per job queue and serializes keys through the lock provider; a contending run is delayed with jitter rather than blocking a worker slot, which approximates round-robin without a per-key queue. Neither backend caps `parallel` keyed jobs per key beyond `max`; that limit is documented here rather than hidden, and a per-key cap for parallel jobs is future work that must add its own executable semantics.

### Backpressure

Every job declares `max`; a backend exposes `concurrencyBudget: { maxInFlight, maxQueueDepth }`. `enqueue` returns `{ accepted: false, rejected: "queue-full" }` once a job's waiting and delayed runs reach the configured depth, and adapters never buffer runs in process memory. Workers respect a process-wide `maxInFlight` in addition to each job's `max`.

### Job-to-job edges

A job or operation that starts another job binds `jobDependency(job)` and receives a typed enqueuer for that one job. The graph projects the edge (`enqueues` / `enqueuedBy`); a job that binds the raw backend token is rejected (`SHIP_JOB_BACKEND_BINDING_FORBIDDEN`) and a dependency on a job that is not composed is rejected (`SHIP_JOB_DEPENDENCY_MISSING`). Management, cleanup and trigger operations are the only operations that bind the raw backend.

### Dead-letter and recovery

After `retry.attempts` failed attempts a run is dead-lettered with its input, last error and the per-attempt history. `defineJobManagement()` generates `<prefix>.list-failed`, `<prefix>.retry`, `<prefix>.discard` and `<prefix>.health`, each gated by `ship.jobs:manage`, in the same style as `OUTBOX_MANAGE_PERMISSION`. `retry` re-runs a dead-lettered run once; a further failure dead-letters it again. `discard` removes it with a recorded reason.

### Retention

Completed and dead-lettered runs are retained per job (`retention: { completedMs, deadLetteredMs }`, default 7 and 30 days). `defineJobCleanup({ trigger, outboxes })` is a keyed single-runner job that deletes runs past retention and sweeps the named outboxes through the same backend contract `defineOutboxCleanup` uses, so one schedule covers both policies. `defineApp` gains `runtime: { workers: { mode, budget } }` and `startJobRuntime(app, { backend, mode })` binds a backend, reconciles schedules (replace, never duplicate) and starts workers according to the process mode; `api` processes only enqueue and observe.

### Delivery guarantee

Delivery is at-least-once with deduplication, never exactly-once. `enqueue` deduplicates by `dedupeKey` while a run is not terminal and scheduler ticks carry durable identities, so a tick is never run twice; a process that dies after a handler's external work but before completion is recorded re-runs the job after its lease expires. The crash points before commit, after commit but before dispatch, and after external success but before completion are each exercised with two Node processes against real Redis and PostgreSQL, and the duplicate delivery in the last case is asserted rather than documented away. Jobs that must not repeat their write declare `idempotency`; effect providers stay tolerant of repeated delivery.

### HTTP triggers

A `trigger: { kind: "http", access }` job is projected by `httpJobTrigger(job)` in `@sixthsummit/ship-hono` onto `POST /jobs/<id>` as an ordinary operation: the executor enforces `access` on the caller, validates the body against the job input, and the handler enqueues through the backend. Callers are resolved by the application's `ActorResolver`; `jobTriggerActorResolver` accepts scheduler-issued identity tokens (for example Google Cloud Scheduler OIDC, verified by the application) and, for compatibility, scoped bearer secrets compared in constant time, and produces system actors carrying only the permissions the scheduler was granted (`jobTriggerPermission(jobId)`). No per-job signing protocol is introduced. A declared http trigger with no projected trigger operation fails compilation (`SHIP_JOB_HTTP_TRIGGER_UNBOUND`).

### Contracts and adapters

The kernel owns `JobBackend`, `LockProvider`, `JobRun`, `JobHealth` and the runtime binding; it stays dependency-free and edge-safe. `@sixthsummit/ship-jobs-bullmq` is a separate Node-only package with the BullMQ backend, a Redis `SET NX PX` lock provider and OpenTelemetry metrics (`ship.job.queue.depth`, `ship.job.queue.oldest_waiting_age`, `ship.job.run.duration`, `ship.job.runs`, `ship.job.dead_letter.count`, `ship.job.lock.wait`, attributed by `ship.job.id` and `ship.job.key`). `@sixthsummit/ship-drizzle` adds `advisoryLockProvider(database)` over `pg_try_advisory_xact_lock`. `@sixthsummit/ship-testing` adds an in-memory backend and lock provider, `runJobOnce` and the `jobBackendConformance` suite that both backends pass.

## Consequences

- Background work is visible in the graph with the same diagnostics, access policy and executor as HTTP work; `ship-api check` and `inspect job` show it.
- Scheduled and enqueued work cannot inherit privileges: every run re-authorizes tenants, and human callers cannot invoke a job body directly.
- Single-runner semantics are stated per key with a justification rule instead of a queue-wide serialization that starves tenants.
- Backpressure is a return value, not an exception or a growing buffer.
- Duplicate delivery is a tested contract; the adapters document exactly which crash points repeat work.
- The compatibility `defineJob`/`JobsManager` remain untouched; a parity test proves one handler yields the same result through both paths.
- Scheduler ticks pass `{}` as the payload, so scheduled jobs declare an input schema that accepts an empty object.
- Framework operation ids (`jobs.cleanup`, `jobs.list-failed`, …) are namespaced by a `jobs` module the application composes; applications with different conventions pass a prefix.

## Rejected alternatives

### Single-runner per queue

Rejected because one slow tenant would block every other tenant's scheduled work; the lock is `(jobId, key)`.

### An implicit lock when no provider is bound

Rejected because a process-local lock silently breaks the moment a second worker starts; the compiler requires a bound `LockProvider`.

### Unbounded queues with in-memory buffering

Rejected because a buffer that grows without a return value is an outage waiting to be discovered; `queue-full` is a first-class result.

### A per-job signing protocol for HTTP triggers

Rejected because schedulers already issue verifiable identity tokens and applications already own an `ActorResolver`; a bespoke protocol would duplicate both.

### Exactly-once execution

Rejected for the same reason as ADR-0014: an external system cannot join the local transaction, so the honest contract is at-least-once with deduplication and idempotency.

## Addendum 2026-09-18: PostgreSQL job backend

The PostgreSQL backend provides durable jobs for applications that do not use
Redis. The in-memory backend cannot retain waiting or dead-lettered runs across
restart. This addendum records the second durable backend.

### What was built

- `createDrizzleJobBackend({ database, table?, stateTable?, lockProvider?,
  pollIntervalMs?, queueDepthLimit?, maxInFlight?, meterProvider?, onError?,
  clock? })` in `@sixthsummit/ship-drizzle` implements the full `JobBackend`
  contract over two tables an application includes in its migrations:
  `shipJobRunsTable()` (the run ledger: `waiting` → `active` → `completed` |
  `failed` | `discarded`, with input, key, dedupe key, attempts, per-attempt
  failure history, lease and fencing token) and `shipJobStateTable()` (the
  reconciled schedule and the last-run / last-success marks `health()`
  reports).
- Workers poll. A poll ticks due schedules, then claims runs per job with
  `SELECT … FOR UPDATE SKIP LOCKED` up to `min(concurrency.max − active,
  maxInFlight − inFlight)`; single-runner jobs claim one run per pass and skip
  keys this process already runs. A claimed run carries a lease
  (`concurrency.leaseMs`) that is heartbeated every third of the lease and a
  per-claim fencing token; completion, failure and rescheduling are recorded
  only `WHERE status = 'active' AND claim_token = $token`. A run whose lease
  lapsed is retaken by any process; the stale holder's later outcome is
  rejected and reported through `onError` as `SHIP_DRIZZLE_JOB_LEASE_STALE`.
  There is no LISTEN/NOTIFY; a local `enqueue` or `retry` wakes the loop early
  and `pollIntervalMs` (default 1 s) bounds the latency otherwise.
- `enqueue` deduplicates by `dedupeKey` through a partial unique index over
  non-terminal runs and returns `queue-full` once a job's waiting and delayed
  runs reach `queueDepthLimit`. Lock contention (`JOB_LOCK_HELD`) returns the
  run to waiting after one jittered backoff step without consuming an attempt;
  handler failures append to `history` and retry with the declared backoff;
  after `retry.attempts` (or a non-retryable outcome) the run is dead-lettered
  with its input and last error. `listFailed`, `retry` (one more attempt) and
  `discard` back the `ship.jobs:manage` operations; `cleanup` deletes
  completed and dead-lettered runs past each job's retention and the default
  for runs of jobs no longer declared.
- `schedule` upserts the state row and keeps `next_at` when the trigger is
  unchanged, so a restart replaces rather than duplicates; `startWorkers`
  clears the schedule of jobs whose trigger is no longer a schedule or
  interval. A tick locks due rows with `FOR UPDATE SKIP LOCKED`, inserts one
  run with the durable id `<jobId>/<occurrence ISO time>` (`ON CONFLICT DO
  NOTHING`) and advances `next_at` to the first occurrence after now, so a
  process that was down catches up with one run rather than a storm.
- `backend.lockProvider` defaults to `advisoryLockProvider(database)` so an
  application binds `lockProviderDependency()` to it and needs nothing but
  Postgres. Metrics are emitted through the framework meter under the same
  instrument and attribute names as the BullMQ adapter (`ship.job.*`,
  `ship.job.id`, `ship.job.key`), so dashboards do not depend on the backend.
- The `jobBackendConformance` suite passes against real PostgreSQL, and the
  package's integration lane proves with two spawned Node processes that one
  `(jobId, key)` run is never owned twice while other keys proceed
  concurrently, that scheduler ticks are never doubled, that an expired lease
  is retaken and the stale holder's completion rejected, and that a crash
  after the external effect but before completion re-delivers exactly once
  more (at-least-once, asserted).

### Fairness and limits

The PostgreSQL backend claims FIFO by `available_at` then `created_at` per
job and serializes keys through the lock provider, like the BullMQ backend; a
contended run is delayed with jitter rather than blocking a worker slot. It
does not implement the in-memory backend's per-key round-robin. Neither backend
caps `parallel` keyed jobs per key beyond `max`.

### Advisory-lock lease semantics

`advisoryLockProvider` enforces `leaseMs` locally: advisory locks never expire
on their own, so the provider rolls its transaction back when the local timer
fires. A process that is paused (not killed) past its lease can therefore
believe it still holds a lock the database has released, whereas the Redis
provider's `SET NX PX` key expires server-side. The run lease closes the
consequence for the job backend: a paused runner's completion is rejected by
the fencing token and reported as `SHIP_DRIZZLE_JOB_LEASE_STALE`, and the run is
re-executed by the process that retook it. Handlers that perform external
effects therefore remain at-least-once, as the accepted delivery guarantee
already states.

### Choosing a backend

Use `@sixthsummit/ship-jobs-bullmq` when Redis is already part of the
deployment: BullMQ workers are push-based, stalled runs are recovered by the
queue itself, and Redis keys expire server-side. Use
`createDrizzleJobBackend` when PostgreSQL is the only stateful dependency
(including applications that would otherwise provision Redis for jobs alone); accept poll latency bounded by `pollIntervalMs`, one
short transaction per claim and per outcome, and the advisory-lock lease note
above. Both pass the same conformance suite, so an application can move
between them by changing the two providers it binds.
## Addendum 2026-09-18: job backend refinements

The accepted text above is unchanged. The second consumer of declared jobs
found three gaps; this section records what changed.

### `retention: { completedMs: 0 }` means "collect on the next sweep"

The validator rejected `0` and forced a job that wants every completed run
swept to write `1`. `defineJob` now accepts non-negative integers:
`completedMs: 0` or `deadLetteredMs: 0` means the run is collected by the next
cleanup sweep, never "keep forever". Backends already compute a cutoff from
`now - retention`, so `0` needs no adapter change. `defineOutbox` keeps its own
positive-integer validator; it does not share this one.

### The runtime projects per-job liveness

`backend.health()` reports queue depth and the oldest waiting age across the
deployment, but nothing mapped a job's own "I completed a cycle" onto an HTTP
liveness surface, so the consumer hand-wrote a heartbeat hash and a
`/health/worker` route. `startJobRuntime` now observes every run this process
executes and exposes `runtime.liveness(now?)`: per job, `lastStartedAt`,
`lastCompletedAt`, `lastFailedAt`, `completed`, `failed` and `lagMs` — the
time since the last successful completion, measured from the runtime start when
nothing has completed yet. A failure is recorded but does not count as a
heartbeat. It is process-local by design: the worker that runs a job answers
for its liveness. `ship-hono` projects it with
`jobLivenessRoute({ runtime, staleAfterMs })`, which answers `200` with the
per-job entries and `503` (`cache-control: no-store`) once a gated job's lag
exceeds its bound.

### Job ids are namespaced by the owning module id

`SHIP_MODULE_OPERATION_ID_MISMATCH` already applied to jobs, because a job is
an operation, but the proof tripped on it twice: a job id and a
`defineJobManagement({ prefix })` that named the application rather than the
module. The rule is unchanged — every operation id, job id included, starts
with `<moduleId>.`, and the management `prefix` **is** an owning-module id —
and the diagnostic hint now says so for both cases.
