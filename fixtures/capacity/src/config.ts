/**
 * Every knob the capacity baseline exposes, read once from the environment.
 * Defaults describe the baseline shape recorded in docs/v4/capacity-baseline.md;
 * a run that moves a knob records the moved value in its summary.
 */
export interface CapacityConfig {
  /** `full` (600 s default) or `short` (60 s default, the CI smoke shape). */
  readonly mode: "full" | "short";
  readonly durationSeconds: number;
  /** Seconds every lane runs at full rate before counters reset and measurement starts. */
  readonly warmupSeconds: number;
  readonly sampleIntervalSeconds: number;
  /** Tenant keys the jobs lane spreads work across; at least 3. */
  readonly tenants: number;
  /** Total `reports.deliver` enqueues per second, round-robin across tenants. */
  readonly jobEnqueuePerSecond: number;
  readonly workerProcesses: number;
  /** Process-wide in-flight budget handed to each worker's BullMQ backend. */
  readonly workerMaxInFlight: number;
  /** Idle interval of each worker's four dispatcher runners (a full batch is followed by the next pass at once). */
  readonly dispatchIntervalMs: number;
  /** Full passes a dispatcher runner takes back to back before yielding to the interval. */
  readonly dispatchPassesPerCycle: number;
  /** `pg.Pool` size per process (API process and each worker). */
  readonly dbPoolSize: number;
  /** ADR-0017 publish rate: 500/s. */
  readonly realtimeRatePerSecond: number;
  /** A delivered message older than this (publisher clock to client receipt) counts as late. */
  readonly realtimeLateMs: number;
  readonly webhookBurstSize: number;
  readonly webhookBurstIntervalSeconds: number;
  /** Concurrent in-flight webhook requests inside one burst. */
  readonly webhookConcurrency: number;
  /** Seconds to wait after the load window for queues and subscribers to drain. */
  readonly drainSeconds: number;
  readonly outputDirectory: string;
  readonly label: string;
  readonly gitSha: string;
}

const DEFAULTS = Object.freeze({
  fullDurationSeconds: 600,
  shortDurationSeconds: 60,
  warmupSeconds: 10,
  sampleIntervalSeconds: 10,
  tenants: 6,
  jobEnqueuePerSecond: 500,
  workerProcesses: 2,
  workerMaxInFlight: 8,
  dispatchIntervalMs: 250,
  dispatchPassesPerCycle: 10,
  dbPoolSize: 8,
  realtimeRatePerSecond: 500,
  realtimeLateMs: 250,
  webhookBurstSize: 100,
  webhookBurstIntervalSeconds: 10,
  webhookConcurrency: 25,
  drainSeconds: 60,
});

export function readCapacityConfig(env: NodeJS.ProcessEnv = process.env): CapacityConfig {
  const mode = env.CAPACITY_MODE === "short" ? "short" : "full";
  const durationSeconds = integer(
    env.CAPACITY_DURATION_SECONDS,
    mode === "short" ? DEFAULTS.shortDurationSeconds : DEFAULTS.fullDurationSeconds,
    5,
  );
  const tenants = integer(env.CAPACITY_TENANTS, DEFAULTS.tenants, 3);
  return Object.freeze({
    mode,
    durationSeconds,
    warmupSeconds: integer(env.CAPACITY_WARMUP_SECONDS, DEFAULTS.warmupSeconds, 0),
    sampleIntervalSeconds: integer(
      env.CAPACITY_SAMPLE_INTERVAL_SECONDS,
      DEFAULTS.sampleIntervalSeconds,
      1,
    ),
    tenants,
    jobEnqueuePerSecond: integer(
      env.CAPACITY_JOB_ENQUEUE_PER_SECOND,
      DEFAULTS.jobEnqueuePerSecond,
      1,
    ),
    workerProcesses: integer(env.CAPACITY_WORKER_PROCESSES, DEFAULTS.workerProcesses, 1),
    workerMaxInFlight: integer(env.CAPACITY_WORKER_MAX_IN_FLIGHT, DEFAULTS.workerMaxInFlight, 1),
    dispatchIntervalMs: integer(env.CAPACITY_DISPATCH_INTERVAL_MS, DEFAULTS.dispatchIntervalMs, 10),
    dispatchPassesPerCycle: integer(
      env.CAPACITY_DISPATCH_PASSES_PER_CYCLE,
      DEFAULTS.dispatchPassesPerCycle,
      1,
    ),
    dbPoolSize: integer(env.CAPACITY_DB_POOL_SIZE, DEFAULTS.dbPoolSize, 1),
    realtimeRatePerSecond: integer(
      env.CAPACITY_REALTIME_RATE_PER_SECOND,
      DEFAULTS.realtimeRatePerSecond,
      1,
    ),
    realtimeLateMs: integer(env.CAPACITY_REALTIME_LATE_MS, DEFAULTS.realtimeLateMs, 1),
    webhookBurstSize: integer(env.CAPACITY_WEBHOOK_BURST_SIZE, DEFAULTS.webhookBurstSize, 1),
    webhookBurstIntervalSeconds: integer(
      env.CAPACITY_WEBHOOK_BURST_INTERVAL_SECONDS,
      DEFAULTS.webhookBurstIntervalSeconds,
      1,
    ),
    webhookConcurrency: integer(env.CAPACITY_WEBHOOK_CONCURRENCY, DEFAULTS.webhookConcurrency, 1),
    drainSeconds: integer(env.CAPACITY_DRAIN_SECONDS, DEFAULTS.drainSeconds, 0),
    outputDirectory: env.CAPACITY_OUTPUT_DIR?.trim() || ".capacity",
    label: (env.CAPACITY_LABEL?.trim() || mode).replace(/[^A-Za-z0-9._-]+/gu, "-"),
    gitSha: env.CAPACITY_GIT_SHA?.trim() || "unknown",
  });
}

/** Tenant ids the jobs lane and the consumer's scheduled-tenant policy share. */
export function tenantIds(count: number): readonly string[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => `tenant-${String(index + 1).padStart(2, "0")}`),
  );
}

function integer(raw: string | undefined, fallback: number, minimum: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`expected an integer >= ${minimum}, received ${JSON.stringify(raw)}`);
  }
  return value;
}
