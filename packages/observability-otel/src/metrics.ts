import { type Meter, metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/**
 * Prometheus metrics exporter for ShipAPI.
 *
 * Runs an independent HTTP server (default port 9464, the IANA-registered
 * Prometheus exposition port) on a separate listener from the main app —
 * scrape targets stay isolated from public traffic and you can firewall
 * the metrics port to your monitoring network.
 *
 * Opt-in via `METRICS_ENABLED=true`. Disabled by default so unit tests
 * and local dev never bind a port unexpectedly. When `NODE_ENV === "test"`
 * it is unconditionally disabled — tests that exercise the wiring pass
 * `disabled: false` explicitly (and use `preventServerStart` to avoid
 * binding a real port; see `metrics.test.ts`).
 *
 * The exporter is wired as the global MeterProvider via
 * `metrics.setGlobalMeterProvider(...)` so any code (framework or
 * consumer) that calls `metrics.getMeter("name").createCounter(...)`
 * automatically routes through it. Auto-instrumentations from
 * `@opentelemetry/auto-instrumentations-node` (HTTP, pg, ioredis, …) feed
 * the same provider — so the default Prometheus output includes their
 * series with no extra wiring once `startMetricsServer` runs.
 *
 * The framework's own meters (BullMQ queue depth, rate-limit rejections,
 * cache hit/miss, db pool gauges) attach via `getFrameworkMeter()` from
 * their respective subsystems' init paths. Those callsites land alongside
 * `App.ts` integration in a later batch — this module ships the primitive
 * + global wiring; the subsystem-meter call sites are pure additions on
 * top of it.
 */

export interface MetricsServerOptions {
  /** `service.name` resource attribute. Required. */
  serviceName: string;
  /** `service.version` resource attribute. Defaults to `"unknown"`. */
  serviceVersion?: string;
  /**
   * `deployment.environment` resource attribute. Falls back to
   * `process.env.ENVIRONMENT_NAME` then `"unknown"`.
   */
  environmentName?: string;
  /** Listen port. Defaults: `process.env.METRICS_PORT` then `9464`. */
  port?: number;
  /**
   * Listen host. Defaults: `process.env.METRICS_HOST` then `0.0.0.0`
   * (all interfaces, so a monitoring network can scrape the port). Pass
   * `"127.0.0.1"` / `"localhost"` to restrict scrapes to the local host.
   */
  host?: string;
  /** HTTP endpoint path. Defaults `/metrics`. */
  endpoint?: string;
  /**
   * Force-disable. Defaults: `true` if `NODE_ENV === "test"` or
   * `METRICS_ENABLED !== "true"`. Pass `false` to override env gating
   * (e.g. tests exercising the integration path).
   */
  disabled?: boolean;
  /**
   * Don't start the embedded HTTP server. Use this when you want the
   * MeterProvider wired (counters can be incremented; auto-instrumentations
   * register against the global) but you'll scrape via
   * `exporter.getMetricsRequestHandler(req, res)` from your own server —
   * or in tests, to assert behavior without binding a port.
   */
  preventServerStart?: boolean;
  /**
   * Constant labels (Prometheus terminology) derived from resource
   * attributes — e.g. `/^service\./` exposes `service_name` /
   * `service_version` as labels on every series. Off by default;
   * resource info is exposed via the `target_info` series instead per
   * Prometheus conventions.
   */
  withResourceConstantLabels?: RegExp;
}

export interface MetricsServerHandle {
  meterProvider: MeterProvider;
  exporter: PrometheusExporter;
  /** Resolved port the exporter bound to (or would bind to). */
  port: number;
  /** Resolved host the exporter binds to (`0.0.0.0` = all interfaces). */
  host: string;
  /** Resolved endpoint path. */
  endpoint: string;
}

const DEFAULT_PORT = 9464;
// `@opentelemetry/exporter-prometheus` >= 0.300 binds to `localhost` when no
// host is given. Ship's contract has always been "all interfaces unless told
// otherwise" (the port is meant to be scraped by a monitoring network and
// firewalled there), so the default is made explicit instead of inherited.
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_ENDPOINT = "/metrics";

let started = false;
let providerInstance: MeterProvider | undefined;
let handleInstance: MetricsServerHandle | undefined;

export function isMetricsDisabledByEnv(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.METRICS_ENABLED !== "true") return true;
  return false;
}

function resolvePort(opt?: number): number {
  if (typeof opt === "number") return opt;
  const envValue = process.env.METRICS_PORT;
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_PORT;
}

function resolveHost(opt?: string): string {
  return opt ?? process.env.METRICS_HOST ?? DEFAULT_HOST;
}

/**
 * Start the Prometheus exporter and register its MeterProvider as the
 * OTel global. Idempotent — subsequent calls return the existing handle.
 * Resolves to `undefined` when env-disabled (test default).
 *
 * The returned promise resolves *after* the embedded HTTP server is
 * listening (or immediately, when `preventServerStart: true`). Failure
 * to bind the port rejects the promise — boot should fail loudly rather
 * than silently lose metrics.
 */
export async function startMetricsServer(
  opts: MetricsServerOptions,
): Promise<MetricsServerHandle | undefined> {
  if (started && handleInstance) return handleInstance;
  if (opts.disabled ?? isMetricsDisabledByEnv()) return undefined;

  const port = resolvePort(opts.port);
  const host = resolveHost(opts.host);
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;

  const exporter = await new Promise<PrometheusExporter>((resolve, reject) => {
    const instance = new PrometheusExporter(
      {
        port,
        host,
        endpoint,
        preventServerStart: opts.preventServerStart,
        withResourceConstantLabels: opts.withResourceConstantLabels,
      },
      (err) => {
        if (err) reject(err);
        else resolve(instance);
      },
    );
    if (opts.preventServerStart) resolve(instance);
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? "unknown",
    "deployment.environment": opts.environmentName ?? process.env.ENVIRONMENT_NAME ?? "unknown",
  });

  const provider = new MeterProvider({
    resource,
    readers: [exporter],
  });

  metrics.setGlobalMeterProvider(provider);

  providerInstance = provider;
  handleInstance = { meterProvider: provider, exporter, port, host, endpoint };
  started = true;

  return handleInstance;
}

export function getMetricsServerHandle(): MetricsServerHandle | undefined {
  return handleInstance;
}

/**
 * Convenience accessor for framework subsystems. Returns a `Meter` from
 * whatever MeterProvider is currently global — ours when
 * `startMetricsServer` ran, OTel's no-op meter otherwise (so call sites
 * stay safe to invoke unconditionally).
 */
export function getFrameworkMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}

/**
 * Stop the exporter's HTTP server and shut down the MeterProvider,
 * flushing any buffered series. Safe to call when never started — no-op.
 */
export async function shutdownMetricsServer(): Promise<void> {
  if (!providerInstance) return;
  await providerInstance.shutdown();
  providerInstance = undefined;
  handleInstance = undefined;
  started = false;
}

/** Test-only: reset internal state so tests can re-exercise startup. */
export function __resetMetricsForTests(): void {
  providerInstance = undefined;
  handleInstance = undefined;
  started = false;
}
