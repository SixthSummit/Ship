import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import { createWebhookMetrics } from "./webhooks.js";

describe("createWebhookMetrics", () => {
  it("records receive outcomes, durations and dispatch lag with webhook attributes", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const observer = createWebhookMetrics({ meter: provider.getMeter("test") });

    observer.received?.({
      webhookId: "ingress.hook",
      provider: "stripe",
      outcome: "accepted",
      status: 202,
      durationMs: 12,
    });
    observer.received?.({
      webhookId: "ingress.hook",
      provider: "stripe",
      outcome: "rejected",
      status: 401,
      reason: "signature-mismatch",
      durationMs: 3,
    });
    observer.received?.({
      webhookId: "ingress.hook",
      provider: "stripe",
      outcome: "duplicate",
      status: 202,
      durationMs: 5,
    });
    observer.dispatched?.({ webhookId: "ingress.hook", provider: "stripe", lagMs: 250 });

    await reader.forceFlush();
    const metrics = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    const byName = new Map(metrics.map((metric) => [metric.descriptor.name, metric]));
    const received = byName.get("ship.webhook.received");
    expect(received?.dataPoints).toHaveLength(3);
    expect(
      received?.dataPoints.map((point) => [point.attributes["ship.webhook.outcome"], point.value]),
    ).toEqual([
      ["accepted", 1],
      ["rejected", 1],
      ["duplicate", 1],
    ]);
    const rejected = received?.dataPoints.find(
      (point) => point.attributes["ship.webhook.outcome"] === "rejected",
    );
    expect(rejected?.attributes).toMatchObject({
      "ship.webhook.id": "ingress.hook",
      "ship.webhook.provider": "stripe",
      "ship.webhook.reason": "signature-mismatch",
      "http.response.status_code": 401,
    });
    expect(byName.get("ship.webhook.receive.duration")?.dataPoints).toHaveLength(3);
    const lag = byName.get("ship.webhook.dispatch.lag")?.dataPoints[0];
    expect(lag?.attributes).toEqual({
      "ship.webhook.id": "ingress.hook",
      "ship.webhook.provider": "stripe",
    });
    expect((lag?.value as { sum: number }).sum).toBe(250);
    await provider.shutdown();
  });

  it("falls back to the global framework meter", () => {
    const observer = createWebhookMetrics();
    expect(() =>
      observer.received?.({
        webhookId: "w",
        provider: "p",
        outcome: "accepted",
        status: 200,
        durationMs: 1,
      }),
    ).not.toThrow();
  });
});
