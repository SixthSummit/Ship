# Operator console

> **Kernel feature.** `@sixthsummit/ship-console` mounts the console on the
> operation-oriented kernel ([ADR-0024](../../rearchitecture/decisions/0024-kernel-ops-console.md)).
> It has no compatibility-line counterpart.

One authenticated surface for what used to need Cloud Logging and SQL: every
queue with its depth, running and dead-lettered runs; every cron schedule with
its next and last run; every stored webhook receipt with the outbox record it
spawned; every realtime channel with its subscribers; every outbox with its
pending, leased and dead-lettered records. Every read and every mutation is a
declared operation, so direct execution, HTTP and the generated client share
one access policy and one audit trail.

## Mount

```ts
import { defineConsoleModule } from "@sixthsummit/ship-console";

const console = defineConsoleModule({
  // Modules that export the tokens the panels bind.
  imports: ["portfolio", "reports", "payments"],
  // Jobs and cron panels over jobBackendDependency().
  jobs: true,
  // Outbox panel over each outbox.backend token.
  outboxes: [reportsOutbox, paymentsOutbox],
  // Webhooks panel over the event store and the unit of work replay links in.
  webhooks: { webhooks: [stripe, inboundSms], store: webhookEvents, unitOfWork },
  // Realtime panel over the backend this process publishes through.
  realtime: { backend: realtime, channels: [...publishedChannels, projectActivity] },
});

export const app = defineApp({ id: "app", modules: [...modules, console] });
```

The module id (`id`, default `console`) prefixes every operation and the HTTP
path (`basePath`, default `/console`) prefixes every route. `createHonoAdapter`
projects them like any other operation; nothing else is mounted.

The bound tokens must be exported by an imported module: `jobBackendDependency()`
and `lockProviderDependency()` by whichever module provides the backend, each
outbox's `writer` by the module that provides it (the console binds the
matching `backend` token), and the webhook event store plus unit-of-work tokens
by their owners. The realtime backend is passed as an instance because the
publication module does not export it.

## Permission

Every console operation declares `permission("console.operate")`
(`CONSOLE_OPERATE_PERMISSION`). Grant it to the role that operates the system,
explicitly:

```ts
const rolePermissions = {
  operator: ["portfolio:read", WEBHOOK_REPLAY_PERMISSION],
  sre: ["portfolio:read", CONSOLE_OPERATE_PERMISSION],
};
```

The slug is never derived from `ship.jobs:manage`, `ship.outbox:manage`,
`ship.webhooks:replay` or an application admin role, so mounting the console
is default-off for every existing role: the customized golden consumer proves
its `operator` role (which may replay webhooks) is refused with 403 on every
console operation, directly and over HTTP.

## Panels

| Panel | Operation | Transport | What it does |
| --- | --- | --- | --- |
| — | `console.panels` | `GET /console` | What is mounted, for the UI |
| jobs | `console.jobs.overview` | `GET /console/jobs` | Per job: waiting, active, delayed, failed, lag, last run and success, paused; adapter capabilities |
| jobs | `console.jobs.runs` | `GET /console/jobs/runs?jobId&status&limit` | Runs newest first |
| jobs | `console.jobs.run` | `GET /console/jobs/run?runId` | One run with input, error history and timestamps |
| jobs | `console.jobs.retry` | `POST /console/jobs/retry` `{ runId }` | Re-run a dead-lettered run once |
| jobs | `console.jobs.discard` | `POST /console/jobs/discard` `{ runId, reason }` | Discard a dead-lettered run with a recorded reason |
| jobs | `console.jobs.retry-all` | `POST /console/jobs/retry-all` `{ jobId?, limit? }` | Bulk retry |
| jobs | `console.jobs.pause` / `resume` | `POST /console/jobs/pause` `{ jobId }` | Stop or restart claims for one job |
| cron | `console.cron.schedules` | `GET /console/cron` | Every schedule or interval job with next, last run and last success |
| cron | `console.cron.trigger` | `POST /console/cron/trigger` `{ jobId }` | Enqueue one run now with the empty payload a tick carries |
| webhooks | `console.webhooks.receipts` | `GET /console/webhooks/receipts?webhookId&before&limit` | Stored receipts with the outbox record each spawned, plus recent outcomes |
| webhooks | `console.webhooks.receipt` | `GET /console/webhooks/receipt?eventId` | Redacted headers and a bounded body preview |
| webhooks | `console.webhooks.replay` | `POST /console/webhooks/receipts/:eventId/replay` | Re-enqueue the stored event's intent (the kernel replay under the console slug) |
| realtime | `console.realtime.channels` | `GET /console/realtime` | Channels with subscriber and scope counts and the last publish |
| outbox | `console.outbox.overview` | `GET /console/outbox` | Per outbox: pending, leased, dead-lettered, oldest pending |
| outbox | `console.outbox.records` | `GET /console/outbox/records?outboxId&status&limit` | Records by status |
| outbox | `console.outbox.retry` / `discard` | `POST /console/outbox/retry` `{ outboxId, recordId }` | Dead-letter recovery |

