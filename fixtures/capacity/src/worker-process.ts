/**
 * Worker process: runs the consumer's declared jobs at their declared
 * concurrency through the BullMQ backend and drives the four outbox
 * dispatchers (report notifications, payment webhooks, cache invalidation,
 * realtime publication) with the framework's adaptive dispatch runner: a
 * full batch is followed by the next pass at once, a short or empty pass
 * waits the dispatch interval. Prints a ready line once workers run and a
 * summary line on SIGTERM.
 */
import {
  type OutboxDispatchRunnerPass,
  startOutboxDispatchRunner,
  systemActor,
} from "@sixthsummit/ship-core";
import { composeCapacityApplication } from "./compose.js";
import { tenantIds } from "./config.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`worker-process requires ${name}`);
  return value;
};

const DISPATCHERS = [
  "reports.outbox.dispatch",
  "payments.outbox.dispatch",
  "ship-cache.invalidation.dispatch",
  "ship-realtime.publication.dispatch",
] as const;

const workerName = required("WORKER_NAME");
const dispatchIntervalMs = Number(required("DISPATCH_INTERVAL_MS"));
const dispatchPassesPerCycle = Number(required("DISPATCH_PASSES_PER_CYCLE"));
const composed = await composeCapacityApplication({
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  prefix: required("PREFIX"),
  processName: workerName,
  poolSize: Number(required("POOL_SIZE")),
  maxInFlight: Number(required("MAX_IN_FLIGHT")),
  tenants: tenantIds(Number(required("TENANTS"))),
  mode: "worker",
});

const dispatched: Record<string, Record<string, number>> = Object.fromEntries(
  DISPATCHERS.map((id) => [id, { rounds: 0, errors: 0 }]),
);
const observe = (id: string, pass: OutboxDispatchRunnerPass) => {
  const tally = dispatched[id] as Record<string, number>;
  tally.rounds += 1;
  if (!pass.ok) {
    tally.errors += 1;
    process.stderr.write(`[dispatch ${id}] ${String(pass.error)}\n`);
    return;
  }
  for (const [field, value] of Object.entries(pass.result)) {
    if (field !== "batchSize" && typeof value === "number") {
      tally[field] = (tally[field] ?? 0) + value;
    }
  }
};
const runners = DISPATCHERS.map((id) =>
  startOutboxDispatchRunner(composed.executor, id, {
    actor: systemActor({ id: "capacity.dispatcher" }),
    intervalMs: dispatchIntervalMs,
    maxPassesPerCycle: dispatchPassesPerCycle,
    observer: { pass: (pass) => observe(id, pass) },
  }),
);

process.stdout.write(
  `${JSON.stringify({ ready: true, worker: workerName, workers: composed.runtime.workers, scheduled: composed.runtime.scheduled })}\n`,
);

const shutdown = async () => {
  await Promise.all(runners.map((runner) => runner.stop()));
  const liveness = composed.runtime.liveness();
  await composed.close();
  process.stdout.write(
    `${JSON.stringify({
      summary: true,
      worker: workerName,
      dispatched,
      jobs: liveness.jobs.map((entry) => ({
        jobId: entry.jobId,
        completed: entry.completed,
        failed: entry.failed,
      })),
      effects: composed.counters,
    })}\n`,
  );
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
