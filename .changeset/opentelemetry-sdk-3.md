---
"@sixthsummit/ship-api": minor
"@sixthsummit/ship-observability-otel": minor
"@sixthsummit/ship-drizzle": patch
"@sixthsummit/ship-jobs-bullmq": patch
"@sixthsummit/ship-realtime-socketio": patch
"@sixthsummit/ship-testing": patch
"@sixthsummit/ship-auth-firebase": patch
---

Move to the OpenTelemetry JS 3.x SDK line: `@opentelemetry/api` `^1.10.0`, `core` /
`resources` / `sdk-metrics` `^3.0.0`, `sdk-node` / `exporter-prometheus` `^0.300.0`,
`auto-instrumentations-node` `^0.82.0`. Every package that declares the api now requires
1.10, which the 3.x SDK packages demand as a peer, so a fresh install under strict peer
dependencies resolves cleanly. `@opentelemetry/core` is a regular dependency of
`ship-api` and `ship-observability-otel` so `auto-instrumentations-node`'s peer resolves
inside the framework rather than at the application root.

`startMetricsServer` keeps listening on all interfaces by default: the 0.300 Prometheus
exporter binds to `localhost` when no host is given, so the framework now passes
`0.0.0.0` explicitly unless `host` or `METRICS_HOST` is set. `MetricsServerHandle.host`
is therefore always a string. The exporter no longer reads
`OTEL_EXPORTER_PROMETHEUS_HOST` / `_PORT`; use `METRICS_HOST` / `METRICS_PORT`.

Applications that construct tracer providers directly should import `TracerProvider`
from `@opentelemetry/sdk-trace` (the `sdk-trace-base` / `sdk-trace-node` packages are
retired) and pass span processors an options object, e.g.
`new SimpleSpanProcessor({ exporter })`. The 3.x SDK requires Node.js 22.15 or newer.
