export interface Distribution {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) if (value > max) max = value;
  return {
    count: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(max),
  };
}

export interface Spread {
  readonly min: number;
  readonly median: number;
  readonly max: number;
}

/** Fairness view of per-key counts: the smallest, middle and largest share. */
export function spread(counts: readonly number[]): Spread {
  if (counts.length === 0) return { min: 0, median: 0, max: 0 };
  const sorted = [...counts].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : (sorted[middle] as number);
  return {
    min: sorted[0] as number,
    median: round(median),
    max: sorted[sorted.length - 1] as number,
  };
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `producer` at `perSecond` until `stopAt` (ms epoch) with drift-free pacing. */
export async function paced(
  perSecond: number,
  stopAt: number,
  producer: (index: number) => Promise<void>,
): Promise<{ readonly count: number; readonly elapsedMs: number }> {
  const intervalMs = 1_000 / perSecond;
  const startedAt = performance.now();
  const startedAtEpoch = Date.now();
  let index = 0;
  while (Date.now() < stopAt) {
    await producer(index);
    index += 1;
    const target = startedAt + index * intervalMs;
    const wait = target - performance.now();
    if (wait > 0) await sleep(wait);
  }
  return { count: index, elapsedMs: Date.now() - startedAtEpoch };
}

/** Runs `tasks` with at most `limit` in flight. */
export async function withConcurrency(
  limit: number,
  tasks: readonly (() => Promise<void>)[],
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next] as () => Promise<void>;
      next += 1;
      await task();
    }
  });
  await Promise.all(lanes);
}
