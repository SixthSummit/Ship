import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import { createJobMetrics, JOB_ATTRIBUTES, JOB_METRICS, METER_NAME } from "./metrics.js";

async function snapshot(reader: PeriodicExportingMetricReader) {
  const { resourceMetrics } = await reader.collect();
  const scope = resourceMetrics.scopeMetrics.find((item) => item.scope.name === METER_NAME);
  return Object.fromEntries(
    (scope?.metrics ?? []).map((metric) => [metric.descriptor.name, metric]),
  );
}

describe("createJobMetrics", () => {
  it("records run outcomes, lock waits and queue observations with stable attributes", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const metrics = createJobMetrics(provider);

    metrics.recordRun("reports.digest", "acme", "success", 12);
    metrics.recordRun("reports.digest", "acme", "failure", 30);
    metrics.recordLockWait("reports.digest", "acme", 5);
    metrics.observeQueues(async () => [
      { jobId: "reports.digest", depth: 3, oldestWaitingAgeMs: 250, deadLettered: 1 },
    ]);

    const collected = await snapshot(reader);
    expect(Object.keys(collected).sort()).toEqual(Object.values(JOB_METRICS).sort());
    const runs = collected[JOB_METRICS.runs]?.dataPoints.map((point) => [
      point.attributes[JOB_ATTRIBUTES.id],
      point.attributes[JOB_ATTRIBUTES.key],
      point.attributes[JOB_ATTRIBUTES.outcome],
      point.value,
    ]);
    expect(runs).toEqual([
      ["reports.digest", "acme", "success", 1],
      ["reports.digest", "acme", "failure", 1],
    ]);
    const duration = collected[JOB_METRICS.runDuration]?.dataPoints[0]?.value as {
      count: number;
      sum: number;
    };
    expect(duration).toMatchObject({ count: 2, sum: 42 });
    expect(collected[JOB_METRICS.queueDepth]?.dataPoints[0]).toMatchObject({
      attributes: { [JOB_ATTRIBUTES.id]: "reports.digest" },
      value: 3,
    });
    expect(collected[JOB_METRICS.oldestWaitingAge]?.dataPoints[0]?.value).toBe(250);
    expect(collected[JOB_METRICS.deadLetterCount]?.dataPoints[0]?.value).toBe(1);
    expect((collected[JOB_METRICS.lockWait]?.dataPoints[0]?.value as { sum: number }).sum).toBe(5);
    await provider.shutdown();
  });

  it("stops reporting queue observations once the observer is unregistered", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const metrics = createJobMetrics(provider);
    let observed = 0;
    const stop = metrics.observeQueues(async () => {
      observed += 1;
      return [{ jobId: "reports.digest", depth: 2, oldestWaitingAgeMs: 0, deadLettered: 0 }];
    });
    expect((await snapshot(reader))[JOB_METRICS.queueDepth]?.dataPoints[0]?.value).toBe(2);
    stop();
    // The cumulative reader replays the last value; what matters is that the
    // callback no longer runs, so nothing behind it is touched.
    expect((await snapshot(reader))[JOB_METRICS.queueDepth]?.dataPoints[0]?.value).toBe(2);
    expect(observed).toBe(1);
    await provider.shutdown();
  });

  it("ignores observation failures instead of breaking collection", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const metrics = createJobMetrics(provider);
    metrics.observeQueues(async () => {
      throw new Error("redis down");
    });
    const collected = await snapshot(reader);
    expect(collected[JOB_METRICS.queueDepth]?.dataPoints ?? []).toEqual([]);
    await provider.shutdown();
  });
});
