import {
  defineApp,
  defineJob,
  defineModule,
  type JobRuntime,
  jobBackendDependency,
  lockProviderDependency,
  startJobRuntime,
  valueProvider,
} from "@sixthsummit/ship-core";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import pg from "pg";
import { z } from "zod";
import { createDrizzleJobBackend, type DrizzleJobBackend } from "../job-backend.js";
import { shipJobRunsTable, shipJobStateTable } from "../job-store.js";

export type CrashPoint = "none" | "after-effect";

export const fixtureEvents = pgTable("job_fixture_events", {
  id: serial("id").primaryKey(),
  job: text("job").notNull(),
  worker: text("worker").notNull(),
  key: text("key").notNull(),
  runId: text("run_id").notNull(),
  phase: text("phase").notNull(),
  at: bigint("at", { mode: "number" }).notNull(),
});

export const fixtureDeliveries = pgTable("job_fixture_deliveries", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  worker: text("worker").notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fixtureRuns = shipJobRunsTable("job_fixture_runs");
export const fixtureState = shipJobStateTable("job_fixture_state");
export const fixtureSchema = { fixtureEvents, fixtureDeliveries, fixtureRuns, fixtureState };
export type FixtureSchema = typeof fixtureSchema;

export interface FixtureEvent {
  readonly job: string;
  readonly worker: string;
  readonly key: string;
  readonly runId: string;
  readonly phase: "start" | "end";
  readonly at: number;
}

export interface FixtureRuntimeOptions {
  readonly databaseUrl: string;
  readonly workerName: string;
  readonly mode: "api" | "worker";
  /** Minimum handler duration for the serial job, in milliseconds. */
  readonly holdMs?: number;
  /**
   * Upper bound on how long a serial run waits, after `holdMs`, for a run of
   * another key to be in progress before it records its end. Defaults to 5 s.
   */
  readonly overlapWaitMs?: number;
  readonly crashAt?: CrashPoint;
}

/**
 * Three jobs for the multi-process integration tests: a keyed single-runner
 * whose handler records start/end timestamps so overlap can be asserted, an
 * interval-scheduled job whose runs record their durable run ids, and a
 * parallel job that performs an external effect and, when asked, dies
 * before the backend records completion.
 *
 * The serial handler is a barrier, not a timer: after `holdMs` it keeps its
 * key busy until it has observed a run of another key in progress (a start
 * event without an end), so overlap between keys is a property the backend
 * must deliver rather than one the scheduler happens to produce. It stops
 * waiting as soon as no other key has unfinished runs left, and gives up
 * after `overlapWaitMs` so a backend that serializes keys fails the test
 * instead of hanging it.
 */
export async function createFixtureRuntime(options: FixtureRuntimeOptions): Promise<{
  readonly runtime: JobRuntime;
  readonly backend: DrizzleJobBackend;
  readonly database: ReturnType<typeof drizzle<FixtureSchema>>;
  stop(): Promise<void>;
}> {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 8 });
  const database = drizzle(pool, { schema: fixtureSchema });
  const record = async (event: FixtureEvent) => {
    await database.insert(fixtureEvents).values(event);
  };
  /**
   * Resolves once a serial run of a key other than `key` has recorded its start
   * but not its end, or once no such key has waiting or active runs left, or
   * after `overlapWaitMs`. Reading the other run's open start here, before this
   * run records its end, is what makes the two intervals overlap by construction.
   */
  const otherKeyInProgress = async (key: string) => {
    const deadline = Date.now() + (options.overlapWaitMs ?? 5_000);
    while (Date.now() < deadline) {
      const [open] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(fixtureEvents)
        .where(
          and(
            eq(fixtureEvents.job, "fixture.serial"),
            eq(fixtureEvents.phase, "start"),
            ne(fixtureEvents.key, key),
            notInArray(
              fixtureEvents.runId,
              database
                .select({ runId: fixtureEvents.runId })
                .from(fixtureEvents)
                .where(
                  and(eq(fixtureEvents.job, "fixture.serial"), eq(fixtureEvents.phase, "end")),
                ),
            ),
          ),
        );
      if ((open?.count ?? 0) > 0) return;
      const [remaining] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(fixtureRuns)
        .where(
          and(
            eq(fixtureRuns.jobId, "fixture.serial"),
            ne(fixtureRuns.key, key),
            inArray(fixtureRuns.status, ["waiting", "active"]),
          ),
        );
      if ((remaining?.count ?? 0) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const serial = defineJob({
    id: "fixture.serial",
    input: z.object({ tenantId: z.string().min(1), index: z.number().int() }),
    trigger: { kind: "enqueue" },
    concurrency: {
      mode: "single-runner",
      max: 4,
      key: (input) => input.tenantId,
      leaseMs: 2_000,
    },
    retry: { attempts: 5, backoff: { initialMs: 20, maxMs: 100 } },
    transaction: "none",
    dependencies: {},
    handler: async ({ input, context }) => {
      const base = {
        job: "fixture.serial",
        worker: options.workerName,
        key: input.tenantId,
        runId: context.requestId,
      };
      await record({ ...base, phase: "start", at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, options.holdMs ?? 150));
      await otherKeyInProgress(input.tenantId);
      await record({ ...base, phase: "end", at: Date.now() });
      return { index: input.index };
    },
  });
  const tick = defineJob({
    id: "fixture.tick",
    input: z.object({}),
    trigger: { kind: "interval", everyMs: 400 },
    concurrency: { mode: "parallel", max: 2 },
    retry: { attempts: 1, backoff: { initialMs: 10 } },
    transaction: "none",
    dependencies: {},
    handler: async ({ context }) => {
      await record({
        job: "fixture.tick",
        worker: options.workerName,
        key: "",
        runId: context.requestId,
        phase: "start",
        at: Date.now(),
      });
    },
  });
  const effect = defineJob({
    id: "fixture.effect",
    input: z.object({ key: z.string().min(1) }),
    trigger: { kind: "enqueue" },
    concurrency: { mode: "parallel", max: 2, leaseMs: 1_000 },
    retry: { attempts: 3, backoff: { initialMs: 50 } },
    transaction: "none",
    dependencies: {},
    handler: async ({ input }) => {
      await database
        .insert(fixtureDeliveries)
        .values({ key: input.key, worker: options.workerName });
      if (options.crashAt === "after-effect") process.exit(3);
      return { key: input.key };
    },
  });
  const backend = createDrizzleJobBackend({
    database,
    table: fixtureRuns,
    stateTable: fixtureState,
    pollIntervalMs: 50,
    maxInFlight: 8,
  });
  const app = defineApp({
    id: "fixture-jobs",
    modules: [
      defineModule({
        id: "fixture",
        operations: [serial, tick, effect],
        providers: [
          valueProvider(jobBackendDependency(), backend),
          valueProvider(lockProviderDependency(), backend.lockProvider),
        ],
        imports: [],
        exports: [],
      }),
    ],
  });
  const runtime = await startJobRuntime(app, { backend, mode: options.mode });
  return {
    runtime,
    backend,
    database,
    stop: async () => {
      await runtime.stop();
      await pool.end().catch(() => undefined);
    },
  };
}
