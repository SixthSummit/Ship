/**
 * Jobs lane: enqueues the consumer's `reports.deliver` job (keyed single-runner,
 * declared `max: 4`) round-robin across the tenant keys at a steady rate. Each
 * run records a request row and an outbox intent in one PostgreSQL
 * transaction; the workers dispatch the intent afterwards.
 */
import type { ComposedApplication } from "../compose.js";
import type { CapacityConfig } from "../config.js";
import { type Distribution, distribution, paced } from "../stats.js";

export const JOB_ID = "reports.deliver";
const PERIOD_EPOCH = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface JobsWindow {
  readonly enqueued: number;
  readonly accepted: number;
  readonly rejectedQueueFull: number;
  readonly enqueueLatencyMs: Distribution;
}

export interface JobsLaneSummary {
  readonly enqueued: number;
  readonly accepted: number;
  readonly rejectedQueueFull: number;
  readonly achievedEnqueuePerSecond: number;
  readonly enqueueLatencyMs: Distribution;
}

export function createJobsLane(
  composed: ComposedApplication,
  config: CapacityConfig,
  tenants: readonly string[],
) {
  const totals = { enqueued: 0, accepted: 0, rejectedQueueFull: 0, elapsedMs: 0 };
  const allLatencies: number[] = [];
  let windowLatencies: number[] = [];
  let windowStart = { ...totals };
  /** Never restarts, so warm-up and measured runs never share a `(tenant, period)` pair. */
  let sequence = 0;

  /** One `(tenant, period)` pair per enqueue so every outbox intent is distinct. */
  const inputFor = (index: number) => ({
    tenantId: tenants[index % tenants.length] as string,
    period: new Date(PERIOD_EPOCH + Math.floor(index / tenants.length) * DAY_MS)
      .toISOString()
      .slice(0, 10),
  });

  return {
    run: async (stopAt: number) => {
      const result = await paced(config.jobEnqueuePerSecond, stopAt, async () => {
        const started = performance.now();
        const outcome = await composed.backend.enqueue(JOB_ID, inputFor(sequence));
        sequence += 1;
        const latency = performance.now() - started;
        allLatencies.push(latency);
        windowLatencies.push(latency);
        totals.enqueued += 1;
        if (outcome.accepted) totals.accepted += 1;
        else totals.rejectedQueueFull += 1;
      });
      totals.elapsedMs = result.elapsedMs;
    },
    /** Forgets everything counted so far (end of warm-up). */
    reset: () => {
      totals.enqueued = 0;
      totals.accepted = 0;
      totals.rejectedQueueFull = 0;
      totals.elapsedMs = 0;
      allLatencies.length = 0;
      windowLatencies = [];
      windowStart = { ...totals };
    },
    window: (): JobsWindow => {
      const window: JobsWindow = {
        enqueued: totals.enqueued - windowStart.enqueued,
        accepted: totals.accepted - windowStart.accepted,
        rejectedQueueFull: totals.rejectedQueueFull - windowStart.rejectedQueueFull,
        enqueueLatencyMs: distribution(windowLatencies),
      };
      windowStart = { ...totals };
      windowLatencies = [];
      return window;
    },
    summary: (): JobsLaneSummary => ({
      enqueued: totals.enqueued,
      accepted: totals.accepted,
      rejectedQueueFull: totals.rejectedQueueFull,
      achievedEnqueuePerSecond:
        totals.elapsedMs > 0 ? Math.round((totals.enqueued / totals.elapsedMs) * 1_000) : 0,
      enqueueLatencyMs: distribution(allLatencies),
    }),
  };
}

export type JobsLane = ReturnType<typeof createJobsLane>;
