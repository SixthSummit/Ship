# ADR-0024: Kernel ops console as declared operations behind a dedicated permission

- **Status:** Accepted
- **Date:** 2026-10-22
- **Scope:** Operator console package, backend-neutral introspection contracts, console permission, Angular console entrypoint, extension seam
- **Related:** [ADR-0004](./0004-credential-actor-and-access-boundary.md) · [ADR-0014](./0014-actor-kinds-and-durable-outbox-delivery.md) · [ADR-0015](./0015-declared-jobs-and-schedules.md) · [ADR-0017](./0017-declared-realtime-publication.md) · [ADR-0018](./0018-inbound-webhook-operations.md)

## Context

Rails ships Mission Control Jobs: mount one engine and an operator sees every queue, every job with its arguments and error, retries or discards one or many, pauses a queue, and reads recurring tasks with their next run. The kernel had the durable state (job runs, schedules, webhook receipts, outbox records, realtime channels) and the management operations (`ship.jobs:manage`, `ship.outbox:manage`, `ship.webhooks:replay`), but no operator surface. The consumer with the most queues in the fleet (13 queues, 15 jobs, 6 cron routes) read Cloud Logging when something stuck, recovered backlogs by hand and inspected webhook receipts in SQL.

Three constraints shaped the answer. Every read and mutation must be an operation, so direct execution, HTTP and the generated client share one access policy and one audit trail (ADR-0001, ADR-0004). The console must not widen what an existing role can do: a mount is a default-off addition for every consumer. And the console must not know which adapter is bound: Vault Drive runs BullMQ, Tortlink v2 runs the PostgreSQL job backend, and both must get the same panels.

## Decision

### Introspection is an optional capability of each adapter contract

The kernel contracts gain operator-facing reads that no existing adapter is forced to implement:

- `JobBackend.introspection?: JobIntrospection` — `declarations()`, `listRuns({ jobId?, status?, limit })` (newest first), `getRun(runId)`, `listSchedules()`, `listPaused()`, and optional `pause(jobId)` / `resume(jobId)`. A paused job keeps accepting runs and keeps ticking its schedule; no worker claims its waiting runs until it is resumed.
- `WebhookEventStore.list?({ webhookId?, before?, limit })` for receipts by endpoint, newest first.
- `OutboxBackend.findRecord?(id)` and `listRecords?({ status?, limit })` for pending, leased and dead-lettered inspection and for resolving the record a receipt spawned.
- `RealtimePublishBackend.introspection?.channels()` for live subscription and scope counts and the last publish a backend instance observed.

`isJobIntrospection`, `jobIntrospection(backend)` and `isRealtimeIntrospection` are the guards. The console reports a missing capability as the declared failure `CONSOLE_CAPABILITY_UNAVAILABLE` (501) and a panel disables the action; it never fails the mount.

The in-memory adapters in `@sixthsummit/ship-testing`, the BullMQ backend (`queue.getJobs`, job scheduler `next`, `queue.pause/resume`), the PostgreSQL backend and the Socket.IO gateway implement them. The PostgreSQL backend holds pause state in an **opt-in** `shipJobControlTable()` (`ship_job_control`: `job_id`, `paused_at`, `updated_at`) passed as `controlTable`; without it the backend exposes no `pause`/`resume` and no existing table changes shape. Workers read the control rows once per poll, so a pause taken on one process stops claims on every process.

### `@sixthsummit/ship-console` composes the console as one module

`defineConsoleModule({ id?, basePath?, imports, jobs?, outboxes?, webhooks?, realtime?, extensions?, clock? })` returns an ordinary module. Every operation id is namespaced by the module id (default `console`), every HTTP transport is declared with `@sixthsummit/ship-hono` under `basePath` (default `/console`), and every operation declares `access: permission("console.operate")`:

