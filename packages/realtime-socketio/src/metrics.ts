import type { Attributes, Counter, Histogram, Meter, UpDownCounter } from "@opentelemetry/api";
import type {
  RealtimePublicationRunnerObserver,
  RealtimePublicationRunnerPass,
} from "@sixthsummit/ship-core";
import { getFrameworkMeter } from "@sixthsummit/ship-observability-otel/metrics";

export const METER_NAME = "@sixthsummit/ship-realtime-socketio";

/** Stable attribute names shared by every realtime instrument. */
export const ATTR_CHANNEL_ID = "ship.channel.id";
export const ATTR_CHANNEL_SCOPE = "ship.channel.scope";
export const ATTR_GATEWAY_ID = "ship.realtime.gateway";
export const ATTR_DROP_REASON = "ship.realtime.drop_reason";
/** Outcome of one dispatch pass: `success` or `failure`; mirrors `ship.job.outcome`. */
export const ATTR_PUBLICATION_OUTCOME = "ship.realtime.publication.outcome";
/** What happened to a dispatched record: `completed`, `retried` or `dead-lettered`. */
export const ATTR_PUBLICATION_RESULT = "ship.realtime.publication.result";

/** Stable instrument names of the publication dispatch runner, shaped like `ship.job.*`. */
export const PUBLICATION_RUNNER_METRICS = Object.freeze({
  runs: "ship.realtime.publication.runs",
  runDuration: "ship.realtime.publication.run.duration",
  records: "ship.realtime.publication.records",
});

export interface RealtimeMetrics {
  readonly connections: UpDownCounter;
  readonly subscriptions: UpDownCounter;
  /** Milliseconds from backend acceptance (publishedAt) to the socket write. */
  readonly deliverLatency: Histogram;
  /** Milliseconds from backend acceptance to the gateway receiving it from Redis. */
  readonly redisLag: Histogram;
  /** Events removed from a per-connection buffer or a publisher queue. */
  readonly dropped: Counter;
  readonly published: Counter;
  readonly delivered: Counter;
  channelAttributes(channelId: string, scope: string, extra?: Attributes): Attributes;
}

export function createRealtimeMetrics(
  meter: Meter = getFrameworkMeter(METER_NAME),
): RealtimeMetrics {
  const metrics: RealtimeMetrics = {
    connections: meter.createUpDownCounter("ship.realtime.connections", {
      description: "Open realtime connections in this process",
      unit: "{connection}",
    }),
    subscriptions: meter.createUpDownCounter("ship.realtime.subscriptions", {
      description: "Active subscriptions per channel in this process",
      unit: "{subscription}",
    }),
    deliverLatency: meter.createHistogram("ship.realtime.deliver.latency", {
      description: "Publish-to-deliver latency measured against the publisher clock",
      unit: "ms",
    }),
    redisLag: meter.createHistogram("ship.realtime.redis.lag", {
      description:
        "Publish-to-receive lag across Redis pub/sub measured against the publisher clock",
      unit: "ms",
    }),
    dropped: meter.createCounter("ship.realtime.dropped", {
      description: "Messages dropped by slow-subscriber or publisher queue policy",
      unit: "{message}",
    }),
    published: meter.createCounter("ship.realtime.published", {
      description: "Publications accepted by this process",
      unit: "{message}",
    }),
    delivered: meter.createCounter("ship.realtime.delivered", {
      description: "Events written to a connection",
      unit: "{message}",
    }),
    channelAttributes: (channelId, scope, extra = {}) => ({
      [ATTR_CHANNEL_ID]: channelId,
      [ATTR_CHANNEL_SCOPE]: scope,
      ...extra,
    }),
  };
  return Object.freeze(metrics);
}

export interface PublicationRunnerMetrics extends RealtimePublicationRunnerObserver {
  readonly runs: Counter;
  readonly runDuration: Histogram;
  readonly records: Counter;
}

/**
 * OpenTelemetry observer for `startRealtimePublicationRunner()` and the
 * dispatch job. Pass rate and failure rate derive from
 * `ship.realtime.publication.runs` by outcome, p50/p95 pass duration from the
 * `run.duration` histogram, and delivery throughput from `records` by result,
 * the same reading the `ship.job.*` instruments give a job runner.
 */
export function createPublicationRunnerMetrics(
  meter: Meter = getFrameworkMeter(METER_NAME),
): PublicationRunnerMetrics {
  const runs = meter.createCounter(PUBLICATION_RUNNER_METRICS.runs, {
    description: "Realtime publication dispatch passes by outcome",
    unit: "{run}",
  });
  const runDuration = meter.createHistogram(PUBLICATION_RUNNER_METRICS.runDuration, {
    description: "Realtime publication dispatch pass duration",
    unit: "ms",
  });
  const records = meter.createCounter(PUBLICATION_RUNNER_METRICS.records, {
    description: "Publication intents dispatched by result",
    unit: "{record}",
  });
  return Object.freeze({
    runs,
    runDuration,
    records,
    pass: (pass: RealtimePublicationRunnerPass) => {
      const outcome = pass.ok ? "success" : "failure";
      runs.add(1, { [ATTR_PUBLICATION_OUTCOME]: outcome });
      runDuration.record(pass.durationMs, { [ATTR_PUBLICATION_OUTCOME]: outcome });
      if (!pass.ok) return;
      const counts = {
        completed: pass.result.completed,
        retried: pass.result.retried,
        "dead-lettered": pass.result.deadLettered,
      };
      for (const [result, count] of Object.entries(counts)) {
        if (count > 0) records.add(count, { [ATTR_PUBLICATION_RESULT]: result });
      }
    },
  });
}
