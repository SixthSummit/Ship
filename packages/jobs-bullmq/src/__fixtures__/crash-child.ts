/**
 * Child-process entry for the crash/restart integration tests. Started with
 * `node --import tsx crash-child.ts` and REDIS_URL, DATABASE_URL, PREFIX,
 * WORKER_NAME and CRASH_AT; prints `ready` once workers run.
 */
import { type CrashPoint, createCrashRuntime } from "./crash-app.js";

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
const prefix = process.env.PREFIX;
const workerName = process.env.WORKER_NAME;
const crashAt = (process.env.CRASH_AT ?? "none") as CrashPoint;
if (!redisUrl || !databaseUrl || !prefix || !workerName) {
  throw new Error("crash-child requires REDIS_URL, DATABASE_URL, PREFIX and WORKER_NAME");
}

const runtime = await createCrashRuntime({
  redisUrl,
  databaseUrl,
  prefix,
  workerName,
  crashAt,
  mode: "worker",
});
process.stdout.write("ready\n");

const shutdown = async () => {
  await runtime.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
