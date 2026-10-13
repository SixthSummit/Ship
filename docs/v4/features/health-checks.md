# Health checks

> **Compatibility feature:** this registry remains available from the monolithic
> v4 package. The focused scaffold currently declares a normal `system.health`
> operation and projects it through the selected HTTP adapter.

`/livez` vs `/readyz`, the `HealthCheckRegistry`, the routes and database check you get by default, writing custom checks, per-check timeouts, and how to wire the contract into Kubernetes / Cloud Run / ECS probes and uptime monitors.

## Two endpoints, two questions

```
GET /livez   →  is this process alive?            (liveness probe)
GET /readyz  →  is this process ready for traffic? (readiness probe)
```

The distinction matters in orchestrated environments. A liveness failure means *restart*; a readiness failure means *remove from load balancer until recovery*. Confusing the two — using `/readyz` as a liveness probe — causes pods to thrash on transient downstream failures.

`/livez` always returns 200. The process is up; that's the only thing this endpoint claims. Use it as a liveness probe.

`/readyz` runs every registered health check in parallel. Returns 200 if all pass; 503 with a structured body if any fail. Use it as the readiness probe.

## The routes are mounted for you

`createApp()` mounts `GET /livez` and `GET /readyz` by default. There is nothing to wire:

```ts
import { createApp } from "@sixthsummit/ship-api";

const app = createApp({ cors });
// GET /livez and GET /readyz already answer.
```

They are mounted before anything else you register, so they are **unauthenticated** and no consumer middleware added afterwards (`requireAuth`, rate limiting, `httpLogger`, your own `app.use("*", …)`) runs for them. They are also left out of the route registry, so they don't appear in `/dev/routes`, `list_routes` or the generated contract. CORS configured through `createApp({ cors })` does still apply.

By default they read the global `healthCheckRegistry` singleton with a 3-second per-check timeout. Configure them through `createApp`:

```ts
const app = createApp({
  health: {
    registry: customRegistry,           // for tests or multi-tenant deployments
    readyzTimeoutMs: 5_000,             // bump per-check timeout to 5s
    prefix: "/_internal",               // mount at /_internal/livez, /_internal/readyz
  },
});
```

The default mount path is root (`/livez`, `/readyz`) — the convention containers and orchestrators expect.

### Opting out

Pass `health: false` to mount nothing, then wire the routes yourself if you want them somewhere else in the chain:

```ts
import { createApp, registerHealthRoutes } from "@sixthsummit/ship-api";

const app = createApp({ health: false });
app.use("*", myMiddleware);
registerHealthRoutes(app, { prefix: "/_internal" });
```

### Calling `registerHealthRoutes` yourself

Apps written before routes were mounted by default call `registerHealthRoutes(app)` after `createApp()`. That keeps working: on an app that already has the routes, the call mounts nothing and never throws. A `registry` or `readyzTimeoutMs` passed to that call is applied to the routes already mounted, so an app that hands in its own registry keeps its checks. **This late configuration is deprecated**: it logs a warning once per app and will be removed in the next major version. Pass the same options to `createApp({ health: { registry, readyzTimeoutMs } })` instead. A bare `registerHealthRoutes(app)` with no options configures nothing, so it is not deprecated and stays silent. A different `prefix` can't be honoured without mounting a second copy, so it is ignored with a warning — move it to `createApp({ health: { prefix } })`.

If your app defines its own `GET /livez` or `GET /readyz` handler after `createApp()`, the framework's routes are registered first and win; delete yours, or pass `health: false` to keep it.

### No `/healthz`

The framework deliberately does not mount `/healthz`. Google Cloud Run's front end intercepts that path (on both the `run.app` host and custom domain mappings) and answers it itself, so a request for `/healthz` never reaches the container. Point probes and monitors at `/livez` or `/readyz`.

## The response body

`/livez` always answers `200 {"ok": true}`.

`/readyz` answers `200` when every check passes:

```json
{
  "ok": true,
  "checks": [{ "name": "db.primary", "ok": true, "latencyMs": 2 }]
}
```

