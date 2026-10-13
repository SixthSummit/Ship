import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import {
  ATTR_PUBLICATION_OUTCOME,
  ATTR_PUBLICATION_RESULT,
  createPublicationRunnerMetrics,
  PUBLICATION_RUNNER_METRICS,
} from "./metrics.js";

async function snapshot(reader: PeriodicExportingMetricReader, scopeName: string) {
  const { resourceMetrics } = await reader.collect();
  const scope = resourceMetrics.scopeMetrics.find((item) => item.scope.name === scopeName);
  return Object.fromEntries(
    (scope?.metrics ?? []).map((metric) => [metric.descriptor.name, metric]),
  );
}

describe("createPublicationRunnerMetrics", () => {
  it("records passes by outcome, their duration and dispatched records by result", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const observer = createPublicationRunnerMetrics(provider.getMeter("runner-test"));

    observer.pass({
      ok: true,
      durationMs: 12,
      result: { claimed: 5, completed: 3, retried: 1, deadLettered: 1 },
    });
    observer.pass({
      ok: true,
      durationMs: 1,
      result: { claimed: 0, completed: 0, retried: 0, deadLettered: 0 },
    });
    observer.pass({
      ok: false,
      durationMs: 40,
      error: new Error("redis"),
      failures: 1,
      retryInMs: 250,
    });

    const collected = await snapshot(reader, "runner-test");
    expect(Object.keys(collected).sort()).toEqual(Object.values(PUBLICATION_RUNNER_METRICS).sort());
    const runs = collected[PUBLICATION_RUNNER_METRICS.runs]?.dataPoints.map((point) => [
      point.attributes[ATTR_PUBLICATION_OUTCOME],
      point.value,
    ]);
    expect(runs).toEqual([
      ["success", 2],
      ["failure", 1],
    ]);
    const records = collected[PUBLICATION_RUNNER_METRICS.records]?.dataPoints.map((point) => [
      point.attributes[ATTR_PUBLICATION_RESULT],
      point.value,
    ]);
    expect(records).toEqual([
      ["completed", 3],
      ["retried", 1],
      ["dead-lettered", 1],
    ]);
    const durations = collected[PUBLICATION_RUNNER_METRICS.runDuration]?.dataPoints.map((point) => [
      point.attributes[ATTR_PUBLICATION_OUTCOME],
      (point.value as { count: number; sum: number }).count,
    ]);
    expect(durations).toEqual([
      ["success", 2],
      ["failure", 1],
    ]);
  });

  it("falls back to the framework meter when none is given", () => {
    const observer = createPublicationRunnerMetrics();
    expect(() =>
      observer.pass({
        ok: true,
        durationMs: 0,
        result: { claimed: 0, completed: 0, retried: 0, deadLettered: 0 },
      }),
    ).not.toThrow();
  });
});
