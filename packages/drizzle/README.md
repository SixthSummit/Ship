# `@sixthsummit/ship-drizzle`

Drizzle infrastructure for the Ship application kernel. The package owns
transaction execution, bounded repository primitives, named projections, and
tenant-scoped repository construction without coupling `@sixthsummit/ship-core`
to an ORM or database driver.

Applications pass an existing Drizzle database to `createDrizzleUnitOfWork()`
and expose only domain-specific repositories to operation handlers.

`createDrizzleOutbox()` and `createDrizzleIdempotencyStore()` implement the
kernel outbox and idempotency contracts on PostgreSQL. Include
`shipOutboxTable()` and `shipIdempotencyTable()` in your migrations; both join
the active unit-of-work transaction when the executor supplies its scope.
The outbox table carries two partial indexes the claim depends on
(`<table>_pending_idx` on `outbox_id, available_at, created_at` where
pending; `<table>_lease_idx` on `outbox_id, lease_expires_at` where claimed),
so a claim of `batchSize` rows reads about that many index entries whatever
the backlog; lease-expired rows are retaken before pending ones.

`shipWebhookEventsTable()` and `createDrizzleWebhookEventStore({ database,
table, outboxTable, idempotencyTable })` back enqueue-mode webhooks: `record`
and `link` join the executor's unit-of-work scope, and `cleanup` deletes
events past retention only when their outbox intent is no longer pending or
claimed, plus expired idempotency claims under the webhook's key prefix.

`advisoryLockProvider(database)` implements the kernel `LockProvider` for
single-runner jobs with `pg_try_advisory_xact_lock`, holding the transaction
until release or the local lease timer expires.

## PostgreSQL job backend

`createDrizzleJobBackend({ database, table?, stateTable?, lockProvider?,
pollIntervalMs?, queueDepthLimit?, maxInFlight?, meterProvider?, onError?,
clock? })` implements the kernel `JobBackend` (ADR-0015) for consumers whose
only stateful dependency is PostgreSQL. Include `shipJobRunsTable()` and
`shipJobStateTable()` in your migrations.

```ts
import { createDrizzleJobBackend, shipJobRunsTable, shipJobStateTable } from "@sixthsummit/ship-drizzle";

export const jobRuns = shipJobRunsTable();
export const jobState = shipJobStateTable();

const backend = createDrizzleJobBackend({ database, table: jobRuns, stateTable: jobState });
// bind both as singleton providers:
//   valueProvider(jobBackendDependency(), backend)
//   valueProvider(lockProviderDependency(), backend.lockProvider)
const runtime = await startJobRuntime(app, { backend, mode: "worker" });
process.on("SIGTERM", () => runtime.stop());
```

- Workers poll every `pollIntervalMs` (default 1 s; a local `enqueue` or
  `retry` wakes the loop at once) and claim due runs per job with
  `SELECT … FOR UPDATE SKIP LOCKED`, honoring each job's `concurrency.max` and
  the process-wide `maxInFlight`. Single-runner jobs claim one run per pass
  and skip keys this process already runs; cross-process exclusion is the
  executor's `(jobId, key)` lease from the bound `LockProvider`.
- A claimed run holds a lease of `concurrency.leaseMs`, heartbeated every
  third of it, and a per-claim fencing token. Completion, failure and
  rescheduling are recorded only while that token is current. A run whose
  process died is retaken by any worker once its lease lapses; delivery is
  at-least-once, and a crash between an external effect and completion repeats
  the effect (make handlers idempotent or declare `idempotency`).
- `enqueue` deduplicates by `dedupeKey` while a run is not terminal and returns
  `{ rejected: "queue-full" }` once a job holds `queueDepthLimit` waiting or
  delayed runs. Nothing is buffered in memory.
- `JOB_LOCK_HELD` returns a run to waiting after one jittered backoff step
  without consuming an attempt; handler failures append to `history`, retry
  with the declared backoff and dead-letter after `retry.attempts`.
  `listFailed`, `retry` (one more attempt) and `discard` back the
  `ship.jobs:manage` operations; `cleanup` applies each job's retention.
- `schedule` upserts one state row per job and keeps `next_at` when the trigger
  is unchanged, so a restart replaces rather than duplicates. Ticks lock due
  rows with `FOR UPDATE SKIP LOCKED`, insert one run with the durable id
  `<jobId>/<occurrence>` and advance to the first occurrence after now, so a
  process that was down catches up with one run, not a storm.
- Metrics (`ship.job.queue.depth`, `ship.job.queue.oldest_waiting_age`,
  `ship.job.run.duration`, `ship.job.runs`, `ship.job.dead_letter.count`,
  `ship.job.lock.wait`) use the same names and `ship.job.id` / `ship.job.key`
  attributes as `@sixthsummit/ship-jobs-bullmq`.
- Errors the worker loop absorbs (poll failures, heartbeat failures, and
  `SHIP_DRIZZLE_JOB_LEASE_STALE` when a stale holder's outcome is rejected) are
  passed to `onError`; nothing is thrown from the loop.

### Advisory-lock lease semantics

`advisoryLockProvider` (the default `backend.lockProvider`) enforces `leaseMs`
locally: PostgreSQL advisory locks never expire on their own, so the provider
rolls its transaction back when the local timer fires, which frees the lock
for another process. A process that is **paused, not killed** past its lease
(a stop-the-world GC pause, a suspended container, a laptop lid) can therefore
still believe it holds a lock the database has already released, whereas the
Redis provider's `SET NX PX` key expires server-side and `extend` reports the
loss.

For the job backend this window is closed by the run lease: the paused
runner's completion is rejected by the fencing token, reported as
`SHIP_DRIZZLE_JOB_LEASE_STALE`, and the run is re-executed by the process that
retook it. Any external effect the paused runner already performed is repeated,
exactly as after a crash. If a handler must not repeat its write, declare
`idempotency` on the job.