and `503` when any fails:

```json
{
  "ok": false,
  "checks": [
    { "name": "db.primary", "ok": false, "latencyMs": 41, "error": "unavailable" },
    { "name": "redis", "ok": true, "latencyMs": 1 }
  ]
}
```

Each check reports only `name`, `ok`, `latencyMs` and, on failure, a generic `error`: `"timeout"` when the check exceeded `readyzTimeoutMs`, otherwise `"unavailable"`. The endpoint is public and a database error can name the host, port, user or database, so neither the error message a check throws nor the `error` string it returns ever reaches the body, and neither do a check's `details`. Those stay available to code that calls `healthCheckRegistry.runAll()` directly.

The real failure is logged server-side instead, as one warn-level `Readiness check failed` line per failing `/readyz` evaluation. Each failing check contributes its `name` and `timedOut`, plus one of:

- **A returned failure:** the `error` string the check returned, as `reason`, truncated to 200 characters. You wrote that string, so it is logged. **It must not contain secrets**, connection strings, or a driver's raw error message.
- **A thrown error:** only its `errorCode`, `errorName` and `syscall`, when present. For Postgres that is the SQLSTATE such as `28P01` or `57P01`; for a network failure, a Node code such as `ECONNREFUSED` with the `syscall` that failed (`connect`, `getaddrinfo`). The message is never logged, because a driver can put the host, port, user or database name in it. A thrown string or other non-error value logs nothing beyond `name` and `timedOut`.

```json
{
  "level": "warn",
  "msg": "Readiness check failed",
  "checks": [
    { "name": "db.primary", "timedOut": false, "errorCode": "ECONNREFUSED", "errorName": "Error", "syscall": "connect" },
    { "name": "storage", "timedOut": false, "reason": "bucket not reachable" }
  ]
}
```

If a check needs richer diagnostics, log them from inside the check with values you know are safe.

## The database check you get by default

`createDb()` adds a `db.primary` check to the global registry. It runs `select 1` on the pool `createDb` returns and reports the real round-trip latency, so `/readyz` reflects database reachability with no extra code. Opt out, or rename it:

```ts
createDb({ config, schema, healthCheck: false });                                   // no check
createDb({ config, schema, healthCheck: { name: "db.reporting", registry: mine } }); // custom
```

