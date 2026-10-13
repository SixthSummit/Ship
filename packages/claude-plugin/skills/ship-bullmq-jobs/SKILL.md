---
name: ship-bullmq-jobs
description: Use when defining or debugging background jobs in a ShipAPI v4 codebase — files matching `modules/**/jobs/**/*.ts` or `*.job.ts`, mentions of `defineJob`, `defineCron`, BullMQ, queue, worker, scheduling. Loads the job module pattern, queue producer/worker split via WORKER_MODE, repeatable cron via defineCron, and the jobs/cron auto-discovery convention.
---

# ShipAPI v4 — BullMQ jobs + cron

> **Source**: alpha-2 plan §E (BullMQ + cron) and the canonical references at `packages/core/src/app/services/jobs/` (defineJob / JobRegistry / JobsManager) and `packages/core/src/app/services/cron/` (defineCron).

## Job module pattern

Each job file default-exports a `JobDefinition`. The framework auto-registers via module walk.

```ts
// modules/billing/jobs/sendInvoiceEmail.job.ts
import { defineJob } from "@sixthsummit/ship-api";
import { z } from "zod";

export default defineJob({
  queue: "billing",
  name: "send-invoice-email",
  payloadSchema: z.object({
    accountId: z.string().uuid(),
    invoiceId: z.string().uuid(),
  }),
  options: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },
  },
  async processor(payload, ctx) {
    // ctx carries: jobId, attemptsMade, logger (request-scoped child),
    // signal (aborts on graceful shutdown).
    if (ctx.signal.aborted) return;
    const invoice = await invoicesService.get(payload.invoiceId);
    await emailLib.send({ to: payload.accountId, ... });
  },
});
```

## Cron pattern

`defineCron` is schema-driven cron via BullMQ repeatables — one source-of-truth queue for both ad-hoc and scheduled work.

```ts
// modules/billing/cron/dailyReconcile.cron.ts
import { defineCron } from "@sixthsummit/ship-api";

export default defineCron({
  name: "billing.daily-reconcile",
  schedule: "0 2 * * *", // 2 AM UTC
  async handler(ctx) {
    // ctx carries: traceId, logger, signal.
    await billingReconciler.runDaily();
  },
});
```

## WORKER_MODE

The same code base runs in three roles via a single env var:

| `WORKER_MODE`          | What runs                                               | When                    |
| ---------------------- | ------------------------------------------------------- | ----------------------- |
| `api`                  | HTTP routes + producers (`enqueue` works); no consumers | Stateless web pods      |
| `worker`               | Job processors + cron triggers; no HTTP routes          | Background workers      |
| `all` (default in dev) | Everything                                              | Local dev for fast loop |

Cron triggers ONLY run in `worker` / `all` modes — no double-firing across multiple `api` pods.

## Producer side (enqueue from a route handler)

```ts
import { enqueue } from "@sixthsummit/ship-api";

app.post("/invoices", auth, validate("json", schema), async (c) => {
  const invoice = await invoiceService.create(c.req.valid("json"));
  await enqueue("billing", "send-invoice-email", {
    accountId: invoice.accountId,
    invoiceId: invoice.id,
  });
  return c.json(invoice, 201);
});
```

## Convention: never enqueue inside a transaction

Enqueueing inside a DB transaction risks "queued before commit" — the worker picks up the job, queries the DB, and doesn't see the row. Use the **outbox pattern** instead:

```ts
await db.transaction(async (tx) => {
  const invoice = await invoiceService.create(values, { tx });
  await emitter.emit(
    {
      eventType: "invoice.created",
      payload: { invoiceId: invoice.id, accountId: invoice.accountId },
    },
    { tx },
  );
});
```

Then a registered EventHandler (consumer-side; see `modules/outbox/handlers/`) does the BullMQ enqueue when the outbox drains. The outbox guarantees at-least-once delivery atomically with the domain write.

## Observability

Every job processor wraps in:

- OTel span `job.<queue>.<name>` — visible in your trace backend
- Child logger bindings `{ queueName, jobId, attemptsMade }`
- BullMQ events forwarded to logger + Prometheus counter `jobs_processed_total{queue, name, status}`

## Graceful shutdown

`SIGTERM` triggers the framework's shutdown manager:

1. Stop accepting HTTP traffic
2. `worker.close()` — drain in-flight jobs (configurable timeout, default 30s)
3. Flush OTel
4. Close DB pool / Redis

In-progress job processors get an aborted signal — handlers should honor `ctx.signal` and exit early without crashing.
