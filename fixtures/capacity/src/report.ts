import type { CapacityConfig } from "./config.js";
import type { JobsLaneSummary } from "./lanes/jobs.js";
import type { RealtimeLaneSummary } from "./lanes/realtime.js";
import type { WebhookLaneSummary } from "./lanes/webhooks.js";
import type { Sample } from "./sampler.js";
import type { Distribution, Spread } from "./stats.js";

export interface CapacitySummary {
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  readonly gitSha: string;
  readonly label: string;
  readonly mode: CapacityConfig["mode"];
  readonly config: CapacityConfig;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly cpus: number;
    readonly postgresImage: string;
    readonly redisImage: string;
    readonly packages: Readonly<Record<string, string>>;
  };
  readonly loadSeconds: number;
  readonly jobs: JobsLaneSummary & {
    readonly completedRows: number;
    readonly perTenant: Readonly<Record<string, number>>;
    readonly fairness: Spread;
    readonly worstWindowFairness: { readonly at: string; readonly spread: Spread };
    readonly peakWaiting: number;
    readonly peakDelayed: number;
    readonly peakActive: number;
    readonly peakOldestWaitingAgeMs: number;
    readonly queueLagMs: Distribution;
    readonly runMs: Distribution;
    /** Completions the lag figures were sampled from. */
    readonly lagSampled: number;
    /** Sampled runs whose start waited at least 1 s: single-runner contention retries. */
    readonly contendedRuns: number;
    readonly backendCounts: Readonly<Record<string, number>>;
    readonly deadLettered: number;
    readonly drained: boolean;
    readonly drainMs: number;
  };
  readonly realtime: RealtimeLaneSummary;
  readonly webhooks: WebhookLaneSummary;
  readonly postgres: {
    readonly peakClientBackends: number;
    readonly peakActive: number;
    readonly peakIdleInTransaction: number;
    readonly peakWaitingOnLock: number;
    readonly peakLocksNotGranted: number;
  };
  readonly redis: {
    readonly peakUsedMemoryBytes: number;
    readonly peakConnectedClients: number;
    /** used_memory slope across the load window. */
    readonly growthMiBPerMinute: number;
  };
  readonly outbox: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly outboxBacklog: {
    /** Rows warm-up left pending when measurement began. */
    readonly startPending: number;
    readonly peakPending: number;
    readonly endOfLoadPending: number;
    readonly finalPending: number;
    /** Whether every outbox reached zero pending rows inside the drain window. */
    readonly drained: boolean;
  };
  readonly workers: readonly Record<string, unknown>[];
  readonly gateways: readonly Record<string, unknown>[];
  readonly gates: { readonly passed: boolean; readonly failures: readonly string[] };
  readonly samples: readonly Sample[];
}

const dist = (value: Distribution): string =>
  value.count === 0
    ? "n/a"
    : `p50 ${value.p50} / p95 ${value.p95} / p99 ${value.p99} / max ${value.max}`;
const spreadText = (value: Spread): string =>
  `min ${value.min} / median ${value.median} / max ${value.max}`;
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const perSecond = (count: number, seconds: number): string =>
  seconds > 0 ? (count / seconds).toFixed(1) : "0";

