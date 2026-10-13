# Observability

> **Compatibility and adapter guide:** monolithic helpers remain supported. New
> applications may install `@sixthsummit/ship-observability-otel` at process
> composition without introducing telemetry into the core graph.

The OpenTelemetry SDK with auto-instrumentation, the pino logger with request-scoped context propagation, the Prometheus metrics exporter, and the `withSpan` helper. How they correlate via trace-id, request-id, and span-id, and what to do when something goes wrong.

## The three layers

ShipAPI wires three independent observability subsystems and correlates them through OpenTelemetry's trace context:

- **Tracing** — OpenTelemetry SDK with auto-instrumentation for HTTP, pg, ioredis, undici (fetch), and pino. Spans flow to your OTel-compatible backend (Tempo, Honeycomb, Jaeger, Datadog, GCP Cloud Trace, etc.).
- **Logging** — pino with structured JSON output in production, pretty output in dev. Every log line gets `requestId`, `userId`, `tenantId`, `trace_id`, `span_id` automatically.
- **Metrics** — Prometheus exporter on a separate port. Default HTTP / DB / cache metrics auto-registered; framework subsystems add their own (BullMQ depth, rate-limit rejections, etc.).

All three connect at the OpenTelemetry context level — same trace, same span. Pull on one thread (a slow request in your APM), follow it to the others (the structured logs from that request, the spans inside it).

## Tracing

### Bootstrap

Start telemetry in a dependency-free instrumentation module, then dynamically
load the application:

```ts
// src/instrumentation.ts
import { startOtel } from "@sixthsummit/ship-observability-otel/sdk";

startOtel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "my-api" });
```

```ts
// src/index.ts
import "./instrumentation.js";

await import("./server.js");
export type { ShipApiClient } from "./server.js";
```

The dynamic import is load-bearing. ESM evaluates all static dependencies
before running a module body, so putting `startOtel()` above static application
imports only looks correct: database and outbound HTTP libraries have already
loaded by then. Keep application imports in `server.ts` and keep
`instrumentation.ts` independent from application code.

### Auto-instrumentations

`@opentelemetry/auto-instrumentations-node` brings:

- **HTTP** (incoming and outgoing) — every request gets a span; outgoing fetch / undici / http propagates `traceparent` headers.
- **pg** — Postgres queries get spans with statement and duration. Bind parameters are redacted by default.
- **ioredis** — Redis commands get spans.
- **pino** — log records get `trace_id` / `span_id` / `trace_flags` injected when a span is active.
- **fs** — disabled by default. fs auto-instrumentation floods spans on cold paths (`require`, `readFile` for static assets); the noise outweighs the value. Re-enable via `disableInstrumentations: []` if you specifically need it.

To disable additional instrumentations:

```ts
startOtel({
  serviceName: "my-app",
  disableInstrumentations: [
    "@opentelemetry/instrumentation-fs",
    "@opentelemetry/instrumentation-dns",
  ],
});
```

### Environment variables

