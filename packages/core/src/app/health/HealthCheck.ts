/**
 * Pluggable health-check primitive.
 *
 * The framework exposes two HTTP endpoints (`/livez` and `/readyz`) backed
 * by a `HealthCheckRegistry`:
 *
 *   - `/livez` — process is up. Always 200 with no checks. Used by load
 *     balancers / orchestrators to decide "should I restart this pod?"
 *   - `/readyz` — runs every registered check. 200 if all pass; 503 with
 *     a structured `{ checks: [...] }` body otherwise. Used to decide
 *     "should I send traffic to this pod?"
 *
 * `createApp()` mounts both routes by default (see `http/app/health.ts`).
 * Modules / consumer code register checks via `healthCheckRegistry.add(...)`.
 * Built-in checks: `createDb()` registers a `db.primary` check on its pool by
 * default; `redisHealthCheck(provider)` is a factory you add yourself.
 *
 * Duplicate names: the first registration of a name wins and later ones are
 * skipped (logged), except that a check added with `{ replaceable: true }`
 * (what framework defaults such as `createDb`'s `db.primary` use) gives way
 * to a later explicit registration of the same name. So a consumer that
 * registers its own `db.primary` after `createDb()` gets exactly one check:
 * its own.
 */

import { logger } from "../../observability/logger.js";

export interface HealthCheckResult {
  ok: boolean;
  /** Latency of the check itself, ms. */
  latencyMs: number;
  /**
   * Free-form error message when ok=false. `/readyz` never sends it, but logs
   * it server-side (truncated), so it must not contain secrets.
   */
  error?: string;
  /** Adapter-specific extras (versions, replication lag, etc.). */
  details?: Record<string, unknown>;
}

export interface HealthCheck {
  /** Stable name reported in the readyz response (e.g., `"redis"`, `"db.primary"`). */
  readonly name: string;
  /**
   * Run the check. Should return within a few seconds; timeouts are the
   * registry's responsibility (see `runAll`'s `timeoutMs`).
   */
  check(): Promise<HealthCheckResult> | HealthCheckResult;
}

export interface AddHealthCheckOptions {
  /**
   * Mark this check as a default that a later `add()` of the same name may
   * replace. Framework-registered checks (`createDb`'s `db.primary`) use
   * this so a consumer's own check of that name takes over instead of being
   * skipped. Default `false`.
   */
  replaceable?: boolean;
}

/** One failed check, as reported to `RunAllOptions.onCheckFailure`. */
export interface HealthCheckFailure {
  name: string;
  /** The thrown value, or the `error` string the check returned (may be `undefined`). */
  error: unknown;
  /**
   * The `error` string the check *returned* with `ok: false`. Absent when the
   * check threw, timed out, or returned no string. Unlike a thrown error's
   * message, this text was written by the app author, so `/readyz` logs it.
   */
  reason?: string;
  /** `true` when the check was cut off by the registry's per-check timeout. */
  timedOut: boolean;
}

export interface RunAllOptions {
  /**
   * Per-check timeout in milliseconds. Default 3_000 (3 s). Checks that
   * exceed this are reported as failed with `error: "timeout"`.
   */
  timeoutMs?: number;
  /**
   * Called once per failed check with the raw error, before `runAll`
   * resolves. `/readyz` uses it to log failures server-side while keeping
   * the raw error out of the public response body. Exceptions thrown by the
   * callback are swallowed.
   */
  onCheckFailure?: (failure: HealthCheckFailure) => void;
}

export interface RunAllResult {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    latencyMs: number;
    error?: string;
    details?: Record<string, unknown>;
  }>;
}

/**
 * Container for registered checks. One framework-wide singleton (below);
 * tests construct their own via `new HealthCheckRegistry()`.
 */
export class HealthCheckRegistry {
  private checks: HealthCheck[] = [];
  private replaceable = new Set<HealthCheck>();

  /**
   * Register a check. Returns `true` when the check is now registered,
   * `false` when it was skipped because a check of that name already exists.
   *
   * Duplicate names never throw and never run twice:
   *   - existing check is `replaceable` and the new one is not → the new
   *     check replaces it (debug log);
   *   - otherwise the existing check wins and the new one is skipped (debug
   *     log when either side is `replaceable`, warn log when both are
   *     explicit registrations, since that is usually a consumer bug).
   */
  add(check: HealthCheck, opts: AddHealthCheckOptions = {}): boolean {
    const index = this.checks.findIndex((c) => c.name === check.name);
    if (index === -1) {
      this.checks.push(check);
      if (opts.replaceable) this.replaceable.add(check);
      return true;
    }

    const existing = this.checks[index];
    const existingReplaceable = this.replaceable.has(existing);
    if (existingReplaceable && !opts.replaceable) {
      this.replaceable.delete(existing);
      this.checks[index] = check;
      logger.debug(
        { check: check.name },
        "Health check replaced the framework default registered under the same name",
      );
      return true;
    }

    const message = "Health check with this name is already registered; keeping the first one";
    if (existingReplaceable || opts.replaceable) logger.debug({ check: check.name }, message);
    else logger.warn({ check: check.name }, message);
    return false;
  }

  /** Test / admin helper. */
  remove(name: string): boolean {
    const before = this.checks.length;
    this.checks = this.checks.filter((c) => {
      if (c.name !== name) return true;
      this.replaceable.delete(c);
      return false;
    });
    return this.checks.length < before;
  }

  list(): readonly HealthCheck[] {
    return [...this.checks];
  }

  size(): number {
    return this.checks.length;
  }

  clear(): void {
    this.checks = [];
    this.replaceable.clear();
  }

  async runAll(opts: RunAllOptions = {}): Promise<RunAllResult> {
    const timeoutMs = opts.timeoutMs ?? 3_000;
    const reportFailure = (failure: HealthCheckFailure): void => {
      try {
        opts.onCheckFailure?.(failure);
      } catch {
        // A logging callback must never break readiness reporting.
      }
    };

    const results = await Promise.all(
      this.checks.map(async (check) => {
        const start = performance.now();
        let ok = true;
        let error: string | undefined;
        let details: Record<string, unknown> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = Symbol("timeout");

        try {
          const result = await Promise.race([
            Promise.resolve(check.check()),
            new Promise<typeof timedOut>((resolve) => {
              timer = setTimeout(() => resolve(timedOut), timeoutMs);
            }),
          ]);
          if (result === timedOut) {
            ok = false;
            error = "timeout";
            reportFailure({ name: check.name, error: new Error("timeout"), timedOut: true });
          } else {
            ok = result.ok;
            error = result.error;
            details = result.details;
            if (!ok) {
              reportFailure({
                name: check.name,
                error: result.error,
                timedOut: false,
                ...(typeof result.error === "string" ? { reason: result.error } : {}),
              });
            }
          }
        } catch (err) {
          ok = false;
          error = err instanceof Error ? err.message : String(err);
          reportFailure({ name: check.name, error: err, timedOut: false });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }

        const latencyMs = Math.round(performance.now() - start);
        return { name: check.name, ok, latencyMs, error, details };
      }),
    );

    return {
      ok: results.every((r) => r.ok),
      checks: results,
    };
  }
}

/** Framework-wide registry. Bootstrappers / modules add checks here. */
export const healthCheckRegistry = new HealthCheckRegistry();
