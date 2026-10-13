/**
 * Fixed-interval sampler. Every sample records queue depth, oldest-waiting
 * age and enqueue-to-start lag for the jobs lane, per-tenant completions in
 * the window (fairness), PostgreSQL connection and lock-wait counts, Redis
 * memory, outbox row states, and the per-window counters of every lane.
 */
import type pg from "pg";
import type { ComposedApplication } from "./compose.js";
import { JOB_ID, type JobsLane, type JobsWindow } from "./lanes/jobs.js";
import type { RealtimeLane, RealtimeWindow } from "./lanes/realtime.js";
import type { WebhookLane, WebhookWindow } from "./lanes/webhooks.js";
import { type Distribution, distribution, type Spread, spread } from "./stats.js";

/**
 * Most recent completed runs read back per window; lag figures are sampled
 * from these. Kept small so reading them does not stall the API process's
 * event loop, which also paces the publisher and the enqueuer.
 */
export const LAG_SAMPLE_SIZE = 300;
/** A start that waited at least this long after enqueue was held back by a single-runner contention retry. */
export const CONTENTION_LAG_MS = 1_000;

export interface JobsSample extends JobsWindow {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly oldestWaitingAgeMs: number;
  /** Enqueue-to-start lag of runs that finished inside the window (BullMQ timestamps, sampled). */
  readonly queueLagMs: Distribution;
  /** Sampled runs whose start waited at least CONTENTION_LAG_MS. */
  readonly contendedRuns: number;
  /** Handler duration of the same runs. */
  readonly runMs: Distribution;
  /** Rows the job committed inside the window, per tenant key. */
  readonly completed: number;
  readonly perTenant: Readonly<Record<string, number>>;
  readonly fairness: Spread;
}

export interface PostgresSample {
  readonly clientBackends: number;
  readonly active: number;
  readonly idleInTransaction: number;
  /** Backends whose current wait event is a heavyweight lock. */
  readonly waitingOnLock: number;
  /** `pg_locks` rows not granted. */
  readonly locksNotGranted: number;
}

export interface RedisSample {
  readonly usedMemoryBytes: number;
  readonly usedMemoryPeakBytes: number;
  readonly connectedClients: number;
}

export interface Sample {
  readonly at: string;
  readonly elapsedSeconds: number;
  /** `load` while every lane is offering work, `drain` afterwards. */
  readonly phase: "load" | "drain";
  readonly jobs: JobsSample;
  readonly postgres: PostgresSample;
  readonly redis: RedisSample;
  readonly outbox: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Outbox rows still pending across every outbox (dispatcher backlog). */
  readonly outboxPending: number;
  readonly realtime: RealtimeWindow;
  readonly webhooks: WebhookWindow;
}

export interface SamplerOptions {
  readonly composed: ComposedApplication;
  readonly metrics: pg.Pool;
  readonly tenants: readonly string[];
  readonly lanes: {
    readonly jobs: JobsLane;
    readonly realtime: RealtimeLane;
    readonly webhooks: WebhookLane;
  };
  readonly startedAt: number;
}

