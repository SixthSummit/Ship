/**
 * Child-process entry for the multi-process integration tests. Started with
 * `node --import tsx worker-child.ts` and the REDIS_URL, PREFIX and
 * WORKER_NAME environment variables; prints `ready` once workers run and
 * stops gracefully on SIGTERM.
 */
import { createFixtureRuntime } from "./single-runner-app.js";

const redisUrl = process.env.REDIS_URL;
const prefix = process.env.PREFIX;
const workerName = process.env.WORKER_NAME;
if (!redisUrl || !prefix || !workerName) {
  throw new Error("worker-child requires REDIS_URL, PREFIX and WORKER_NAME");
}

const { runtime, redis } = await createFixtureRuntime({
  redisUrl,
  prefix,
  workerName,
  mode: "worker",
  holdMs: Number(process.env.HOLD_MS ?? 150),
});
process.stdout.write("ready\n");

const shutdown = async () => {
  await runtime.stop();
  await redis.quit().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
