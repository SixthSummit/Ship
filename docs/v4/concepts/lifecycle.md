# App lifecycle and bootstrap

> **Compatibility guide:** this page documents the monolithic bootstrapper graph.
> New operation applications use an immutable compiled application graph and an
> explicit process composition root; no bootstrapper registry is required.

How a ShipAPI app comes up: the order of operations, the priority + `dependsOn` graph that schedules them, the standard bootstrappers the framework ships, and how to add your own.

## The shape of bootstrap

Bootstrap is **deterministic, sequential, and validated**. Each unit of work is a `Bootstrapper` — a named object with a priority (lower runs first), an optional list of `dependsOn` names, and an `init()` function that returns when the work is done. The framework collects all bootstrappers, validates the dependency graph, sorts by priority, and runs them in series; the first failure halts boot with a structured error.

```ts
// packages/core/src/app/lifecycle/Bootstrapper.ts
export interface Bootstrapper {
  readonly name: string;
  readonly priority: number;          // lower runs first; ties by registration order
  readonly dependsOn?: readonly string[];
  init(ctx: BootstrapperContext): Promise<void> | void;
}

export interface BootstrapperContext {
  [key: string]: unknown;             // Mutable bag — earlier bootstrappers populate it
}
```

The orchestration entry point:

```ts
export async function runBootstrappers(
  bootstrappers: readonly Bootstrapper[],
  opts?: RunBootstrappersOptions,
): Promise<BootstrapperContext>;
```

It calls `validateBootstrappers()` first (rejecting duplicates, missing `dependsOn` references, and inverted-priority dependencies), then `sortBootstrappers()` for stable ordering, then runs each `init()` sequentially. The returned `BootstrapperContext` is the populated bag — later code can read it for resources earlier bootstrappers exposed (the database client, the auth provider, the job manager, etc.).

## Why priority *and* `dependsOn`

Either alone is insufficient.

**Priority alone** is fragile. A new bootstrapper at priority 25 between InitFirebaseApp (10) and InitDatabase (20) would slot in cleanly numerically — but if it actually depends on the database, it'd silently break at runtime. The numeric position carries no semantic meaning.

**`dependsOn` alone** loses determinism. When two bootstrappers have no declared relationship, topological sort is free to order them either way, and that ordering can change between Node versions or after an unrelated refactor.

Combining them gives both: priorities express the *intent* (observability before everything; routes after modules); `dependsOn` makes the intent *enforceable*. The validator rejects any graph where a dependency has equal-or-higher priority than its dependent — so the priorities can't drift away from the truth without failing boot.

## Standard priorities

The framework ships a fixed set of bootstrappers with stable, documented priorities:

| Priority | Name | Job |
| ---: | --- | --- |
| 0 | `InitObservability` | Set up pino logger, OpenTelemetry SDK, Prometheus exporter |
| 10 | `InitFirebaseApp` | Initialize the Firebase Admin SDK (skipped if `FIREBASE_CREDENTIALS` is absent) |
| 20 | `InitDatabase` | Open the Drizzle pool, run migrations if configured |
| 30 | `InitRedis` | Connect Redis client (skipped if `REDIS_URL` is absent) |
| 40 | `InitMetricsServer` | Bring up the Prometheus metrics server on `METRICS_PORT` |
| 50 | `InitModules` | Tag-and-register module routes against the route registry |
| 60 | `InitJobs` | Spin up BullMQ workers, register job processors |
| 65 | `InitCron` | Schedule cron repeatables on the BullMQ queues |
| 85 | `InitDevRoutes` | Register `/dev/routes`, `/dev/schema` (development-only) |
| 90 | `InitCustomRoutes` | Hook for app-level routes that need everything else ready |
| 100 | `InitCustomData` | Hook for app-level seed/warmup work |