/** The capacity table: one row per recorded measure, values as recorded. */
export function summaryTable(summary: CapacitySummary): string {
  const jobs = summary.jobs;
  const realtime = summary.realtime;
  const webhooks = summary.webhooks;
  const rows: [string, string][] = [
    [
      "Run",
      `${summary.mode}, ${summary.loadSeconds} s load after ${summary.config.warmupSeconds} s warm-up, sample every ${summary.config.sampleIntervalSeconds} s, dev \`${summary.gitSha}\``,
    ],
    [
      "Topology",
      `1 API process, ${summary.config.workerProcesses} worker processes (maxInFlight ${summary.config.workerMaxInFlight}, pool ${summary.config.dbPoolSize}), 2 gateway processes, 1 PostgreSQL (${summary.environment.postgresImage}), 1 Redis (${summary.environment.redisImage})`,
    ],
    [
      "Jobs: offered",
      `${jobs.enqueued} enqueued at ${jobs.achievedEnqueuePerSecond}/s across ${summary.config.tenants} tenant keys (${jobs.rejectedQueueFull} queue-full)`,
    ],
    [
      "Jobs: completed",
      `${jobs.completedRows} rows committed (${perSecond(jobs.completedRows, summary.loadSeconds + jobs.drainMs / 1_000)}/s incl. drain); dead-lettered ${jobs.deadLettered}; drained ${jobs.drained ? "yes" : "no"} in ${(jobs.drainMs / 1_000).toFixed(1)} s`,
    ],
    [
      "Jobs: queue depth",
      `peak waiting ${jobs.peakWaiting}, peak delayed (contention retries) ${jobs.peakDelayed}, peak active ${jobs.peakActive}; peak oldest-waiting age ${(jobs.peakOldestWaitingAgeMs / 1_000).toFixed(1)} s`,
    ],
    [
      "Jobs: enqueue-to-start lag (ms)",
      `${dist(jobs.queueLagMs)}; ${jobs.contendedRuns} of ${jobs.lagSampled} sampled runs waited >= 1 s (single-runner contention retry)`,
    ],
    ["Jobs: handler duration (ms)", dist(jobs.runMs)],
    ["Jobs: enqueue call (ms)", dist(jobs.enqueueLatencyMs)],
    ["Jobs: fairness, whole run", `${spreadText(jobs.fairness)} completions per tenant`],
    [
      "Jobs: fairness, worst window",
      `${spreadText(jobs.worstWindowFairness.spread)} per tenant per ${summary.config.sampleIntervalSeconds} s window (at ${jobs.worstWindowFairness.at})`,
    ],
    [
      "Realtime: published",
      `${realtime.published} at ${realtime.achievedRatePerSecond}/s (target ${summary.config.realtimeRatePerSecond}/s); publisher dropped ${realtime.publisherDropped}; publish() ${dist(realtime.publishCallLatencyMs)} ms`,
    ],
    ...realtime.subscribers.map<[string, string]>((subscriber) => [
      `Realtime: ${subscriber.gateway}`,
      `received ${subscriber.received}, missing ${subscriber.missing}, late (>${summary.config.realtimeLateMs} ms) ${subscriber.late}, dropped by gateway ${subscriber.droppedMessages}; end-to-end ${dist(subscriber.latencyMs)} ms`,
    ]),
    [
      "Webhooks",
      `${webhooks.bursts} bursts of ${summary.config.webhookBurstSize} (concurrency ${summary.config.webhookConcurrency}); ${webhooks.accepted} accepted (202), ${webhooks.rejected} tampered rejected (401), ${webhooks.unexpected} unexpected`,
    ],
    [
      "Webhooks: latency (ms)",
      `${dist(webhooks.latencyMs)}; worst burst #${webhooks.worstBurst.index} p95 ${webhooks.worstBurst.p95} / max ${webhooks.worstBurst.max}`,
    ],
    [
      "PostgreSQL",
      `peak client backends ${summary.postgres.peakClientBackends}, peak active ${summary.postgres.peakActive}, peak idle-in-transaction ${summary.postgres.peakIdleInTransaction}, peak backends waiting on a lock ${summary.postgres.peakWaitingOnLock}, peak \`pg_locks\` not granted ${summary.postgres.peakLocksNotGranted}`,
    ],
    [
      "Redis",
      `peak used_memory ${mib(summary.redis.peakUsedMemoryBytes)}, peak connected clients ${summary.redis.peakConnectedClients}, used_memory growth ${summary.redis.growthMiBPerMinute} MiB/min over the load window`,
    ],
    [
      "Outbox backlog",
      `pending at start ${summary.outboxBacklog.startPending}, peak pending ${summary.outboxBacklog.peakPending}, pending at end of load ${summary.outboxBacklog.endOfLoadPending}, after drain ${summary.outboxBacklog.finalPending} (${summary.outboxBacklog.drained ? "drained" : "not drained"} within ${summary.config.drainSeconds} s)`,
    ],
    [
      "Outbox (final)",
      Object.entries(summary.outbox)
        .map(
          ([outboxId, states]) =>
            `${outboxId}: ${Object.entries(states)
              .map(([state, count]) => `${state} ${count}`)
              .join(", ")}`,
        )
        .join("; ") || "empty",
    ],
    ["Gates", summary.gates.passed ? "passed" : `failed: ${summary.gates.failures.join("; ")}`],
  ];
  return [
    "| Measure | Value |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
  ].join("\n");
}

