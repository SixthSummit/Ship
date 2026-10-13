import type { Meter } from "@opentelemetry/api";
import type {
  WebhookDispatchEvent,
  WebhookObserver,
  WebhookReceiptEvent,
} from "@sixthsummit/ship-core";
import { getFrameworkMeter } from "./metrics.js";

/**
 * OpenTelemetry metrics for inbound webhook operations. Pass the returned
 * observer to `createHonoAdapter({ webhooks: { observer } })` and to
 * `webhookIntent({ observer })`.
 *
 * Instruments (all carry `ship.webhook.id` and `ship.webhook.provider`):
 *
 * - `ship.webhook.received` counter with `ship.webhook.outcome` and
 *   `http.response.status_code`: receive rate; `outcome=rejected` with
 *   `ship.webhook.reason` gives the verification-failure rate and
 *   `outcome=duplicate` the duplicate rate.
 * - `ship.webhook.receive.duration` histogram (ms) from first byte to response.
 * - `ship.webhook.dispatch.lag` histogram (ms) from durable receipt to the
 *   outbox dispatcher performing the intent.
 *
 * Attributes never include headers, bodies or secrets.
 */
export interface WebhookMetricsOptions {
  /** Defaults to the framework meter `@sixthsummit/ship-webhooks`. */
  readonly meter?: Meter;
}

export const WEBHOOK_METER_NAME = "@sixthsummit/ship-webhooks";

export function createWebhookMetrics(options: WebhookMetricsOptions = {}): WebhookObserver {
  const meter = options.meter ?? getFrameworkMeter(WEBHOOK_METER_NAME);
  const received = meter.createCounter("ship.webhook.received", {
    description: "Inbound webhook deliveries by outcome",
    unit: "{delivery}",
  });
  const duration = meter.createHistogram("ship.webhook.receive.duration", {
    description: "Time from bounded body read to response",
    unit: "ms",
  });
  const lag = meter.createHistogram("ship.webhook.dispatch.lag", {
    description: "Time from durable receipt to outbox dispatch",
    unit: "ms",
  });

  return Object.freeze({
    received: (event: WebhookReceiptEvent) => {
      const attributes = {
        "ship.webhook.id": event.webhookId,
        "ship.webhook.provider": event.provider,
        "ship.webhook.outcome": event.outcome,
        "http.response.status_code": event.status,
        ...(event.reason ? { "ship.webhook.reason": event.reason } : {}),
      };
      received.add(1, attributes);
      duration.record(event.durationMs, attributes);
    },
    dispatched: (event: WebhookDispatchEvent) => {
      lag.record(event.lagMs, {
        "ship.webhook.id": event.webhookId,
        "ship.webhook.provider": event.provider,
      });
    },
  });
}