export function createSampler(options: SamplerOptions) {
  const samples: Sample[] = [];
  const lagSamples: number[] = [];
  const runSamples: number[] = [];
  let contendedRuns = 0;
  let cumulativePerTenant: Record<string, number> = Object.fromEntries(
    options.tenants.map((tenant) => [tenant, 0]),
  );
  /** Rows present when measurement began (warm-up leftovers); excluded from totals. */
  let baselinePerTenant: Record<string, number> | undefined;
  let lastSampleAt = options.startedAt;

  const perTenantRows = async (): Promise<Record<string, number>> => {
    const result = await options.metrics.query<{ tenant_id: string; completions: number }>(
      "select tenant_id, count(*)::int as completions from report_requests group by tenant_id",
    );
    const counts: Record<string, number> = Object.fromEntries(
      options.tenants.map((tenant) => [tenant, 0]),
    );
    for (const row of result.rows) counts[row.tenant_id] = row.completions;
    return counts;
  };

  const sample = async (phase: Sample["phase"]): Promise<Sample> => {
    const now = Date.now();
    const windowStartedAt = lastSampleAt;
    lastSampleAt = now;
    const [health, recent, rows, pgActivity, pgLocks, redisInfo, outboxRows] = await Promise.all([
      options.composed.backend.health(new Date(now)),
      options.composed.backend.queue(JOB_ID).getCompleted(0, LAG_SAMPLE_SIZE - 1),
      perTenantRows(),
      options.metrics.query<{
        client_backends: number;
        active: number;
        idle_in_transaction: number;
        waiting_on_lock: number;
      }>(
        `select count(*)::int as client_backends,
                count(*) filter (where state = 'active')::int as active,
                count(*) filter (where state like 'idle in transaction%')::int as idle_in_transaction,
                count(*) filter (where wait_event_type = 'Lock')::int as waiting_on_lock
           from pg_stat_activity
          where backend_type = 'client backend'`,
      ),
      options.metrics.query<{ not_granted: number }>(
        "select count(*)::int as not_granted from pg_locks where not granted",
      ),
      options.composed.redis.info("memory"),
      options.metrics.query<{ outbox_id: string; status: string; rows: number }>(
        "select outbox_id, status, count(*)::int as rows from ship_outbox group by outbox_id, status",
      ),
    ]);
    const clients = await options.composed.redis.info("clients");
    const entry = health.jobs.find((item) => item.jobId === JOB_ID);
    const finishedInWindow = recent.filter(
      (job) => typeof job.finishedOn === "number" && job.finishedOn >= windowStartedAt,
    );
    const windowLag = finishedInWindow.map((job) =>
      Math.max(0, (job.processedOn ?? 0) - job.timestamp),
    );
    const windowRun = finishedInWindow.map((job) =>
      Math.max(0, (job.finishedOn ?? 0) - (job.processedOn ?? job.finishedOn ?? 0)),
    );
    const windowContended = windowLag.filter((lag) => lag >= CONTENTION_LAG_MS).length;
    lagSamples.push(...windowLag);
    runSamples.push(...windowRun);
    contendedRuns += windowContended;
    const perTenant: Record<string, number> = {};
    for (const tenant of options.tenants) {
      perTenant[tenant] = (rows[tenant] ?? 0) - (cumulativePerTenant[tenant] ?? 0);
    }
    cumulativePerTenant = rows;
    baselinePerTenant ??= rows;
    const outbox: Record<string, Record<string, number>> = {};
    let outboxPending = 0;
    for (const row of outboxRows.rows) {
      outbox[row.outbox_id] = { ...(outbox[row.outbox_id] ?? {}), [row.status]: row.rows };
      if (row.status === "pending" || row.status === "claimed") outboxPending += row.rows;
    }
    const item: Sample = {
      at: new Date(now).toISOString(),
      elapsedSeconds: Math.round((now - options.startedAt) / 1_000),
      phase,
      jobs: {
        ...options.lanes.jobs.window(),
        waiting: entry?.waiting ?? 0,
        active: entry?.active ?? 0,
        delayed: entry?.delayed ?? 0,
        failed: entry?.failed ?? 0,
        oldestWaitingAgeMs: entry?.lagMs ?? 0,
        queueLagMs: distribution(windowLag),
        contendedRuns: windowContended,
        runMs: distribution(windowRun),
        completed: Object.values(perTenant).reduce((sum, value) => sum + value, 0),
        perTenant,
        fairness: spread(Object.values(perTenant)),
      },
      postgres: {
        clientBackends: pgActivity.rows[0]?.client_backends ?? 0,
        active: pgActivity.rows[0]?.active ?? 0,
        idleInTransaction: pgActivity.rows[0]?.idle_in_transaction ?? 0,
        waitingOnLock: pgActivity.rows[0]?.waiting_on_lock ?? 0,
        locksNotGranted: pgLocks.rows[0]?.not_granted ?? 0,
      },
      redis: {
        usedMemoryBytes: infoNumber(redisInfo, "used_memory"),
        usedMemoryPeakBytes: infoNumber(redisInfo, "used_memory_peak"),
        connectedClients: infoNumber(clients, "connected_clients"),
      },
      outbox,
      outboxPending,
      realtime: options.lanes.realtime.window(),
      webhooks: options.lanes.webhooks.window(),
    };
    samples.push(item);
    return item;
  };

  return {
    sample,
    samples: () => samples as readonly Sample[],
    /** Pending plus claimed outbox rows right now, without recording a sample. */
    outboxBacklog: async (): Promise<number> => {
      const result = await options.metrics.query<{ pending: number }>(
        "select count(*)::int as pending from ship_outbox where status in ('pending', 'claimed')",
      );
      return result.rows[0]?.pending ?? 0;
    },
    /** Rows committed per tenant since the first (t=0) sample. */
    completedPerTenant: (): Readonly<Record<string, number>> =>
      Object.fromEntries(
        options.tenants.map((tenant) => [
          tenant,
          (cumulativePerTenant[tenant] ?? 0) - (baselinePerTenant?.[tenant] ?? 0),
        ]),
      ),
    /** Every sampled completion across windows. */
    lag: () => ({
      queueLagMs: distribution(lagSamples),
      runMs: distribution(runSamples),
      sampled: lagSamples.length,
      contendedRuns,
    }),
  };
}

export type Sampler = ReturnType<typeof createSampler>;

function infoNumber(info: string, field: string): number {
  const match = new RegExp(`^${field}:(\\d+)`, "mu").exec(info);
  return match ? Number(match[1]) : 0;
}