Pass `healthCheck: false` for secondary pools (migration scripts, a worker's extra pool) that shouldn't gate readiness. The check is also exported as `dbHealthCheck(pool)` from `@sixthsummit/ship-api/app/db/client` if you build pools yourself.

**`dbHealthCheck(pool)` is the recommended database check.** It lets the driver error propagate, so the readiness log gets the SQLSTATE or Node error code and never the message. A hand-written check that catches the error and returns `error: err.message` puts the driver's message, which can name the host, port, user or database, into your logs. Prefer `dbHealthCheck`, or give a hand-written check a fixed `error` string:

```ts
import { dbHealthCheck } from "@sixthsummit/ship-api/app/db/client";

healthCheckRegistry.add(dbHealthCheck(pool, { name: "db.reporting" }));
```

The pool's idle-connection error handler (`handleIdleClientErrors`, attached by `createPool` and `createDb`) logs the same `errorCode` / `errorName` / `syscall` fields and never the message.

### Duplicate check names

A name is registered once; adding a second check with the same name never throws and never runs two checks:

- `createDb`'s check is registered as **replaceable**. If your app then adds its own `db.primary` (apps written before this default did), yours replaces the framework's, quietly (debug log). You end up with exactly one `db.primary`: yours.
- Otherwise **the first registration wins** and the later one is skipped. `add()` returns `false` to tell you. A second `createDb()` is skipped quietly (debug log); two explicit `add()` calls with the same name log a warning, because that is usually a bug.

To register your own check as replaceable, pass `{ replaceable: true }` as `add()`'s second argument.

## Writing a check

```ts
import { healthCheckRegistry } from "@sixthsummit/ship-api";
import type { HealthCheck, HealthCheckResult } from "@sixthsummit/ship-api";

const storageCheck: HealthCheck = {
  name: "storage",
  async check(): Promise<HealthCheckResult> {
    const start = performance.now();
    const reachable = await storage.ping();
    return {
      ok: reachable,
      latencyMs: Math.round(performance.now() - start),
      // Logged by /readyz as `reason` (never sent in the body), so keep it free of secrets.
      error: reachable ? undefined : "storage bucket not reachable",
    };
  },
};

healthCheckRegistry.add(storageCheck);
```

The contract:

```ts
interface HealthCheck {
  readonly name: string;                                    // shown in /readyz response
  check(): Promise<HealthCheckResult> | HealthCheckResult;
}

interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;                                        // duration, even on failure
  error?: string;                                           // /readyz logs it (truncated) and sends a generic value
  details?: Record<string, unknown>;                        // backend-specific info
}
```

A few patterns to know:

**Return or throw — know what gets logged.** Both report the check as failed, and the registry measures `latencyMs` itself around every check, so the latency is kept either way. They differ in what reaches the `/readyz` failure log:

- **Return `{ ok: false, error: "..." }`** when you can describe the failure in your own words. The string is logged as `reason` (truncated to 200 characters), so it must not contain secrets or a driver's raw message.
- **Throw (or let a driver error propagate)** when the error comes from a driver or network call. Only its `code`, `name` and `syscall` are logged, never the message. `dbHealthCheck(pool)` works this way.

**Use a real read, not a connection check.** A pool can have an open connection while Postgres itself is unhealthy. `select 1` actually exercises the connection-server-protocol round trip. For Redis, use `PING`. For S3, use `headBucket`.

**Bound the inner timeout.** The registry enforces `readyzTimeoutMs` per check, but you can bound earlier inside the check itself for clearer error messages.

## Per-check timeout

The registry runs checks in parallel and races each against `readyzTimeoutMs`. A check that exceeds the timeout is reported as failed with `error: "timeout"`:

```json
{
  "ok": false,
  "checks": [
    { "name": "redis", "ok": true, "latencyMs": 42 },
    { "name": "db.primary", "ok": false, "latencyMs": 3000, "error": "timeout" },
    { "name": "s3", "ok": true, "latencyMs": 120 }
  ]
}
```

The default 3-second timeout balances "fast enough for a readiness probe" against "long enough for a healthy backend on a busy day." Override per registration if a particular check legitimately takes longer (e.g., a downstream service with a 5-second SLA).

## Built-in checks

The framework ships factory helpers for common backends:

```ts
import { redisHealthCheck } from "@sixthsummit/ship-api";

healthCheckRegistry.add(redisHealthCheck(redisProvider));
```

Pings Redis with `PING` and returns latency. The database check is added for you by `createDb()` (see above). There is no built-in Firebase check.

You can register additional checks for any external dependency you care about — downstream APIs, S3 buckets, third-party services.

## Platform integration

### Kubernetes

```yaml
livenessProbe:
  httpGet:
    path: /livez
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 2
  periodSeconds: 5
  failureThreshold: 2
  successThreshold: 1
```

`failureThreshold: 3` for liveness means three consecutive failures (30s wall-clock at 10s period) before restart — gives transient blips room to recover. `failureThreshold: 2` for readiness is more aggressive — pulls a pod out fast on degraded health.

Don't use `/readyz` as a liveness probe. A failed downstream (e.g., Postgres restart) takes seconds to recover; using `/readyz` for liveness restarts the pod *while* the underlying issue is recovering, lengthening the outage. `/livez` says "I'm alive"; the pod doesn't need to restart until that lies.

### Cloud Run

Cloud Run uses HTTP-based health checks for readiness:

```yaml
spec:
  containers:
  - name: app
    image: gcr.io/my-project/my-app
    startupProbe:
      httpGet:
        path: /readyz
        port: 3000
      failureThreshold: 30
      periodSeconds: 1
```

No separate liveness probe — Cloud Run handles process restart at the container layer. The startup probe should target `/readyz` so Cloud Run waits for downstream connections before sending traffic.

### ECS / Fargate

```json
{
  "healthCheck": {
    "command": ["CMD-SHELL", "curl -f http://localhost:3000/readyz || exit 1"],
    "interval": 30,
    "timeout": 5,
    "retries": 3,
    "startPeriod": 60
  }
}
```

ECS uses a single health check; pointing it at `/readyz` is the conservative default.

## When `/readyz` returns 503

The structured body tells you what's wrong:

```json
{
  "ok": false,
  "checks": [
    { "name": "db.primary", "ok": false, "latencyMs": 3000, "error": "timeout" },
    { "name": "redis", "ok": true, "latencyMs": 42 }
  ]
}
```

Two things happen in parallel:

1. **The orchestrator removes the pod from the load balancer.** Subsequent requests route to healthy replicas (assuming the issue is local — e.g., this pod's connection to Postgres is wedged).
2. **The framework logs the failure.** Each `/readyz` evaluation that fails emits a warn-level `Readiness check failed` log naming the failing checks with the `reason` they returned or the code of the error they threw (see [The response body](#the-response-body)). Set up an alert on rate (e.g., `sum(rate(http_requests_total{route="/readyz", status="503"}[5m])) > 0`) — sustained `/readyz` 503s mean a real outage; transient blips are noise.

When OpenTelemetry is running, the pino instrumentation adds `trace_id` / `span_id` to that log line, so you can look up the request's span in your APM. Often the slow check has a downstream call you can drill into.

## Custom checks for downstream APIs

```ts
healthCheckRegistry.add({
  name: "api.payments-provider",
  async check() {
    const start = performance.now();
    try {
      const res = await fetch("https://payments.example.com/health", {
        signal: AbortSignal.timeout(2_000),
      });
      return {
        ok: res.ok,
        latencyMs: Math.round(performance.now() - start),
        error: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch {
      // Not the raw message: a returned error is logged.
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        error: "payments health request failed",
      };
    }
  },
});
```

A few cautions on third-party API checks:

- **They count as part of `/readyz`.** If the provider's health endpoint is slow or flaky, your `/readyz` is too. Bound the inner timeout aggressively (2 seconds, not 3).
- **Some teams skip them.** A failing payments provider doesn't necessarily mean *your* service should be removed from the load balancer — your service might be able to serve other endpoints fine, and the right behavior is to fail just the payment endpoints. Decide based on whether the dependency is truly required.

For dependencies that should fail individual endpoints rather than the whole service, throw an error from the route handler (mapped to 503 by the framework's error taxonomy) rather than reflecting downstream state in `/readyz`.

## Operational concerns

**The check budget compounds.** Each check adds latency to `/readyz`. Five checks at 100ms each = 500ms response time *if they're sequential* (they're parallel in this framework, so it's the slowest single check). Still — adding more checks isn't free, and noisy checks (transient failures) cause flapping. Add checks for things that genuinely warrant pulling the pod from the load balancer.

**Test the failure path.** Stop Postgres locally and confirm `/readyz` returns 503 within `readyzTimeoutMs`. A check that doesn't actually fail when the dependency is down is worse than no check.

**External uptime probes are fine at low frequency.** `/readyz` is built for the orchestrator, but a low-frequency external uptime monitor probing it is fine when your checks are cheap. Every request runs every check, so don't hammer it: a probe every few seconds from several regions turns into steady database load, and anything public can be hit by anyone. Keep checks cheap (`select 1`, `PING`), avoid checks that call paid third-party APIs, and put a rate limit or WAF rule in front of the path if it is exposed to the internet. Because the body never carries raw errors, exposing it reveals only check names and latencies.

## Source

- [`packages/core/src/app/health/HealthCheck.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/health/HealthCheck.ts) — registry + types
- [`packages/core/src/http/app/health.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/app/health.ts) — route handlers, timeout enforcement
