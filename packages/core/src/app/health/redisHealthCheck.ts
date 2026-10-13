import type { RedisProvider } from "../services/RedisProvider.js";
import type { HealthCheck, HealthCheckResult } from "./HealthCheck.js";

/**
 * Built-in health check that pings a `RedisProvider`.
 *
 * Returned by a factory rather than a class so consumers can register it
 * declaratively without a `new`. The `check()` call uses
 * `RedisProvider.ping()`, which never throws — it returns `false` on
 * failure. We surface that as `ok: false` with `error: "ping failed"`.
 */
export function redisHealthCheck(
  provider: RedisProvider,
  opts: { name?: string } = {},
): HealthCheck {
  const name = opts.name ?? "redis";
  return {
    name,
    async check(): Promise<HealthCheckResult> {
      const start = performance.now();
      const ok = await provider.ping();
      const latencyMs = Math.round(performance.now() - start);
      return ok ? { ok: true, latencyMs } : { ok: false, latencyMs, error: "ping failed" };
    },
  };
}