| Panel | Operations |
| --- | --- |
| `panels` | `console.panels` (what is mounted, for the UI) |
| jobs | `jobs.overview`, `jobs.runs`, `jobs.run`, `jobs.retry`, `jobs.discard`, `jobs.retry-all`, `jobs.pause`, `jobs.resume` |
| cron | `cron.schedules`, `cron.trigger` (enqueues the empty payload a scheduler tick carries) |
| webhooks | `webhooks.receipts`, `webhooks.receipt`, `webhooks.replay` (the kernel's `defineWebhookReplay`, gated by the console permission instead of `ship.webhooks:replay`) |
| realtime | `realtime.channels` |
| outbox | `outbox.overview`, `outbox.records`, `outbox.retry`, `outbox.discard` |

The jobs and cron panels bind `jobBackendDependency()`; the outbox panel binds each outbox's `backend` token; the webhooks panel binds the event store and unit-of-work tokens plus the outboxes its enqueue-mode webhooks write to; the realtime panel binds a value provider the console creates for the backend instance it is given. The consumer lists the modules that export those tokens in `imports`. Stored receipts are only the verified ones, so `createConsoleWebhookObserver()` keeps a bounded, process-local ring of every receipt outcome (rejected, duplicate, unavailable) that the receipts operation returns alongside.

### `console.operate` is never implied

`CONSOLE_OPERATE_PERMISSION = "console.operate"` is a plain permission slug the application's actor resolver grants explicitly. It is not derived from `ship.jobs:manage`, `ship.outbox:manage`, `ship.webhooks:replay` or an application admin role, and the console package tests prove that an actor holding every framework management slug is refused on every console operation, directly and over HTTP. An extension (`extensions: [{ id, title, operations }]`, the seam the auth-audit panel of 11.2 uses) is rejected at definition time unless every operation is namespaced `<consoleId>.<extensionId>.` and requires exactly that permission (`SHIP_CONSOLE_EXTENSION_ACCESS_INVALID`, `SHIP_CONSOLE_EXTENSION_OPERATION_ID_INVALID`).

### The Angular console is a secondary entrypoint over the structural client

`@sixthsummit/ship-angular/console` ships `provideShipConsole({ client, prefix? })`, the signal-first `ShipConsole` service, five standalone `OnPush` panel components, `ShipConsoleShellComponent`, `shipConsoleRoutes({ canActivate })` for embedding under an application route, and `ShipConsoleAppComponent` for a console deployed next to the API. It calls the application's own `OperationClient` (any client satisfies the structural `ShipConsoleClient`), types the default mount through `ShipConsoleContract`, and keeps declared failures as values on `failure` so a 403 or 501 renders inline. `shipConsoleRoutes` refuses an empty guard list: the backend decides who may act, the application decides who may see.

## Consequences

- Both consumers mount one module, grant one slug to their SRE role, and get the same panels over BullMQ and PostgreSQL; the customized golden consumer proves the mount, the refusal of the `operator` role, a dead-lettered run retried through the console, durable pause and resume through the control table, and a receipt listed with its spawned record and replayed, against real PostgreSQL.
- Adapters that predate this decision keep compiling: every new contract member is optional, and the console degrades per capability instead of per mount.
- The PostgreSQL pause capability is a gated migration (`ship_job_control`), never a boot-time change, and a consumer that does not add the table loses only pause/resume.
- Receipt outcomes other than "verified and stored" are process-local; a fleet with several API processes reads them per process or forwards the observer to its metrics pipeline.
- Realtime counts are per backend instance (a gateway answers for its own connections); cluster-wide totals remain an observability concern.

## Rejected alternatives

### A separate console permission per panel

Rejected for now: one slug keeps the grant auditable and the "never implied" rule simple. Per-panel slugs can be layered as `anyPermission(...)` later without moving an operation.

### Deriving console access from the existing management slugs

Rejected because it would make every existing `ship.jobs:manage` holder a console operator the day the console is mounted, which violates the default-off rule for existing consumers.

### A console that calls other operations through the executor

Rejected because an operation handler has no executor and because reusing `defineWebhookReplay` with a different permission gives the same replay semantics without a second code path.

### Storing PostgreSQL pause state on `ship_job_state`

Rejected because adding a column to a table every PostgreSQL consumer already has would make `health()` fail until the migration ran; an opt-in table keeps existing deployments untouched.
