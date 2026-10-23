# `@sixthsummit/ship-console`

The operator console for Ship applications: queues, cron schedules, webhook
receipts, realtime channels and outboxes in one authenticated surface. Every
read and every mutation is a declared operation, so direct execution, HTTP and
the generated client share one access policy and one audit trail.

```ts
import { defineConsoleModule } from "@sixthsummit/ship-console";

const console = defineConsoleModule({
  imports: ["portfolio", "reports", "payments"], // modules exporting the bound tokens
  jobs: true,                                     // binds jobBackendDependency()
  outboxes: [reportsOutbox, paymentsOutbox],      // binds each outbox.backend
  webhooks: { webhooks: [stripe], store: webhookEvents, unitOfWork },
  realtime: { backend: realtime, channels },
});

defineApp({ id: "app", modules: [...modules, console] });
```

Mount the compiled app with `createHonoAdapter` as usual: the panels appear
under `/console/*` (`basePath` to change it) as `console.*` operations (`id`
to change the prefix).

## Permission

Every operation declares `permission("console.operate")`
(`CONSOLE_OPERATE_PERMISSION`). Grant it explicitly to the role that operates
the system. It is never derived from `ship.jobs:manage`, `ship.outbox:manage`,
`ship.webhooks:replay` or an application admin role, so mounting the console
widens nothing for existing roles.

## Panels

| Panel | Reads | Mutations |
| --- | --- | --- |
| jobs | overview (waiting, active, delayed, failed, lag, paused), runs by status, run detail | retry, discard, retry-all, pause, resume |
| cron | every schedule or interval job with next, last run and last success | trigger now |
| webhooks | receipts by endpoint with the spawned outbox record, recent outcomes, receipt detail | replay |
| realtime | channels with subscriber counts and last publish | — |
| outbox | per-outbox pending, leased and dead-lettered counts, records by status | retry, discard |

Capabilities depend on the bound adapter. A backend without introspection
answers the overview but not the run listing; a PostgreSQL job backend
pauses durably only when created with `controlTable: shipJobControlTable()`.
A missing capability is the declared failure `CONSOLE_CAPABILITY_UNAVAILABLE`
(501), never a failed mount.

Stored receipts are the verified ones. To see rejected, duplicate and
unavailable outcomes too, create `createConsoleWebhookObserver()` once, pass
its `observer` to the HTTP adapter's `webhooks.observer`, and hand the
observer to `webhooks.observer` here; the ring buffer is process-local.

## Extensions

`extensions: [{ id: "auth-audit", title: "Auth audit", operations }]` adds a
panel. Each operation must be namespaced `<consoleId>.<extensionId>.` and use
`consoleAccess()`; anything else is rejected at definition time.

## UI

`@sixthsummit/ship-angular/console` renders the panels: `provideShipConsole({
client })`, `shipConsoleRoutes({ canActivate })` to embed under an application
route, or `ShipConsoleAppComponent` for a console deployed next to the API.