Health routes are not a bootstrapper. `createApp()` mounts `/livez` and `/readyz` itself, before any other route or middleware, and `createDb()` adds the `db.primary` readiness check — see [Health checks](#health-checks) below. Priority 80 is free.

These are not user-facing constants you reference — they're documented here so when you're adding your own bootstrapper you know where to slot it. The two intentional gaps (between 100 and the canonical points) leave room for app-level work.

## Adding a custom bootstrapper

A typical app-level use case: warm a Redis-backed cache before serving traffic.

```ts
import type { Bootstrapper, BootstrapperContext } from "@sixthsummit/ship-api";

export const WarmFeatureFlagsCache: Bootstrapper = {
  name: "WarmFeatureFlagsCache",
  priority: 100,                      // After everything; before serving
  dependsOn: ["InitRedis", "InitDatabase"],
  async init(ctx: BootstrapperContext) {
    const redis = ctx.redis as Redis;
    const db = ctx.db as ShipDb;
    const flags = await db.select().from(featureFlags);
    await redis.mset(Object.fromEntries(flags.map((f) => [`ff:${f.key}`, JSON.stringify(f)])));
  },
};
```

Two things to notice:

- **The `dependsOn` array names other bootstrappers.** The validator catches typos at boot — a misspelled name fails validation with a clear error before any work runs.
- **The context bag is mutable but conventional.** Earlier bootstrappers attach their resources (`ctx.redis`, `ctx.db`, `ctx.provider`) by stable keys; later bootstrappers read them. The framework documents which keys it sets at each priority.

Pass your bootstrapper into `createApp()` (or the framework's bootstrap entry point — depending on how your composition root is structured):

```ts
const app = createApp({
  schema,
  bootstrappers: [WarmFeatureFlagsCache],
});
```

## Health checks

`HealthCheckRegistry` is the live registry of readiness checks behind `/readyz`. `createApp()` mounts `/livez` and `/readyz` by default (opt out with `createApp({ health: false })`), and `createDb()` registers a `db.primary` check that runs `select 1` on its pool (opt out with `createDb({ ..., healthCheck: false })`). Redis is not checked unless you add `redisHealthCheck(provider)`. You can register your own:

```ts
import { healthCheckRegistry } from "@sixthsummit/ship-api";

healthCheckRegistry.add({
  name: "FeatureFlagsCache",
  async check() {
    const start = Date.now();
    try {
      await redis.ping();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: String(err) };
    }
  },
});
```

The contract for a check:

```ts
export interface HealthCheck {
  readonly name: string;
  check(): Promise<HealthCheckResult> | HealthCheckResult;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  details?: Record<string, unknown>;
}
```

`/livez` always returns 200 — its job is to tell the platform "the process is up." `/readyz` runs `healthCheckRegistry.runAll()` and returns 200 if all pass, 503 if any fail, with each check's name, status and latency and a generic `"timeout"` / `"unavailable"` error (never the raw error text). **This is the endpoint your load balancer should probe.** Per-check timeout defaults to 3 seconds. See [health checks](../features/health-checks.md) for the full contract, including duplicate check names and why there is no `/healthz`.

## What runs at request time

Once boot completes, every request flows through:

1. **`httpLogger()` middleware** — generates / reads `X-Request-ID`, attaches a request-scoped logger to `c.var.logger`.
2. **`requireAuth({ provider })` middleware** — verifies the credential (provider-specific), resolves the account, sets `c.var.user` + `c.var.claims`. See [authentication](authentication.md).
3. **`requirePermission(slug)` middleware** — reads `c.var.user`, checks `hasPermission(slug)`, throws `AuthorizationError` on failure. See [permissions](permissions.md).
4. **`validate(target, schema)` middleware** — runs Zod validation, throws `ValidationError` on failure. The validated value is read via `c.req.valid(target)`. See [routes-and-validation](routes-and-validation.md).
5. **The handler** — your business logic. Throws `AppError` subclasses on failure; never shapes error JSON itself.
6. **`registerErrorHandlers(app)`** — catches everything thrown, maps `AppError` subclasses to status codes + JSON bodies, logs unhandled errors. See [errors](errors.md).

This chain runs identically for direct HTTP requests *and* for `execute_route` calls from the Claude plugin's MCP server. That's the load-bearing property: agents iterating against the framework see the same behavior production sees.

## Shutdown

The framework registers SIGINT and SIGTERM handlers that drain in reverse-priority order: stop accepting new HTTP, wait for in-flight handlers (with a configurable grace period), drain BullMQ workers (let in-flight jobs finish; reject new ones), close the database pool, close Redis, flush the OTel exporter, exit. The grace period default is 30 seconds; override via `SHUTDOWN_GRACE_MS`.

If you're running on a platform that sends SIGTERM with a fixed grace (Kubernetes, Cloud Run, ECS), match `SHUTDOWN_GRACE_MS` to slightly less than the platform's grace period — that way the framework finishes cleanly before the platform force-kills the process.

## Source

- [`packages/core/src/app/lifecycle/Bootstrapper.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/lifecycle/Bootstrapper.ts) — the interface, validator, sort, and runner
- [`packages/core/src/app/health/HealthCheck.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/health/HealthCheck.ts) — the registry and check contract
- [`packages/core/src/observability/`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/observability/) — `InitObservability` and the OTel + pino + Prometheus wiring it does
