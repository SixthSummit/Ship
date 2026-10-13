---
name: ship-otel-debugging
description: Use when debugging request latency, error rates, or distributed-trace correlation in a ShipAPI v4 codebase — user mentions OpenTelemetry, OTel, traces, spans, request-id, latency, slow request, or asks to trace through a request flow. Loads the trace-log correlation pattern, the per-subsystem span hierarchy, and the metrics surface (Prometheus exporter on a separate port).
---

# ShipAPI v4 — OpenTelemetry + observability

> **Source**: alpha-1 plan §D (observability) and the canonical implementations at `packages/core/src/observability/{logger,otel,tracing,metrics}.ts`.

## Trace-log correlation (the load-bearing property)

Every log line emitted via the framework's pino logger automatically carries `trace_id`, `span_id`, and `trace_flags` when a span is active. This is wired by `@opentelemetry/instrumentation-pino` (included in the auto-instrumentations bundle). Result: when you grep for a specific log line in your log backend, you can pivot to the trace in your trace backend without manual correlation.

The key invariant: **always log via the framework `logger` (or a child logger), never `console.*`**. console writes lose the trace context.

## Span hierarchy

A typical request through a v4 module produces this span tree:

```
http.request POST /xxx                          ← OTel auto-instrumented HTTP server span
├── http.middleware.requireAuth                 ← (manual span, in the middleware)
├── http.middleware.requirePermission           ← (manual span)
├── service.xxx.create                          ← DrizzleEntityService.spanName().create
│   ├── db.transaction                          ← withTransaction wrapper
│   │   └── pg.query INSERT INTO ...            ← OTel auto-instrumented pg span
│   └── job.xxx.queue.enqueue                   ← BullMQ producer span (when applicable)
└── (response shaping)
```

Manual spans live inside service methods via `withSpan(name, fn)`:

```ts
import { withSpan } from "@sixthsummit/ship-api/observability/tracing";

async function expensiveOp() {
  return withSpan("xxx.expensive-op", async () => {
    // …
  });
}
```

Span names are dot-namespaced. The framework convention: `<subsystem>.<operation>` — `http.request`, `service.<name>.<op>`, `db.transaction`, `job.<queue>.<name>`, `cron.<name>`, `llm.stream`.

## Request id propagation

`httpLogger` middleware sets a per-request `requestId` (from `X-Request-Id` header if present, else fresh uuid) into `RequestContext` (an AsyncLocalStorage). Every downstream log + span attribute carries it. Consumers see the same id in their request logs, the trace, and the response's `X-Request-Id` header — three places to pivot on a single correlation key.

## Health endpoints

`createApp()` mounts both by default, unauthenticated and ahead of all consumer middleware (`createApp({ health: false })` opts out). There is no `/healthz` — Cloud Run's front end intercepts it.

- `GET /livez` — process up. Always 200. Used by orchestrator restart triggers.
- `GET /readyz` — runs every registered HealthCheck. 200 with `{ ok, checks: [{ name, ok, latencyMs }] }` when all pass; 503 with the same shape plus a generic `error` (`"timeout"` or `"unavailable"`) on failed checks. Raw error text never reaches the body. Failures are logged as a warn-level `Readiness check failed` line: a returned `error` string appears as `reason` (truncated to 200 chars), a thrown error only as `errorCode` / `errorName` / `syscall`. Used by load balancers to admit/drain pods and by low-frequency uptime monitors.

Built-in checks: `createDb()` registers `db.primary` (`select 1`; `healthCheck: false` opts out); `redisHealthCheck(provider)` is added by hand. Module / consumer code adds checks via `healthCheckRegistry.add(check)`; a duplicate name never throws — the first wins, except that a consumer check replaces `createDb`'s default.

## Metrics

`startMetricsServer({ serviceName, ... })` runs an independent Prometheus exposition server on `METRICS_PORT` (default 9464). Opt-in via `METRICS_ENABLED=true`. Disabled by default in tests + dev.

Default metric series:

- HTTP: `http_server_request_duration_milliseconds` (histogram), `http_server_active_requests` (gauge)
- DB pool: `db_pool_active`, `db_pool_idle`, `db_pool_waiting`
- BullMQ: `jobs_processed_total{queue, name, status}`, `bullmq_queue_depth{queue, state}`
- Rate limit: `rate_limit_rejections_total`, `redis_availability` counter
- Cache: `cache_operations_total{result}` (hit / miss / error)
- Cron: `cron_runs_total{name, result}`

Framework subsystems register via `getFrameworkMeter(name).createCounter(...)` / `createHistogram(...)`. The meter routes through the global MeterProvider that `startMetricsServer` registers.

## Common debugging flows

### Slow request

1. Find the request in your log backend by `path` / `userId` / `correlationId`.
2. Pull the `trace_id` from any of the request's log lines.
3. Pivot to your trace backend, view the full span tree.
4. Look for the longest-duration span — typically `pg.query` or an external `http.client` span.

### Failed request

1. Find the error log via `level: 50` filter + `path:/xxx`.
2. Pull `trace_id` and `requestId` from the log entry.
3. Trace shows where the error originated (which middleware / service / db call).
4. Cross-reference `requestId` in the response headers if the user is reporting it from the client side.

### Worker job stuck

1. Check `bullmq_queue_depth{state="active"}` — if > 0 for a long time, a worker has a hung processor.
2. Find the job's span: `job.<queue>.<name>` filtered by `jobId`.
3. The span's duration tells you what the processor is doing; child spans (db queries, http calls) localize the hang.

### Rate-limit rejection

1. `rate_limit_rejections_total` counter incrementing → who's getting limited.
2. The rate-limit middleware logs each rejection at `level: 30 (warn)` with `route` + `key` (caller-defined; typically userId or IP).

## Disabling for tests

`OTEL_SDK_DISABLED=true` disables the OTel SDK entirely — the global API still returns no-op tracers/meters so framework code keeps working. The framework auto-disables when `NODE_ENV === "test"`. Same defaults for `METRICS_ENABLED`.

## Don't

- Don't add manual `console.log` for debugging — they lose trace context. Use a child logger temporarily; remove before commit.
- Don't `setSpan(...)` manually outside `withSpan` — the framework's wrapper handles span lifecycle correctly. Direct OTel API use is allowed but rarely needed.
- Don't rely on metrics being enabled in dev — they're opt-in for a reason (port-binding, cardinality control). For local debugging use the trace pivot, not the metrics scrape.
