import { defineOutbox, effectDependency, outboxIntent } from "@sixthsummit/ship-core";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDrizzleOutbox, shipOutboxTable } from "./outbox.js";

/**
 * Load-shaped claim test (SAPI-114). The capacity baseline observed the claim
 * slowing from ~240 rows/s at a 12k backlog to ~16 rows/s at 205k pending
 * rows: the claim ordered every due row by `available_at` before `LIMIT`,
 * and the composite index could not serve that order. This test seeds a
 * realistic backlog at two sizes and asserts the claim latency does not grow
 * with it. It prints the `EXPLAIN (ANALYZE, BUFFERS)` plan of every statement
 * the claim issues at both sizes; those plans are recorded in the ADR-0014
 * addendum.
 */

const outboxTable = shipOutboxTable();
const schema = { outboxTable };
type Schema = typeof schema;

interface Notifier {
  send(message: { readonly recipient: string }): Promise<void>;
}
const notifier = effectDependency<Notifier>("reports.notifier", { delivery: "immediate" });
const outbox = defineOutbox({
  id: "reports.outbox",
  retention: { completedMs: 60_000, deadLetteredMs: 120_000 },
  intents: {
    notify: outboxIntent({
      payload: z.object({ recipient: z.string().email() }),
      effect: notifier,
      perform: ({ effect, payload }) => effect.send(payload),
    }),
  },
});

const SMALL_BACKLOG = 1_000;
const LARGE_BACKLOG = 200_000;
const BATCH_SIZE = 25;
const LEASE_MS = 30_000;
const CLAIMS_PER_SIZE = 30;
const WARMUP_CLAIMS = 5;
/**
 * The bound: the large-backlog p95 may not exceed five times the small one,
 * with a 25 ms floor so a sub-millisecond small baseline does not turn timer
 * jitter into a failure. A claim of 25 rows through the partial index reads
 * the same ~25 index entries whatever the backlog, so anything that grows
 * with the backlog (a sort of every due row) fails this by two orders of
 * magnitude, which is what the baseline observed before the fix.
 */
const RATIO_BOUND = 5;
const FLOOR_MS = 25;

