# `@sixthsummit/ship-jobs-bullmq`

BullMQ implementation of the Ship kernel `JobBackend` plus a Redis
`LockProvider` and OpenTelemetry metrics. The kernel owns the declaration
(`defineJob`), the compiler diagnostics and the executor; this package only
decides when and where the executor runs a job. It is Node-only and is never
imported by the edge-safe kernel or transport packages.

```ts
import { defineApp, jobBackendDependency, lockProviderDependency, startJobRuntime, valueProvider } from "@sixthsummit/ship-core";
import { createBullmqJobBackend, createRedisLockProvider } from "@sixthsummit/ship-jobs-bullmq";
import IORedis from "ioredis";

const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const backend = createBullmqJobBackend({ connection: redis, maxQueueDepth: 5_000, maxInFlight: 8 });
const lock = createRedisLockProvider({ client: redis });

// bind both as singleton providers, then:
const runtime = await startJobRuntime(app, { backend, mode: "worker" });
process.on("SIGTERM", () => runtime.stop());
```

- One BullMQ queue and worker per job id; worker concurrency is the job's
  `concurrency.max`, and `maxInFlight` caps the whole process.
- `schedule` upserts a BullMQ job scheduler per job, so restarting a worker
  replaces the schedule instead of duplicating it; scheduler ticks carry
  durable ids and never run twice.
- `enqueue` returns `{ rejected: "queue-full" }` once a queue holds
  `maxQueueDepth` waiting or delayed runs. Nothing is buffered in memory.
- Failed attempts are recorded on the job (`history`), retried with the
  declared backoff, and dead-lettered after `retry.attempts`. `listFailed`,
  `retry` and `discard` back the `ship.jobs:manage` operations.
- `cleanup` removes completed and failed runs past each job's retention.
- Metrics (`ship.job.queue.depth`, `ship.job.queue.oldest_waiting_age`,
  `ship.job.run.duration`, `ship.job.runs`, `ship.job.dead_letter.count`,
  `ship.job.lock.wait`) carry `ship.job.id` and `ship.job.key` attributes.

Delivery is at-least-once. A process that dies after a handler's external
work but before BullMQ records completion leaves a stalled job that is
returned to the queue after `worker.lockDuration`; make handlers idempotent or
declare `idempotency` on the job.
