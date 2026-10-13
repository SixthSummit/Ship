import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/**
 * OpenTelemetry SDK initializer for ShipAPI.
 *
 * Call `startOtel()` from a small instrumentation module, then dynamically
 * import the application. A static "first import" in a composition root is
 * insufficient because ESM evaluates all of that root's static dependencies
 * before executing its body.
 *
 * Trace-log correlation works automatically when paired with the framework
 * pino logger: `@opentelemetry/auto-instrumentations-node` includes
 * `@opentelemetry/instrumentation-pino`, which injects `trace_id`,
 * `span_id`, and `trace_flags` into log records when a span is active.
 *
 * In test (`NODE_ENV === "test"`) and when `OTEL_SDK_DISABLED=true`, the
 * SDK is a no-op so unit tests don't open OTLP connections or patch global
 * modules. The OTel API still returns a no-op tracer, so `withSpan(...)`
 * (see `tracing.ts`) keeps working everywhere — there's no need to guard
 * callsites.
 *
 * The exporter follows OTel environment-variable conventions (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, etc.) — `NodeSDK` reads them automatically.
 */

export interface OtelOptions {
  /** `service.name` resource attribute. Required. */
  serviceName: string;
  /** `service.version` resource attribute. Defaults to `"unknown"`. */
  serviceVersion?: string;
  /**
   * `deployment.environment` resource attribute. Falls back to
   * `process.env.ENVIRONMENT_NAME` then `"unknown"`.
   */
  environmentName?: string;
  /**
   * Force-disable. Defaults: true if `NODE_ENV === "test"` or
   * `OTEL_SDK_DISABLED === "true"`.
   */
  disabled?: boolean;
  /**
   * Auto-instrumentation package names to disable
   * (e.g., `["@opentelemetry/instrumentation-fs"]`). `fs` is disabled by
   * default because it floods spans on cold paths.
   */
  disableInstrumentations?: readonly string[];
}

let started = false;
let sdkInstance: NodeSDK | undefined;

export function isOtelDisabledByEnv(): boolean {
  if (process.env.OTEL_SDK_DISABLED === "true") return true;
  if (process.env.NODE_ENV === "test") return true;
  return false;
}

/**
 * Start the OTel SDK. Idempotent — subsequent calls return the existing SDK.
 * Returns `undefined` when disabled (test env or explicit opt-out).
 */
export function startOtel(opts: OtelOptions): NodeSDK | undefined {
  if (started) return sdkInstance;
  if (opts.disabled ?? isOtelDisabledByEnv()) return undefined;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? "unknown",
    "deployment.environment": opts.environmentName ?? process.env.ENVIRONMENT_NAME ?? "unknown",
  });

  const instrumentationConfig: Record<string, { enabled?: boolean }> = {
    "@opentelemetry/instrumentation-fs": { enabled: false },
  };
  for (const name of opts.disableInstrumentations ?? []) {
    instrumentationConfig[name] = { enabled: false };
  }

  const sdk = new NodeSDK({
    resource,
    instrumentations: [getNodeAutoInstrumentations(instrumentationConfig)],
  });

  sdk.start();
  started = true;
  sdkInstance = sdk;
  return sdk;
}

export function getOtelSdk(): NodeSDK | undefined {
  return sdkInstance;
}

/**
 * Shut down the SDK, flushing pending spans / metrics / logs. Called from
 * `ShutdownManager` (graceful shutdown). Safe to call when not started — it's
 * a no-op.
 */
export async function shutdownOtel(): Promise<void> {
  if (!sdkInstance) return;
  await sdkInstance.shutdown();
  sdkInstance = undefined;
  started = false;
}

/** Test-only: reset internal state so tests can re-exercise `startOtel`. */
export function __resetOtelForTests(): void {
  sdkInstance = undefined;
  started = false;
}