Run ids and record ids travel in the body or query, never the path, because
BullMQ run ids contain `/`.

## Capabilities per adapter

The console reads backend-neutral introspection the kernel declares as
*optional* on each contract, so adapters that predate it keep compiling and a
panel degrades per capability. A missing one is the declared failure
`CONSOLE_CAPABILITY_UNAVAILABLE` (501) with `details.capability`, never a
failed mount.

| Capability | in-memory | BullMQ | PostgreSQL (Drizzle) | Socket.IO gateway |
| --- | --- | --- | --- | --- |
| job run listing, detail, schedules | yes | yes (`getJobs`, scheduler `next`) | yes | — |
| job pause / resume | yes | yes (`queue.pause/resume`) | with `controlTable: shipJobControlTable()` | — |
| webhook receipt listing | yes | — | yes | — |
| outbox record lookup and listing | yes | — | yes | — |
| realtime subscriber counts, last publish | yes | — | — | yes (per gateway) |

The PostgreSQL pause state lives in the opt-in `ship_job_control` table so no
existing table changes shape; include it in a gated migration and pass it to
`createDrizzleJobBackend({ controlTable })`. Workers read it once per poll, so
a pause taken on one process stops claims on every process. Without the table
the backend exposes no `pause`/`resume` and the overview reports
`capabilities.pause: false`.

## Receipt outcomes

Stored receipts are only the verified ones. To also see rejected, duplicate
and unavailable outcomes, create one `createConsoleWebhookObserver({ capacity })`,
pass its `observer` to the HTTP adapter's `webhooks.observer` (forward your
metrics observer through `forward`), and hand it to the console's
`webhooks.observer`. The ring buffer is process-local by design.

## Extensions

```ts
defineConsoleModule({
  ...,
  extensions: [{ id: "auth-audit", title: "Auth audit", operations: [events, sessions, revoke] }],
});
```

Every extension operation must be namespaced `<consoleId>.<extensionId>.` and
declare `consoleAccess()`; `defineConsoleModule` rejects anything else with
`SHIP_CONSOLE_EXTENSION_ACCESS_INVALID` or
`SHIP_CONSOLE_EXTENSION_OPERATION_ID_INVALID`, so an extension can never widen
what the mount exposes. This is the seam the auth-audit panel (11.2) lands in.

## Angular

`@sixthsummit/ship-angular/console` renders the panels over the application's
own operation client:

```ts
// Embedded under an application route
provideShipConsole({ client: () => injectShipClient(APP_CLIENT) });
{ path: "console", children: shipConsoleRoutes({ canActivate: [signedInGuard] }) }

// Deployed as its own application next to the API
bootstrapApplication(ShipConsoleAppComponent, {
  providers: [
    provideRouter(shipConsoleRoutes({ canActivate: [signedInGuard] })),
    provideShipConsole({ client }),
  ],
});
```

`ShipConsole` is signal-first: `panels`, `jobs`, `runs`, `schedules`,
`receipts`, `realtime`, `outboxes` and `outboxRecords` hold the latest values,
`busy` tracks in-flight calls and `failure` keeps the last declared failure as
a value (a 403 without `console.operate`, a 501 for a missing capability) so
the shell renders it inline. `ShipConsoleContract` types a client over the
default mount; another `id` uses `prefix` and the untyped `ShipConsoleClient`.
`shipConsoleRoutes` refuses an empty guard list: the backend decides who may
act, the application decides who may see.

## Proof

- `packages/console/src/module.test.ts`: every panel composed; an actor holding
  `ship.jobs:manage`, `ship.outbox:manage` and `ship.webhooks:replay` but not
  `console.operate` refused on every operation, directly and over HTTP; retry,
  discard, bulk retry, pause and resume; schedules and trigger-now; receipts
  with the spawned record, detail and replay; outbox inspection and recovery;
  realtime counts; extension gating; 501 for a missing capability.
- `fixtures/consumers/customized`: the console mounted next to the existing
  roles; the `operator` role refused; an SRE retries a dead-lettered
  `reports.deliver` run, pauses and resumes it through the PostgreSQL control
  table, lists a verified Stripe receipt with its completed dispatch and replays
  it, over HTTP against real PostgreSQL.
- Adapter suites: in-memory, BullMQ (fake queue), Drizzle (fake store and live
  PostgreSQL, including a second process honouring a pause) and Socket.IO.
