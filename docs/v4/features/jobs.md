# Background jobs and cron

> **Compatibility feature:** these BullMQ and cron APIs remain available from the
> monolithic v4 package. The focused kernel currently models durable effects and
> outbox boundaries, not a general queue/job framework.

`defineJob`, `JobsManager`, the transactional outbox pattern, scheduled work via `defineCron`, and the optional `@bull-board/hono` admin dashboard. The framework's BullMQ-backed background-work surface, end to end.

## Defining a job

```ts
import { defineJob } from "@sixthsummit/ship-api";
import { z } from "zod";

const SendWelcomePayload = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
});

export const sendWelcomeJob = defineJob({
  queue: "emails",
  name: "send-welcome",
  handler: async (payload, { job, context }) => {
    await emailService.sendWelcome(payload.userId, payload.email);
    job.log(`sent welcome email to ${payload.email}`);
  },
  options: {
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
    },
  },
});
```

Two things `defineJob` does:

1. Builds a `JobDefinition<TPayload, TResult>` tagging the handler with its queue + name.
2. Auto-registers it into the framework-wide `jobRegistry` (pass `register: false` as the second argument to opt out — almost never the right call).

Auto-registration matters because the `InitJobs` bootstrapper (priority 60, runs after `InitRedis` at 30) reads the registry and creates BullMQ queues + workers from it. You don't wire up the worker manually; you define the job and the framework picks it up at boot.

The convention for *where* job files live:

```
src/modules/<module>/jobs/<jobName>.job.ts
```

`InitModules` (priority 50) imports each module, which imports its `jobs/*.job.ts` files at module load time, which calls `defineJob` and registers. By the time `InitJobs` runs, the registry is fully populated.

## The handler signature

```ts
type JobHandler<TPayload, TResult> = (
  payload: TPayload,
  ctx: JobHandlerContext,
) => Promise<TResult> | TResult;

interface JobHandlerContext {
  job: Job;                        // BullMQ Job — for log(), updateProgress(), attemptsMade
  context: LifecycleHookContext;   // Framework request-scoped context (requestId, etc.)
}
```

Two handles in `ctx`:

- **`job`** — the underlying BullMQ `Job` object. Use `job.log(message)` to emit messages visible in the bull-board UI; `job.updateProgress(0..1)` for long-running progress; `job.attemptsMade` to detect retry-vs-first-run.
- **`context`** — the framework's lifecycle context. `requestId` is `job:${jobId}`, so the request-scoped logger and any DB hooks behave consistently with HTTP requests. Logs from inside the handler carry `requestId` automatically.

## Enqueueing jobs

From a route handler (or anywhere the `JobsManager` is in scope):

```ts
await jobsManager.enqueue("emails", "send-welcome", {
  userId: account.id,
  email: account.email,
});

// Override defaults at enqueue time:
await jobsManager.enqueue("emails", "send-welcome", payload, {
  attempts: 3,
  priority: 10,
  delay: 60_000,                 // run 60s from now
});
```

`enqueue` resolves the job definition from the registry first — so a typo in the queue or job name fails immediately rather than landing in a silent dead-letter situation. The opts argument merges with the job's `defaultJobOptions`.

## Worker mode vs API mode

```
WORKER_MODE=api      # default — HTTP only, no workers
WORKER_MODE=worker   # workers only, no HTTP server
WORKER_MODE=all      # both (local dev default)
```

The same image runs in either mode; the env var tells `JobsManager` whether to start workers. In production you typically run the API behind a load balancer (replicas scale with traffic) and a separate worker pool (replicas scale with queue depth). Each pod's `WORKER_MODE` is set differently.

When `mode === "api"`, `JobsManager.startWorkers()` returns 0 and skips worker initialization. Producer-side functionality (queue access, `enqueue()`) always works.

## Retry semantics

BullMQ's defaults apply:

- **`attempts: 1`** — no retries unless you configure them.
- **No backoff** unless you configure one.

This is intentional. The framework doesn't impose a default backoff because the right policy depends on the job — sending an email wants exponential backoff with several attempts; charging a payment wants exactly one attempt with manual review on failure.