The SDK reads standard OTel env vars — you don't need framework-specific config:

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Where to send traces / metrics / logs |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers (e.g., Honeycomb's API key) |
| `OTEL_SDK_DISABLED=true` | Hard-disable for tests or specific environments |
| `OTEL_SERVICE_NAME` | Override service name (also settable via `defineEnv`) |
| `OTEL_RESOURCE_ATTRIBUTES` | Comma-separated `key=value` resource attributes |

Exporter type (gRPC vs HTTP) is auto-selected based on the endpoint scheme. No-scheme endpoints use gRPC; `http://` and `https://` endpoints use HTTP.

### Custom spans with `withSpan`

For domain-level operations that auto-instrumentation doesn't see:

```ts
import { withSpan } from "@sixthsummit/ship-observability-otel/tracing";

await withSpan("accountService.createWithSetup", async () => {
  const account = await accountService.create(input);
  await sendWelcomeEmail(account);
  return account;
}, { "account.email": input.email });
```

The wrapper:

- Starts an active span with the given name.
- Sets the optional attributes.
- On success, sets span status `OK` and returns the result.
- On error, records the exception, sets status `ERROR`, and re-throws.
- Calls `span.end()` in `finally` — no leaked spans.

When OTel is disabled (test env, `OTEL_SDK_DISABLED=true`), `withSpan` is a thin pass-through — no overhead, no special-casing in call sites.

### Trace propagation

Incoming `traceparent` headers (W3C format) attach the request to its parent trace automatically. Outgoing HTTP requests via undici / fetch carry the active trace context forward — no manual header wiring. Cross-service traces appear as one flow in your APM.

For non-HTTP boundaries (BullMQ jobs, message queues), propagate context manually:

```ts
import { trace, context, propagation } from "@opentelemetry/api";

// Producer:
const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
await jobsManager.enqueue("emails", "send-welcome", {
  userId: account.id,
  _tracecontext: carrier,
});

// Consumer (job handler):
defineJob({
  queue: "emails",
  name: "send-welcome",
  handler: async (payload) => {
    const parentContext = propagation.extract(context.active(), payload._tracecontext ?? {});
    await context.with(parentContext, async () => {
      // work here is part of the producer's trace
    });
  },
});
```

The framework doesn't automate this for jobs (BullMQ payloads are serialized; injecting context into every payload by default is intrusive). The pattern above works when you want trace continuity across the queue.

### Sampling

The framework ships head-based sampling at 100% (every trace exported). For high-throughput workloads, switch to probabilistic sampling via `OTEL_TRACES_SAMPLER` env:

```sh
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1                    # 10% sample rate
```

`parentbased` is critical — if a request comes in with a sampled `traceparent` header, follow the parent's decision rather than sampling independently. Otherwise child spans get dropped while parent traces show, breaking the call graph.

## Logging

### The default logger

```ts
import { logger } from "@sixthsummit/ship-api/observability/logger";

logger.info({ userId: "abc", postId: "def" }, "post.created");
logger.warn({ retryCount: 3 }, "external.api.flaky");
logger.error({ err }, "unhandled.exception");
```

Production output is ND-JSON to stdout. Dev (when `ENVIRONMENT_NAME` is `local|dev|development` or `NODE_ENV` is `dev`) uses pino-pretty for readable terminal output.

Log level is controlled via `LOG_LEVEL` env (`fatal | error | warn | info | debug | trace`); default `info`.

### Request-scoped context

Every log emitted during a request automatically carries:

- `requestId` — set by `httpLogger` middleware from `X-Request-ID` header (or a generated UUID).
- `userId` — set by `requireAuth` after auth resolves.
- `tenantId` — if your app sets it via `runWithRequestContext`.
- `trace_id`, `span_id`, `trace_flags` — injected by `@opentelemetry/instrumentation-pino` when a span is active.

The mechanism is `AsyncLocalStorage` (Node's built-in async-context store). The framework's `httpLogger` middleware wraps every request in `runWithRequestContext({ requestId, ... }, fn)`; child async work inherits the store. Log call sites don't need to thread `requestId` manually.

```ts
// Inside a deeply nested service method, no parameters needed:
logger.info({ accountId }, "fetching profile");
// Output: { "level": 30, "requestId": "...", "userId": "...", "trace_id": "...", "msg": "fetching profile", "accountId": "..." }
```

### Sensitive-field redaction

Default redact paths (preconfigured in the logger):

```
password, token, secret, apiKey
*.password, *.token, *.secret, *.apiKey
req.headers.authorization, req.headers.cookie
firebaseCredentials, gcpCredentialsJson
FIREBASE_CREDENTIALS, GCP_CREDENTIALS_JSON, SESSION_SECRET
```

Logging an object with `password: "..."` outputs `password: "[Redacted]"`. Add app-specific paths via `extraRedactPaths`:

```ts
import { createLogger } from "@sixthsummit/ship-api/observability/logger";

const customLogger = createLogger({
  extraRedactPaths: ["card.number", "card.cvv", "ssn"],
});
```

Redaction is fail-safe — pino redacts at serialization time, so the in-memory object isn't mutated and the redacted value never reaches stdout.

### Don't `console.log`

Console writes:

- Lose request-id / trace-id correlation.
- Bypass redaction (a `console.log(req.headers)` leaks `Authorization`).
- Don't go through the structured-output pipeline; downstream tooling can't parse them.

The convention is enforced via `.cursor/rules/api.mdc` and surfaced by the ship-reviewer agent on PRs touching framework or module code.

## Metrics

### The exporter

`startMetricsServer()` mounts a Prometheus scrape endpoint on a separate port:

```ts
// In a bootstrapper:
const handle = await startMetricsServer({
  serviceName: env.OTEL_SERVICE_NAME,
  port: env.METRICS_PORT,                    // default 9464 (IANA Prometheus port)
  endpoint: "/metrics",
});
```

A separate port is intentional — your application listener exposes `:3000` to the load balancer; metrics expose `:9464` to your monitoring infrastructure (typically scraped from inside the cluster network). Don't expose `/metrics` on the public listener; it leaks operational data.

Set `METRICS_ENABLED=true` to actually start the server. Default is off so tests don't bind ports.

### Default metrics

`@opentelemetry/auto-instrumentations-node` registers:

- `http_server_request_duration_seconds` — histogram of HTTP request latency, labels: `method`, `route`, `status_code`.
- `http_client_request_duration_seconds` — outgoing HTTP request latency.
- `db_client_connections_usage` — Postgres pool active vs idle.
- `redis_commands_duration_seconds` — Redis command latency.

Histograms use OTel's default exponential bucketing starting at 5ms — fine for most APIs.

### Framework subsystem metrics

The framework adds counters and gauges for its own surfaces:

- `bullmq_queue_waiting`, `bullmq_queue_active`, `bullmq_queue_completed`, `bullmq_queue_failed`
- `ratelimit_decisions_total{decision="allow|deny"}`
- `cache_operations_total{op="get|set|del", result="hit|miss"}`

These come from `getFrameworkMeter(name, version?)` in subsystem init paths.

### Custom metrics

```ts
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("my-app");

const ordersCounter = meter.createCounter("orders_created_total", {
  description: "Total orders created",
});

const orderValueHistogram = meter.createHistogram("order_value_dollars", {
  description: "Order value in dollars",
});

ordersCounter.add(1, { tier: "premium" });
orderValueHistogram.record(99.99, { tier: "premium" });
```

The OTel API is provider-agnostic — the same calls work whether you're on Prometheus, OTLP, or another backend. Switching exporters is a config change, not a code rewrite.

## Correlation in practice

A typical investigation flow:

1. **Alert fires** — error rate elevated on `POST /payments/charge`.
2. **Open APM** — find a slow / failed trace. Note its `trace_id`.
3. **Search logs** — query `trace_id:<that value>`. See every log line from that request, with their `userId`, `requestId`, and the order they fired.
4. **Pull metrics** — graph `http_server_request_duration_seconds{route="/payments/charge"}` to see the rate / latency picture.

Each layer answers a different question. Tracing tells you "what happened on this request, in what order"; logs tell you "what did the code think was happening"; metrics tell you "is this the only request affected, or is the whole route slow."

## Operational concerns

**OTel cost.** Auto-instrumentation has measurable overhead — typically <5% on CPU-bound workloads, more on hot loops. The fs disable is one mitigation; another is selective sampling (10% rate for healthy traffic, 100% for errors via a tail-based sampler).

**Pino async destinations.** By default pino writes synchronously to stdout. Under heavy logging this can become a bottleneck. For very high throughput, configure pino's async transport (writes to a worker thread, batched). The framework doesn't ship this by default — synchronous is simpler and the right choice for normal loads.

**Cardinality kills metrics.** A label with unbounded cardinality (request id, user id, full URL with path params) creates one time-series per value. Prometheus stores those forever. Use bounded labels (status code, tier, region); for high-cardinality investigation, lean on logs and traces instead.

**Forgetting to shutdown.** OTel must flush pending spans / metrics on graceful shutdown. The framework's shutdown manager calls `shutdownOtel()` automatically; if you bypass the framework's lifecycle, call it yourself.

## Source

- [`packages/observability-otel/src/otel.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/observability-otel/src/otel.ts) — `startOtel`, instrumentations
- [`packages/core/src/observability/logger.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/observability/logger.ts) — pino setup, redaction
- [`packages/core/src/observability/metrics.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/observability/metrics.ts) — Prometheus exporter
- [`packages/core/src/observability/tracing.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/observability/tracing.ts) — `withSpan`
- [.cursor/rules/api.mdc](https://github.com/sixthsummit/ship-api/blob/main/.cursor/rules/api.mdc) — the don't-`console.log` rule