export function timelineTable(summary: CapacitySummary): string {
  const header = [
    "| t (s) | phase | enq/s | done/s | waiting/delayed/active | oldest wait (s) | lag p50/p95 (ms) | contended | fairness min/med/max | outbox pending | pg backends | pg lock waits | redis MiB | rt pub/s | rt recv A/B | rt late A/B | wh sent | wh p95 (ms) |",
    "| ---: | --- | ---: | ---: | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |",
  ];
  const rows = summary.samples.map((sample, index) => {
    const previous = index === 0 ? 0 : (summary.samples[index - 1] as Sample).elapsedSeconds;
    const seconds = Math.max(1, sample.elapsedSeconds - previous);
    const [a, b] = sample.realtime.subscribers;
    return `| ${sample.elapsedSeconds} | ${sample.phase} | ${perSecond(sample.jobs.enqueued, seconds)} | ${perSecond(sample.jobs.completed, seconds)} | ${sample.jobs.waiting}/${sample.jobs.delayed}/${sample.jobs.active} | ${(sample.jobs.oldestWaitingAgeMs / 1_000).toFixed(1)} | ${sample.jobs.queueLagMs.count === 0 ? "n/a" : `${sample.jobs.queueLagMs.p50}/${sample.jobs.queueLagMs.p95}`} | ${sample.jobs.contendedRuns} | ${sample.jobs.fairness.min}/${sample.jobs.fairness.median}/${sample.jobs.fairness.max} | ${sample.outboxPending} | ${sample.postgres.clientBackends} | ${sample.postgres.locksNotGranted} | ${(sample.redis.usedMemoryBytes / 1024 / 1024).toFixed(1)} | ${perSecond(sample.realtime.published, seconds)} | ${a?.received ?? 0}/${b?.received ?? 0} | ${a?.late ?? 0}/${b?.late ?? 0} | ${sample.webhooks.sent} | ${sample.webhooks.latencyMs.count === 0 ? "n/a" : sample.webhooks.latencyMs.p95} |`;
  });
  return [...header, ...rows].join("\n");
}

export function knobsTable(config: CapacityConfig): string {
  const rows: [string, string][] = [
    ["CAPACITY_DURATION_SECONDS", String(config.durationSeconds)],
    ["CAPACITY_WARMUP_SECONDS", String(config.warmupSeconds)],
    ["CAPACITY_SAMPLE_INTERVAL_SECONDS", String(config.sampleIntervalSeconds)],
    ["CAPACITY_TENANTS", String(config.tenants)],
    ["CAPACITY_JOB_ENQUEUE_PER_SECOND", String(config.jobEnqueuePerSecond)],
    ["CAPACITY_WORKER_PROCESSES", String(config.workerProcesses)],
    ["CAPACITY_WORKER_MAX_IN_FLIGHT", String(config.workerMaxInFlight)],
    ["CAPACITY_DISPATCH_INTERVAL_MS", String(config.dispatchIntervalMs)],
    ["CAPACITY_DISPATCH_PASSES_PER_CYCLE", String(config.dispatchPassesPerCycle)],
    ["CAPACITY_DB_POOL_SIZE", String(config.dbPoolSize)],
    ["CAPACITY_REALTIME_RATE_PER_SECOND", String(config.realtimeRatePerSecond)],
    ["CAPACITY_REALTIME_LATE_MS", String(config.realtimeLateMs)],
    ["CAPACITY_WEBHOOK_BURST_SIZE", String(config.webhookBurstSize)],
    ["CAPACITY_WEBHOOK_BURST_INTERVAL_SECONDS", String(config.webhookBurstIntervalSeconds)],
    ["CAPACITY_WEBHOOK_CONCURRENCY", String(config.webhookConcurrency)],
    ["CAPACITY_DRAIN_SECONDS", String(config.drainSeconds)],
  ];
  return [
    "| Knob | Value |",
    "| --- | ---: |",
    ...rows.map(([name, value]) => `| \`${name}\` | ${value} |`),
  ].join("\n");
}

export function renderMarkdown(summary: CapacitySummary): string {
  return [
    `# Capacity baseline: ${summary.label}`,
    "",
    `Recorded ${summary.recordedAt} on Node ${summary.environment.node} (${summary.environment.platform}/${summary.environment.arch}, ${summary.environment.cpus} CPUs) against dev \`${summary.gitSha}\`. One disposable PostgreSQL and one disposable Redis in Docker; every process on one machine. This is a re-runnable local baseline, not production capacity.`,
    "",
    "## Summary",
    "",
    summaryTable(summary),
    "",
    "## Timeline",
    "",
    timelineTable(summary),
    "",
    "## Knobs",
    "",
    knobsTable(summary.config),
    "",
  ].join("\n");
}
