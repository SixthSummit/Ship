import {
  createExecutor,
  defineApp,
  defineJob,
  defineJobCleanup,
  defineModule,
  defineOutbox,
  defineOutboxDispatcher,
  effectDependency,
  idempotencyStoreDependency,
  type JobBackend,
  type JobRuntime,
  jobBackendDependency,
  lockProviderDependency,
  outboxDependency,
  outboxIntent,
  startJobRuntime,
  systemActor,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import {
  createDrizzleIdempotencyStore,
  createDrizzleOutbox,
  createDrizzleUnitOfWork,
  shipIdempotencyTable,
  shipOutboxTable,
} from "@sixthsummit/ship-drizzle";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { Redis } from "ioredis";
import pg from "pg";
import { z } from "zod";
import { createBullmqJobBackend } from "../backend.js";
import { createRedisLockProvider } from "../lock.js";
import { reportConnectionError } from "./report.js";

export type CrashPoint = "none" | "before-commit" | "after-commit" | "after-effect";

export const crashRecords = pgTable("crash_records", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliveries = pgTable("crash_deliveries", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  worker: text("worker").notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
});

export const crashOutboxTable = shipOutboxTable("crash_outbox");
export const crashIdempotencyTable = shipIdempotencyTable("crash_idempotency");
export const crashSchema = { crashRecords, deliveries, crashOutboxTable, crashIdempotencyTable };
export type CrashSchema = typeof crashSchema;

interface Notifier {
  deliver(key: string): Promise<void>;
}
interface Capabilities {
  readonly records: { insert(key: string): Promise<void> };
}

export const notifier = effectDependency<Notifier>("crash.notifier", { delivery: "immediate" });
const unitOfWork = unitOfWorkDependency<Capabilities>("database.crash");
const idempotencyStore = idempotencyStoreDependency("crash.idempotency");

export const crashOutbox = defineOutbox({
  id: "crash.outbox",
  retention: { completedMs: 300, deadLetteredMs: 300 },
  intents: {
    notify: outboxIntent({
      payload: z.object({ key: z.string().min(1) }),
      effect: notifier,
      perform: ({ effect, payload }) => effect.deliver(payload.key),
    }),
  },
});

export interface CrashApplicationOptions {
  readonly database: NodePgDatabase<CrashSchema>;
  readonly backend: JobBackend;
  readonly redis: Redis;
  readonly prefix: string;
  readonly workerName: string;
  readonly crashAt: CrashPoint;
}

/**
 * A write job that records a row and a delivery intent in one transaction
 * under an idempotency key, plus the outbox dispatcher that performs the
 * delivery. `crashAt` injects `process.exit` at the documented failure points.
 */
export function createCrashApplication(options: CrashApplicationOptions) {
  const { database } = options;
  const write = defineJob({
    id: "crash.write",
    input: z.object({ key: z.string().min(1) }),
    trigger: { kind: "enqueue" },
    concurrency: { mode: "parallel", max: 2 },
    retry: { attempts: 3, backoff: { initialMs: 50 } },
    idempotency: { key: (input) => input.key, windowMs: 60_000, store: idempotencyStore },
    retention: { completedMs: 300, deadLetteredMs: 300 },
    transaction: "write",
    dependencies: { tx: unitOfWork, outbox: outboxDependency(crashOutbox) },
    handler: async ({ input, services }) => {
      await services.tx.records.insert(input.key);
      await services.outbox.enqueue("notify", { key: input.key }, { dedupeKey: input.key });
      if (options.crashAt === "before-commit") process.exit(3);
      return { key: input.key };
    },
  });
  const dispatcher = defineOutboxDispatcher(crashOutbox, {
    batchSize: 10,
    lease: { ms: 1_000 },
    retry: { attempts: 3, backoff: { initialMs: 50 } },
    deadLetter: true,
  });
  const cleanup = defineJobCleanup({
    id: "crash.cleanup",
    trigger: { kind: "interval", everyMs: 60_000 },
    outboxes: [crashOutbox],
  });
  const module = defineModule({
    id: "crash",
    operations: [write, ...dispatcher.operations, cleanup],
    providers: [
      valueProvider(
        unitOfWork,
        createDrizzleUnitOfWork({
          id: "database.crash",
          database,
          create: (transaction) => ({
            records: {
              insert: async (key: string) => {
                await transaction.insert(crashRecords).values({ key });
              },
            },
          }),
        }),
      ),
      valueProvider(
        crashOutbox.writer,
        createDrizzleOutbox({ outbox: crashOutbox, database, table: crashOutboxTable }),
      ),
      valueProvider(
        idempotencyStore,
        createDrizzleIdempotencyStore({ database, table: crashIdempotencyTable }),
      ),
      valueProvider(notifier, {
        deliver: async (key: string) => {
          await database.insert(deliveries).values({ key, worker: options.workerName });
          if (options.crashAt === "after-effect") process.exit(3);
        },
      }),
      valueProvider(jobBackendDependency(), options.backend),
      valueProvider(
        lockProviderDependency(),
        createRedisLockProvider({ client: options.redis, keyPrefix: `${options.prefix}:lock` }),
      ),
    ],
    imports: [],
    exports: [],
  });
  return defineApp({ id: "crash-fixture", modules: [module] });
}

export interface CrashRuntimeOptions {
  readonly redisUrl: string;
  readonly databaseUrl: string;
  readonly prefix: string;
  readonly workerName: string;
  readonly crashAt: CrashPoint;
  readonly mode: "api" | "worker";
  /** Dispatcher polling interval in worker mode. */
  readonly dispatchEveryMs?: number;
}

export async function createCrashRuntime(options: CrashRuntimeOptions) {
  const report = reportConnectionError(`crash-fixture ${options.workerName}`);
  // Both clients need `error` listeners: a connection the server drops (the
  // container stopping, a reset under load) otherwise surfaces as an
  // unhandled 'error' event that kills the process mid-recovery.
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 4 });
  pool.on("error", report("pg pool"));
  const database = drizzle(pool, { schema: crashSchema });
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  redis.on("error", report("ioredis"));
  const bullmq = createBullmqJobBackend({
    connection: { host: redis.options.host, port: redis.options.port, maxRetriesPerRequest: null },
    prefix: options.prefix,
    maxInFlight: 4,
    worker: { lockDuration: 2_000, stalledInterval: 500, maxStalledCount: 10 },
    onError: (error, context) => report(`bullmq ${context.jobId}`)(error),
  });
  // The after-commit crash point sits between the executor's commit and the
  // moment BullMQ would record completion: the run is committed but not done.
  const backend: JobBackend = {
    ...bullmq,
    attach: (binding) =>
      bullmq.attach({
        ...binding,
        execute: async (jobId, input, run) => {
          const outcome = await binding.execute(jobId, input, run);
          if (options.crashAt === "after-commit" && jobId === "crash.write" && outcome.ok) {
            process.exit(3);
          }
          // One line per run so a slow recovery in CI shows whether the
          // worker ever received the job and what each attempt returned.
          process.stderr.write(
            `[crash-fixture ${options.workerName}] ${run.runId} attempt ${run.attempt}: ${
              outcome.ok ? "ok" : `failed (${outcome.error})`
            }\n`,
          );
          return outcome;
        },
      }),
  };
  const app = createCrashApplication({
    database,
    backend,
    redis,
    prefix: options.prefix,
    workerName: options.workerName,
    crashAt: options.crashAt,
  });
  const runtime: JobRuntime = await startJobRuntime(app, { backend, mode: options.mode });
  const executor = createExecutor(app);
  // Passes never overlap: the next one is scheduled after the previous
  // finishes, so a slow pass under load cannot pile up concurrent claims
  // that outlive the 1 s lease and re-deliver an intent this process holds.
  let dispatching: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  if (options.mode === "worker") {
    const everyMs = options.dispatchEveryMs ?? 200;
    const pass = async () => {
      await executor
        .run("crash.outbox.dispatch", {}, { actor: systemActor({ id: "crash.dispatcher" }) })
        .catch(() => undefined);
      if (!stopped) dispatching = setTimeout(() => void pass(), everyMs);
    };
    dispatching = setTimeout(() => void pass(), everyMs);
  }
  return {
    app,
    executor,
    backend: bullmq,
    database,
    redis,
    runtime,
    stop: async () => {
      stopped = true;
      if (dispatching) clearTimeout(dispatching);
      await runtime.stop();
      await redis.quit().catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
  };
}
