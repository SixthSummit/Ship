# `@sixthsummit/ship-observability-otel`

Optional OpenTelemetry integration for Ship applications. Explicit subpaths
separate lightweight tracing helpers, Node SDK lifecycle, and the Prometheus
metrics server. Importing the application kernel never starts telemetry or
pulls this dependency closure into edge applications.

Start the SDK before loading application dependencies:

```ts
// instrumentation.ts
import { startOtel } from "@sixthsummit/ship-observability-otel/sdk";

startOtel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "my-api" });
```

```ts
// index.ts
import "./instrumentation.js";

await import("./server.js");
```

A first static import followed by static application imports is not sufficient:
ESM evaluates the entire static dependency graph before calling `startOtel()`.

`createWebhookMetrics()` (`./webhooks`) returns a kernel `WebhookObserver` for
`createHonoAdapter({ webhooks: { observer } })` and `webhookIntent({ observer })`.
It records `ship.webhook.received` (by outcome and status, with the
verification-failure reason), `ship.webhook.receive.duration` and
`ship.webhook.dispatch.lag`, always attributed with `ship.webhook.id` and
`ship.webhook.provider` and never with header or body content.
