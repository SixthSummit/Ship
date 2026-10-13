/**
 * Child-process entry for the multi-process and crash integration tests.
 * Started with `node --import tsx job-worker-child.ts` and DATABASE_URL,
 * WORKER_NAME, optional HOLD_MS and CRASH_AT; prints `ready` once workers
 * run and stops gracefully on SIGTERM.
 */
import { type CrashPoint, createFixtureRuntime } from "./job-fixture-app.js";

const databaseUrl = process.env.DATABASE_URL;
const workerName = process.env.WORKER_NAME;
if (!databaseUrl || !workerName) {
  throw new Error("job-worker-child requires DATABASE_URL and WORKER_NAME");
}

const runtime = await createFixtureRuntime({
  databaseUrl,
  workerName,
  mode: "worker",
  holdMs: Number(process.env.HOLD_MS ?? 150),
  crashAt: (process.env.CRASH_AT ?? "none") as CrashPoint,
});
process.stdout.write("ready\n");

const shutdown = async () => {
  await runtime.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