The standard pattern:

```ts
options: {
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },  // 1s, 2s, 4s, 8s, 16s
  },
}
```

For exactly-once-ish semantics (where retry is unsafe), set `attempts: 1` and handle failures via the outbox pattern's terminal-failure path or a dedicated dead-letter inspection workflow.

## Cron — scheduled jobs

```ts
import { defineCron } from "@sixthsummit/ship-api";

export const dailyInvoiceRun = defineCron({
  name: "daily-invoice-run",
  schedule: "0 2 * * *",         // 02:00 daily, cron syntax
  tz: "America/New_York",
  handler: async (_payload, { job }) => {
    job.log("starting daily invoice run");
    await invoiceService.runDaily();
  },
});
```

`defineCron` is a thin wrapper over `defineJob` — it uses BullMQ repeatables under the hood. The differences:

- Payload is always `void` (cron jobs don't carry data; if a cron needs config, read from env or a settings table).
- Default queue is `cron` (the constant `CRON_QUEUE`), separate from regular work queues so you can monitor cron specifically.
- Runs through `InitCron` (priority 65) which scans the registry for cron-tagged definitions and registers BullMQ repeatables.

Schedule syntax is standard cron expressions. `tz` accepts IANA names (`"America/New_York"`, `"Europe/London"`, etc.) and respects DST transitions via `cron-parser`. Without `tz`, schedules are UTC.

The convention for cron file location:

```
src/modules/<module>/cron/<cronName>.cron.ts
```

Same auto-discovery as jobs.

## The outbox pattern — atomic enqueue with database writes

A common bug: enqueue a BullMQ job inside a database transaction, the transaction rolls back, but the job already shipped to Redis — the worker picks it up, queries for a row that doesn't exist, fails. Or worse: it succeeds based on stale state.

Don't do that. Use the outbox pattern.

```ts
import { OutboxEventEmitter } from "./modules/outbox";
import { withTransaction } from "@sixthsummit/ship-api";

const emitter = new OutboxEventEmitter(db);

await withTransaction(db, async (tx) => {
  const account = await accountService.create(input, { tx });
  await emitter.emit({
    eventType: "account.created",
    aggregateType: "account",
    aggregateId: account.id,
    payload: { id: account.id, email: account.email },
  }, { tx });    // <-- same tx; row is part of the transaction
});
```

The `{ tx }` option is critical. Without it, the event row inserts in its own implicit transaction and decouples from the domain write — defeating the whole pattern.

A separate `OutboxDrainer` polls the outbox table and dispatches events to handlers:

```ts
import { eventHandlerRegistry, OutboxDrainer } from "./modules/outbox";

const handlers = eventHandlerRegistry({
  eventType: "account.created",
  async handle(event, ctx) {
    await jobsManager.enqueue("emails", "send-welcome", {
      userId: event.aggregateId!,
      email: (event.payload as { email: string }).email,
    });
  },
});

const drainer = new OutboxDrainer(outboxEventService, handlers);
const result = await drainer.runOnce({ batchSize: 50 });
// result.published, result.failed, result.retried, result.skippedNoHandler
```

The drainer flow per batch:

1. **`findReadyToPublish(batchSize)`** — `SELECT` rows where `status = 'pending'` and `nextAttemptAt <= now()`.
2. **`claimForProcessing(ids)`** — atomic `UPDATE` to `status = 'processing'`, increment `publishAttempts`, stamp `startedAt`. Concurrent drainers don't double-process — Postgres handles the race.
3. For each claimed row: resolve the handler (exact `(eventType, eventVersion)` match, falls back to a version-agnostic handler), invoke `handle(event, ctx)`.
4. **On success** → `markPublished(id)` — terminal.
5. **On throw** → check retry budget; if exhausted, `markFailed(id, error)` (terminal). Otherwise `markForRetry(id, error)` — revert to `pending` with `nextAttemptAt = computeNextAttempt()`.
6. **No handler registered** → mark for retry. This lets you backfill handlers after events accumulate; the next drain picks them up.

Backoff is exponential with ±20% jitter, capped at 1 hour:

```ts
function computeNextAttempt(attempts: number, baseMs = 1_000, maxMs = 60 * 60 * 1_000): Date {
  const exponential = baseMs * Math.pow(2, Math.max(0, attempts - 1));
  const capped = Math.min(exponential, maxMs);
  const jittered = capped * (0.8 + Math.random() * 0.4);
  return new Date(Date.now() + jittered);
}
```

Default retry budget is 10 attempts (override per event via `maxRetries`).

**Handlers must be idempotent.** The drainer guarantees at-least-once delivery, not exactly-once. If your handler enqueues a BullMQ job, dedupe on the BullMQ side via `jobId` set to the event's `dedupeKey` or `eventId`.

## The bull-board admin UI

```ts
import { createBullBoardApp } from "@sixthsummit/ship-api/app/services/jobs/bullBoard";

const bullBoard = await createBullBoardApp({
  jobsManager,
  apiKey: env.ADMIN_API_KEY,
  basePath: "/admin/jobs",        // optional, defaults to "/admin/jobs"
});

app.route(bullBoard.basePath, bullBoard.app);

// If you register more jobs after createBullBoardApp returned:
bullBoard.refresh();
```

Notable design choices:

- **Optional peer dep.** `@bull-board/hono` and `@bull-board/api` aren't in the framework's `dependencies` — they're declared as optional peers and dynamic-imported. Apps that don't mount the UI pay zero runtime cost (~30 KB of EJS bundle stays unloaded).
- **API-key gated.** The dashboard requires an `x-admin-api-key` header. Comparison uses `timingSafeEqual` (constant-time, no length-mismatch oracle). An empty key throws at construction time, not at first request — fail fast on misconfiguration.
- **Defense-in-depth recommended.** API-key alone shouldn't gate production access to a dashboard that can purge queues. Stack network controls (private subnet, VPN, mesh-internal-only) on top.
- **Auto-discovers queues.** `createBullBoardApp` reads `jobsManager.getQueueNames()` at construction. If you register more jobs after construction (rare in practice — happens during dynamic-loaded plugins), call `refresh()` to rebuild the queue list.

For dev/staging environments, mount it. For production, the operator decides — most teams disable in prod and rely on log-based observability + Redis Insights / CloudWatch.

## Operational concerns

**Queue depth = capacity signal.** Monitor `bullmq.queue.waiting` and `bullmq.queue.delayed` (both exposed via the framework's Prometheus exporter — see [observability](observability.md)). Sustained growth means workers can't keep up; scale workers horizontally or increase per-worker `concurrency`.

**Job timeout is BullMQ's responsibility.** Set `defaultJobOptions.lockDuration` (default 30s) to bound how long a job can hold its lock. If your handler runs longer, the lock expires and another worker picks the job up — duplicates are now possible. For slow handlers, increase `lockDuration`; for very-long handlers, restructure into smaller units of work.

**Memory leaks in workers persist.** Workers process jobs in a long-running process; small leaks accumulate. Set a sensible per-worker job limit (BullMQ's `removeOnComplete` and `removeOnFail` to prune Redis state; PM2 / Kubernetes restart policies for leaked memory).

**Don't `console.log` from job handlers.** Use the framework's logger via the request-scoped child available from `ctx.context`. `console.log` loses request-id correlation and bypasses redaction.

## Source

- [`packages/core/src/app/services/jobs/`](https://github.com/sixthsummit/ship-api/tree/main/packages/core/src/app/services/jobs) — `defineJob`, `JobRegistry`, `JobsManager`, `bullBoard`
- [`packages/core/src/app/services/cron/`](https://github.com/sixthsummit/ship-api/tree/main/packages/core/src/app/services/cron) — `defineCron`, `CRON_QUEUE`
- [`modules/outbox/`](https://github.com/sixthsummit/ship-api/tree/main/modules/outbox) — outbox pattern: `OutboxEventEmitter`, `OutboxDrainer`, `EventHandlerRegistry`
- [`.cursor/rules/api.mdc`](https://github.com/sixthsummit/ship-api/blob/main/.cursor/rules/api.mdc) — the never-enqueue-inside-transaction rule
