import type { Attributes, Counter, Histogram, Meter, MeterProvider } from "@opentelemetry/api";
import { metrics as globalMetrics } from "@opentelemetry/api";

export const JOB_METER_NAME = "@sixthsummit/ship-drizzle";

/** Stable attribute names every job metric carries; identical to the BullMQ adapter. */
export const JOB_ATTRIBUTES = Object.freeze({
  id: "ship.job.id",
  key: "ship.job.key",
  outcome: "ship.job.outcome",
});

/** Stable instrument names; identical to the BullMQ adapter. */
export const JOB_METRICS = Object.freeze({
  queueDepth: "ship.job.queue.depth",
  oldestWaitingAge: "ship.job.queue.oldest_waiting_age",
  runDuration: "ship.job.run.duration",
  runs: "ship.job.runs",
  deadLetterCount: "ship.job.dead_letter.count",
  lockWait: "ship.job.lock.wait",
});

export type JobRunOutcome = "success" | "failure" | "lock-held";

export interface JobQueueObservation {
  readonly jobId: string;
  readonly depth: number;
  readonly oldestWaitingAgeMs: number;
  readonly deadLettered: number;
}

export interface JobMetrics {
  readonly meter: Meter;
  recordRun(jobId: string, key: string, outcome: JobRunOutcome, durationMs: number): void;
  recordLockWait(jobId: string, key: string, waitMs: number): void;
  /** Registers the callback that reports queue depth, oldest-waiting age and dead-letter counts. */
  observeQueues(observe: () => Promise<readonly JobQueueObservation[]>): void;
}

/**
 * OpenTelemetry instruments for the PostgreSQL job backend, emitted through
 * the framework meter under the same names and attributes the BullMQ adapter
 * uses so dashboards do not care which backend a process runs.
 */
export function createDrizzleJobMetrics(provider: MeterProvider = globalMetrics): JobMetrics {
  const meter = provider.getMeter(JOB_METER_NAME);
  const runDuration: Histogram = meter.createHistogram(JOB_METRICS.runDuration, {
    description: "Job run duration",
    unit: "ms",
  });
  const runs: Counter = meter.createCounter(JOB_METRICS.runs, {
    description: "Job runs by outcome",
  });
  const lockWait: Histogram = meter.createHistogram(JOB_METRICS.lockWait, {
    description: "Time spent acquiring a single-runner lease before the handler ran",
    unit: "ms",
  });
  const queueDepth = meter.createObservableGauge(JOB_METRICS.queueDepth, {
    description: "Runs waiting or delayed per job",
  });
  const oldestWaitingAge = meter.createObservableGauge(JOB_METRICS.oldestWaitingAge, {
    description: "Age of the oldest waiting run per job",
    unit: "ms",
  });
  const deadLetterCount = meter.createObservableGauge(JOB_METRICS.deadLetterCount, {
    description: "Dead-lettered runs per job",
  });

  return Object.freeze({
    meter,
    recordRun: (jobId: string, key: string, outcome: JobRunOutcome, durationMs: number) => {
      const attributes: Attributes = {
        [JOB_ATTRIBUTES.id]: jobId,
        [JOB_ATTRIBUTES.key]: key,
      };
      runDuration.record(durationMs, attributes);
      runs.add(1, { ...attributes, [JOB_ATTRIBUTES.outcome]: outcome });
    },
    recordLockWait: (jobId: string, key: string, waitMs: number) => {
      lockWait.record(waitMs, { [JOB_ATTRIBUTES.id]: jobId, [JOB_ATTRIBUTES.key]: key });
    },
    observeQueues: (observe: () => Promise<readonly JobQueueObservation[]>) => {
      meter.addBatchObservableCallback(
        async (result) => {
          let observations: readonly JobQueueObservation[];
          try {
            observations = await observe();
          } catch {
            return;
          }
          for (const observation of observations) {
            const attributes: Attributes = { [JOB_ATTRIBUTES.id]: observation.jobId };
            result.observe(queueDepth, observation.depth, attributes);
            result.observe(oldestWaitingAge, observation.oldestWaitingAgeMs, attributes);
            result.observe(deadLetterCount, observation.deadLettered, attributes);
          }
        },
        [queueDepth, oldestWaitingAge, deadLetterCount],
      );
    },
  });
}
