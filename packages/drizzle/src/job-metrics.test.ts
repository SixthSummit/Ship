import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import {
  createDrizzleJobMetrics,
  JOB_ATTRIBUTES,
  JOB_METER_NAME,
  JOB_METRICS,
} from "./job-metrics.js";

async function snapshot(reader: PeriodicExportingMetricReader) {
  const { resourceMetrics } = await reader.collect();
  const scope = resourceMetrics.scopeMetrics.find((item) => item.scope.name === JOB_METER_NAME);
  return Object.fromEntries(
    (scope?.metrics ?? []).map((metric) => [metric.descriptor.name, metric]),
  );
}

describe("createDrizzleJobMetrics", () => {
  it("records run outcomes, lock waits and queue observations under the shared ship.job.* names", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const metrics = createDrizzleJobMetrics(provider);

    metrics.recordRun("reports.digest", "acme", "success", 12);
    metrics.recordRun("reports.digest", "acme", "lock-held", 30);
    metrics.recordLockWait("reports.digest", "acme", 5);
    metrics.observeQueues(async () => [
      { jobId: "reports.digest", depth: 3, oldestWaitingAgeMs: 250, deadLettered: 1 },
    ]);

    const collected = await snapshot(reader);
    expect(Object.keys(collected).sort()).toEqual(Object.values(JOB_METRICS).sort());
    expect(
      collected[JOB_METRICS.runs]?.dataPoints.map((point) => [
        point.attributes[JOB_ATTRIBUTES.id],
        point.attributes[JOB_ATTRIBUTES.key],
        point.attributes[JOB_ATTRIBUTES.outcome],
        point.value,
      ]),
    ).toEqual([
      ["reports.digest", "acme", "success", 1],
      ["reports.digest", "acme", "lock-held", 1],
    ]);
    expect(collected[JOB_METRICS.runDuration]?.dataPoints[0]?.value).toMatchObject({
      count: 2,
      sum: 42,
    });
    expect(collected[JOB_METRICS.queueDepth]?.dataPoints[0]).toMatchObject({
      attributes: { [JOB_ATTRIBUTES.id]: "reports.digest" },
      value: 3,
    });
    expect(collected[JOB_METRICS.oldestWaitingAge]?.dataPoints[0]?.value).toBe(250);
    expect(collected[JOB_METRICS.deadLetterCount]?.dataPoints[0]?.value).toBe(1);
    expect((collected[JOB_METRICS.lockWait]?.dataPoints[0]?.value as { sum: number }).sum).toBe(5);
    await provider.shutdown();
  });

  it("ignores observation failures instead of breaking collection", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const metrics = createDrizzleJobMetrics(provider);
    metrics.observeQueues(async () => {
      throw new Error("database down");
    });
    const collected = await snapshot(reader);
    expect(collected[JOB_METRICS.queueDepth]?.dataPoints ?? []).toEqual([]);
    await provider.shutdown();
  });

  it("uses the global meter provider by default", () => {
    expect(createDrizzleJobMetrics().meter).toBeDefined();
  });
});