describe("Drizzle outbox claim under a large backlog", () => {
  let context: PostgresTestDb<Schema>;

  beforeAll(async () => {
    context = await setupPostgresTestDb(schema);
  });

  beforeEach(async () => {
    await truncateAll(context);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  /**
   * Seeds `pending` due rows whose `available_at` is spread over the last ten
   * minutes (the shape a backlog has after a sustained write rate), plus half
   * as many completed rows and a few lease-expired claimed rows, so the table
   * is not a single status.
   */
  async function seed(pending: number): Promise<void> {
    await context.pool.query(
      `insert into ship_outbox (outbox_id, intent_id, payload, dedupe_key, status, attempts, available_at, created_at)
       select 'reports.outbox', 'notify', jsonb_build_object('recipient', 'user' || g || '@example.test'),
              'pending-' || g, 'pending', 0,
              now() - (interval '600 seconds' * random()),
              now() - (interval '600 seconds' * random())
       from generate_series(1, $1) as g`,
      [pending],
    );
    await context.pool.query(
      `insert into ship_outbox (outbox_id, intent_id, payload, dedupe_key, status, attempts, available_at, created_at, completed_at)
       select 'reports.outbox', 'notify', jsonb_build_object('recipient', 'done' || g || '@example.test'),
              'completed-' || g, 'completed', 1,
              now() - (interval '3600 seconds' * random()),
              now() - (interval '3600 seconds' * random()),
              now() - (interval '1800 seconds' * random())
       from generate_series(1, $1) as g`,
      [Math.floor(pending / 2)],
    );
    await context.pool.query(
      `insert into ship_outbox (outbox_id, intent_id, payload, dedupe_key, status, attempts, available_at, created_at, lease_expires_at)
       select 'reports.outbox', 'notify', jsonb_build_object('recipient', 'stale' || g || '@example.test'),
              'stale-' || g, 'claimed', 1,
              now() - interval '120 seconds', now() - interval '120 seconds', now() - interval '60 seconds'
       from generate_series(1, 10) as g`,
    );
    // Flush the bulk insert's dirty pages before measuring so background
    // writes from the seed do not land inside the timed claims.
    await context.pool.query("vacuum analyze ship_outbox");
    await context.pool.query("checkpoint");
  }

  interface Measurement {
    readonly latenciesMs: readonly number[];
    readonly claimed: number;
    readonly statements: readonly { readonly text: string; readonly values: unknown[] }[];
  }

  async function measure(): Promise<Measurement> {
    const backend = createDrizzleOutbox({ outbox, database: context.db, table: outboxTable });
    const statements: { text: string; values: unknown[] }[] = [];
    const pool = context.pool as unknown as {
      query: (config: unknown, values?: unknown, callback?: unknown) => unknown;
    };
    const original = pool.query;
    // Record every statement the first claim issues so the EXPLAIN below runs
    // the adapter's own SQL rather than a hand-written copy of it.
    pool.query = function record(config: unknown, values?: unknown, callback?: unknown) {
      const text =
        typeof config === "string" ? config : (Reflect.get(config as object, "text") as string);
      const params = Array.isArray(values)
        ? values
        : ((Reflect.get((config as object) ?? {}, "values") as unknown[] | undefined) ?? []);
      if (typeof text === "string" && /ship_outbox/u.test(text)) {
        statements.push({ text, values: [...params] });
      }
      return original.call(this, config, values, callback);
    };
    let claimed = 0;
    try {
      claimed += (await backend.claimDue(new Date(), BATCH_SIZE, LEASE_MS)).length;
    } finally {
      pool.query = original;
    }
    for (let index = 0; index < WARMUP_CLAIMS; index += 1) {
      claimed += (await backend.claimDue(new Date(), BATCH_SIZE, LEASE_MS)).length;
    }
    const latenciesMs: number[] = [];
    for (let index = 0; index < CLAIMS_PER_SIZE; index += 1) {
      const startedAt = process.hrtime.bigint();
      const records = await backend.claimDue(new Date(), BATCH_SIZE, LEASE_MS);
      latenciesMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      claimed += records.length;
    }
    return { latenciesMs, claimed, statements };
  }

  async function explain(statements: Measurement["statements"]): Promise<string> {
    const plans: string[] = [];
    for (const statement of statements) {
      // Each claim statement is run inside a rolled-back transaction so the
      // plan reflects the same backlog the measured claims saw.
      const client = await context.pool.connect();
      try {
        await client.query("begin");
        const result = await client.query(
          `explain (analyze, buffers, format text) ${statement.text}`,
          statement.values,
        );
        plans.push(
          `-- ${statement.text}\n${result.rows.map((row) => row["QUERY PLAN"]).join("\n")}`,
        );
        await client.query("rollback");
      } finally {
        client.release();
      }
    }
    return plans.join("\n\n");
  }

  function percentile(values: readonly number[], fraction: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return sorted[index] ?? 0;
  }

  it("claims a batch in bounded time from 1k to 200k pending rows", async () => {
    await seed(SMALL_BACKLOG);
    const small = await measure();
    const smallPlan = await explain(small.statements);
    await truncateAll(context);
    await seed(LARGE_BACKLOG);
    const large = await measure();
    const largePlan = await explain(large.statements);
    console.log(`\n[outbox claim rows] small=${small.claimed} large=${large.claimed}\n`);

    const smallP50 = percentile(small.latenciesMs, 0.5);
    const smallP95 = percentile(small.latenciesMs, 0.95);
    const largeP50 = percentile(large.latenciesMs, 0.5);
    const largeP95 = percentile(large.latenciesMs, 0.95);
    const summary = [
      `| pending rows | claims | p50 (ms) | p95 (ms) | max (ms) |`,
      `| ---: | ---: | ---: | ---: | ---: |`,
      `| ${SMALL_BACKLOG} | ${small.latenciesMs.length} | ${smallP50.toFixed(2)} | ${smallP95.toFixed(2)} | ${Math.max(...small.latenciesMs).toFixed(2)} |`,
      `| ${LARGE_BACKLOG} | ${large.latenciesMs.length} | ${largeP50.toFixed(2)} | ${largeP95.toFixed(2)} | ${Math.max(...large.latenciesMs).toFixed(2)} |`,
    ].join("\n");
    console.log(`\n[outbox claim latency]\n${summary}\n`);
    console.log(`\n[outbox claim plan at ${SMALL_BACKLOG} pending]\n${smallPlan}\n`);
    console.log(`\n[outbox claim plan at ${LARGE_BACKLOG} pending]\n${largePlan}\n`);

    // Every claim returned a full batch: the backlog is due and unlocked
    // (the 10 lease-expired rows are retaken first, then pending rows).
    expect(small.claimed).toBe(BATCH_SIZE * (CLAIMS_PER_SIZE + WARMUP_CLAIMS + 1));
    expect(large.claimed).toBe(BATCH_SIZE * (CLAIMS_PER_SIZE + WARMUP_CLAIMS + 1));
    expect(largeP95).toBeLessThanOrEqual(Math.max(RATIO_BOUND * smallP95, FLOOR_MS));
  }, 300_000);
});
