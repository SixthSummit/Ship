import type { Hono } from "hono";
import {
  healthCheckRegistry as defaultRegistry,
  type HealthCheckFailure,
  type HealthCheckRegistry,
} from "../../app/health/HealthCheck.js";
import { logger } from "../../observability/logger.js";
import { safeErrorFields } from "../../observability/safeErrorFields.js";

/** Longest returned `error` string copied into the readiness failure log. */
const MAX_LOGGED_REASON_LENGTH = 200;

/**
 * `registerHealthRoutes(app, opts?)` — wires `/livez` and `/readyz`.
 *
 * `createApp()` calls this for you (opt out with `createApp({ health: false })`),
 * so most apps never call it directly. Calling it on an app that already has
 * the routes mounts nothing (see below).
 *
 * - `GET /livez` always 200 with `{ ok: true }`. Process up. Used by the
 *   orchestrator's restart trigger.
 * - `GET /readyz` runs every check in the registry. 200 with
 *   `{ ok: true, checks: [{ name, ok, latencyMs }] }` when all pass; 503 with
 *   the same shape (and `ok: false` plus a generic per-check `error` of
 *   `"timeout"` or `"unavailable"`) when any fail. The raw error never reaches
 *   the response body — the endpoint is unauthenticated and database errors
 *   can name hosts and users. Failures are logged server-side at warn level
 *   with the check name, the `error` string a check returned (as `reason`,
 *   truncated), and for a thrown error its `code` / `name` / `syscall` only.
 *
 * There is deliberately no `/healthz`: Google Cloud Run's front end intercepts
 * that path and it never reaches the container.
 *
 * Replaces v3's `InitHealthCheckRoute` + `InitWarmupCheckRoute`. The
 * dual-endpoint pattern is the Kubernetes / GCP / Fly convention.
 */

export interface RegisterHealthRoutesOptions {
  /**
   * Registry to query. Defaults to the framework-wide singleton — modules
   * register their checks against it via `healthCheckRegistry.add(...)`.
   */
  registry?: HealthCheckRegistry;
  /** Override the per-check timeout used by `/readyz`. Default 3_000 ms. */
  readyzTimeoutMs?: number;
  /** Mount path prefix. Default `""` (routes mount at `/livez` + `/readyz`). */
  prefix?: string;
}

/** One entry of the public `/readyz` body. */
export interface ReadyzCheck {
  name: string;
  ok: boolean;
  latencyMs: number;
  /** Present only when `ok` is false. Never the raw error text. */
  error?: "timeout" | "unavailable";
}

export interface ReadyzBody {
  ok: boolean;
  checks: ReadyzCheck[];
}

/** Live configuration of the routes mounted on one app; the handlers read it per request. */
interface MountedHealthRoutes {
  registry: HealthCheckRegistry;
  timeoutMs: number | undefined;
  prefix: string;
  /** Whether the late-configuration deprecation warning has been logged for this app. */
  deprecationWarned?: boolean;
}

/** Apps that already have the health routes mounted, keyed by app instance. */
const mountedHealthRoutes = new WeakMap<object, MountedHealthRoutes>();

/** Whether `/livez` + `/readyz` are already mounted on this app instance. */
export function hasHealthRoutes(app: object): boolean {
  return mountedHealthRoutes.has(app);
}

/**
 * Mount `/livez` + `/readyz` on `app`, once per app instance.
 *
 * On an app that already has them (every `createApp()` app unless it passed
 * `health: false`), this never mounts a second copy and never throws. A
 * `registry` or `readyzTimeoutMs` passed to the later call is applied to the
 * routes already mounted, so an app that wires its own registry this way keeps
 * the readiness checks it had before `createApp` mounted the routes. That late
 * configuration is deprecated: it logs a warning once per app, and will be
 * removed in the next major version — pass it to `createApp({ health })`. A
 * different `prefix` cannot be honoured without mounting again; it is ignored
 * with a warning (configure it with `createApp({ health: { prefix } })`).
 */
export function registerHealthRoutes(app: Hono, opts: RegisterHealthRoutesOptions = {}): void {
  const existing = mountedHealthRoutes.get(app);
  if (existing) {
    applyToMountedRoutes(existing, opts);
    return;
  }

  const state: MountedHealthRoutes = {
    registry: opts.registry ?? defaultRegistry,
    timeoutMs: opts.readyzTimeoutMs,
    prefix: opts.prefix ?? "",
  };

  app.get(`${state.prefix}/livez`, (c) => c.json({ ok: true }, 200));

  app.get(`${state.prefix}/readyz`, async (c) => {
    const failures: HealthCheckFailure[] = [];
    const result = await state.registry.runAll({
      timeoutMs: state.timeoutMs,
      onCheckFailure: (failure) => failures.push(failure),
    });

    if (!result.ok) {
      logger.warn({ checks: failures.map(describeFailure) }, "Readiness check failed");
    }

    const timedOut = new Set(failures.filter((f) => f.timedOut).map((f) => f.name));
    const body: ReadyzBody = {
      ok: result.ok,
      checks: result.checks.map((check) =>
        check.ok
          ? { name: check.name, ok: true, latencyMs: check.latencyMs }
          : {
              name: check.name,
              ok: false,
              latencyMs: check.latencyMs,
              error: timedOut.has(check.name) ? "timeout" : "unavailable",
            },
      ),
    };
    return c.json(body, result.ok ? 200 : 503);
  });

  mountedHealthRoutes.set(app, state);
}

function applyToMountedRoutes(state: MountedHealthRoutes, opts: RegisterHealthRoutesOptions): void {
  const updated: string[] = [];
  if (opts.registry !== undefined && opts.registry !== state.registry) {
    state.registry = opts.registry;
    updated.push("registry");
  }
  if (opts.readyzTimeoutMs !== undefined && opts.readyzTimeoutMs !== state.timeoutMs) {
    state.timeoutMs = opts.readyzTimeoutMs;
    updated.push("readyzTimeoutMs");
  }
  if (opts.prefix !== undefined && opts.prefix !== state.prefix) {
    logger.warn(
      { mountedPrefix: state.prefix, ignoredPrefix: opts.prefix },
      "registerHealthRoutes: health routes are already mounted on this app (createApp mounts them by default); " +
        "the prefix is ignored. Configure it with createApp({ health: { prefix } }) instead",
    );
  }
  if (updated.length > 0 && !state.deprecationWarned) {
    state.deprecationWarned = true;
    logger.warn(
      { updated },
      "registerHealthRoutes: configuring health routes after createApp is deprecated and will be removed " +
        "in the next major version. Pass these options to createApp({ health: { ... } }) instead",
    );
  }
  logger.debug(
    { updated },
    "registerHealthRoutes: health routes are already mounted on this app; not mounting them again",
  );
}

/**
 * Log-safe summary of a failed check.
 *
 * - A check that *returned* `{ ok: false, error }` wrote that string itself, so
 *   it is logged as `reason`, truncated to {@link MAX_LOGGED_REASON_LENGTH}
 *   characters. App authors must keep secrets out of it (documented).
 * - A *thrown* error keeps only its `code`, `name` and `syscall` — never the
 *   message, which for database and network errors can contain the host,
 *   port, user or database name.
 */
function describeFailure(failure: HealthCheckFailure): Record<string, unknown> {
  const summary: Record<string, unknown> = { name: failure.name, timedOut: failure.timedOut };
  if (failure.reason !== undefined) {
    summary.reason = truncate(failure.reason, MAX_LOGGED_REASON_LENGTH);
    return summary;
  }
  return { ...summary, ...safeErrorFields(failure.error) };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
