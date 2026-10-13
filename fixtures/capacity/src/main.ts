/**
 * Combined capacity baseline (SAPI-113 step 11). Starts one disposable
 * PostgreSQL and one Redis, two gateway processes and N worker processes,
 * composes the customized golden consumer in this API process, then runs the
 * jobs, realtime and webhook lanes concurrently for the configured duration
 * while sampling at a fixed interval. Writes a Markdown table and a JSON
 * summary under the output directory and prints the table.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { setupPostgresTestDb } from "@sixthsummit/ship-testing/postgres";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { portfolioSchema } from "../consumer/schema.js";
import { CHILD_READY_TIMEOUT_MS, type ManagedChild, spawnChild, withTimeout } from "./children.js";
import { composeCapacityApplication } from "./compose.js";
import { readCapacityConfig, tenantIds } from "./config.js";
import { createJobsLane, JOB_ID } from "./lanes/jobs.js";
import { createRealtimeLane } from "./lanes/realtime.js";
import { createWebhookLane } from "./lanes/webhooks.js";
import { type CapacitySummary, renderMarkdown, summaryTable } from "./report.js";
import { createSampler, type Sample } from "./sampler.js";
import { sleep, spread } from "./stats.js";

const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";

const config = readCapacityConfig();
const tenants = tenantIds(config.tenants);
const prefix = `capacity-${process.pid}-${Date.now().toString(36)}`;
const log = (message: string) => process.stdout.write(`[capacity] ${message}\n`);

log(
  `mode=${config.mode} duration=${config.durationSeconds}s sample=${config.sampleIntervalSeconds}s tenants=${config.tenants} sha=${config.gitSha}`,
);
log(`starting ${POSTGRES_IMAGE} and ${REDIS_IMAGE}`);
const database = await setupPostgresTestDb(portfolioSchema);
let redisContainer: StartedTestContainer | undefined;
const children: ManagedChild[] = [];
let exitCode = 0;
try {
  redisContainer = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  const common = {
    DATABASE_URL: database.connectionString,
    REDIS_URL: redisUrl,
    PREFIX: prefix,
    TENANTS: String(config.tenants),
  };
  const gatewayChildren = ["gateway-a", "gateway-b"].map((id) =>
    spawnChild(id, "gateway-process.ts", { ...common, GATEWAY_ID: id }),
  );
  const workerChildren = Array.from({ length: config.workerProcesses }, (_, index) =>
    spawnChild(`worker-${index + 1}`, "worker-process.ts", {
      ...common,
      WORKER_NAME: `worker-${index + 1}`,
      POOL_SIZE: String(config.dbPoolSize),
      MAX_IN_FLIGHT: String(config.workerMaxInFlight),
      DISPATCH_INTERVAL_MS: String(config.dispatchIntervalMs),
      DISPATCH_PASSES_PER_CYCLE: String(config.dispatchPassesPerCycle),
    }),
  );
  children.push(...gatewayChildren, ...workerChildren);
  const readiness = await withTimeout(
    Promise.all(children.map((child) => child.ready)),
    CHILD_READY_TIMEOUT_MS,
    "child processes",
  );
  const gateways = gatewayChildren.map((child, index) => ({
    id: child.name,
    port: Number((readiness[index] as Record<string, unknown>).port),
  }));
  log(
    `gateways ${gateways.map((gateway) => `${gateway.id}:${gateway.port}`).join(" ")}; workers ${workerChildren.length}`,
  );

  const composed = await composeCapacityApplication({
    databaseUrl: database.connectionString,
    redisUrl,
    prefix,
    processName: "api",
    poolSize: config.dbPoolSize,
    maxInFlight: config.workerMaxInFlight,
    tenants,
    mode: "api",
  });
  const lanes = {
    jobs: createJobsLane(composed, config, tenants),
    realtime: await createRealtimeLane(composed, config, gateways),
    webhooks: createWebhookLane(composed, config),
  };

  if (config.warmupSeconds > 0) {
    log(`warming up for ${config.warmupSeconds}s (not measured)`);
    const warmupStopAt = Date.now() + config.warmupSeconds * 1_000;
    await Promise.all([
      lanes.jobs.run(warmupStopAt),
      lanes.realtime.run(warmupStopAt),
      lanes.webhooks.run(warmupStopAt),
    ]);
    lanes.jobs.reset();
    lanes.realtime.reset();
    lanes.webhooks.reset();
  }

  const startedAt = Date.now();
  const stopAt = startedAt + config.durationSeconds * 1_000;
  const sampler = createSampler({
    composed,
    metrics: database.pool,
    tenants,
    lanes,
    startedAt,
  });
  // The t=0 sample records what warm-up left behind (outbox backlog, Redis memory).
  await sampler.sample("load");
  let sampling = true;
  let phase: Sample["phase"] = "load";
  const samplingLoop = (async () => {
    while (sampling) {
      await sleep(config.sampleIntervalSeconds * 1_000);
      if (!sampling) break;
      const sample = await sampler.sample(phase);
      log(
        `t=${sample.elapsedSeconds}s jobs waiting=${sample.jobs.waiting} active=${sample.jobs.active} oldest=${sample.jobs.oldestWaitingAgeMs}ms done=${sample.jobs.completed} fair=${sample.jobs.fairness.min}/${sample.jobs.fairness.median}/${sample.jobs.fairness.max} | pg backends=${sample.postgres.clientBackends} lockwait=${sample.postgres.locksNotGranted} | redis=${(sample.redis.usedMemoryBytes / 1024 / 1024).toFixed(1)}MiB | rt pub=${sample.realtime.published} recv=${sample.realtime.subscribers.map((item) => item.received).join("/")} late=${sample.realtime.subscribers.map((item) => item.late).join("/")} | wh sent=${sample.webhooks.sent} p95=${sample.webhooks.latencyMs.p95}ms`,
      );
    }
  })();

  log(`load window open for ${config.durationSeconds}s`);
  await Promise.all([
    lanes.jobs.run(stopAt),
    lanes.realtime.run(stopAt),
    lanes.webhooks.run(stopAt),
  ]);
  const loadSeconds = Math.round((Date.now() - startedAt) / 1_000);
  phase = "drain";
  log(`load window closed after ${loadSeconds}s; draining for up to ${config.drainSeconds}s`);

  const drainStartedAt = Date.now();
  await lanes.realtime.drain(Math.min(config.drainSeconds, 30) * 1_000);
  let drained = false;
  let outboxDrained = false;
  while (Date.now() - drainStartedAt < config.drainSeconds * 1_000) {
    const health = await composed.backend.health(new Date());
    const entry = health.jobs.find((item) => item.jobId === JOB_ID);
    drained = !entry || entry.waiting + entry.active + entry.delayed === 0;
    outboxDrained = (await sampler.outboxBacklog()) === 0;
    if (drained && outboxDrained) break;
    await sleep(500);
  }
  const drainMs = Date.now() - drainStartedAt;
  sampling = false;
  await samplingLoop;
  const finalSample = await sampler.sample("drain");
  log(
    `jobs drained=${drained}, outbox drained=${outboxDrained} in ${drainMs}ms; stopping children`,
  );

  const workerSummaries: Record<string, unknown>[] = [];
  const gatewaySummaries: Record<string, unknown>[] = [];
  const exitedEarly = children
    .filter((child) => child.process.exitCode !== null)
    .map((child) => child.name);
  for (const child of workerChildren)
    workerSummaries.push((await child.stop()) ?? { worker: child.name, missing: true });
  await lanes.realtime.close();
  for (const child of gatewayChildren)
    gatewaySummaries.push((await child.stop()) ?? { gatewayId: child.name, missing: true });

  const backendCounts = await composed.backend
    .queue(JOB_ID)
    .getJobCounts("completed", "failed", "waiting", "active", "delayed");
  const samples = sampler.samples();
  const perTenant = sampler.completedPerTenant();
  // The t=0 sample only records what warm-up left behind.
  const loadSamples = samples.filter(
    (sample) => sample.phase === "load" && sample.elapsedSeconds > 0,
  );
  const worstWindow = loadSamples.reduce<
    { at: string; spread: ReturnType<typeof spread> } | undefined
  >((worst, sample) => {
    if (sample.jobs.completed === 0) return worst;
    const ratio =
      sample.jobs.fairness.max === 0 ? 1 : sample.jobs.fairness.min / sample.jobs.fairness.max;
    const worstRatio = worst
      ? worst.spread.max === 0
        ? 1
        : worst.spread.min / worst.spread.max
      : Number.POSITIVE_INFINITY;
    return ratio < worstRatio ? { at: sample.at, spread: sample.jobs.fairness } : worst;
  }, undefined) ?? { at: finalSample.at, spread: finalSample.jobs.fairness };
  const peak = (select: (sample: Sample) => number): number =>
    samples.reduce((max, sample) => Math.max(max, select(sample)), 0);
  const jobs = lanes.jobs.summary();
  const realtime = lanes.realtime.summary();
  const webhooks = lanes.webhooks.summary();
  const deadLettered = backendCounts.failed ?? 0;
  const lag = sampler.lag();
  const firstLoad = loadSamples[0];
  const lastLoad = loadSamples[loadSamples.length - 1];
  const redisGrowthMiBPerMinute =
    firstLoad && lastLoad && lastLoad.elapsedSeconds > firstLoad.elapsedSeconds
      ? (lastLoad.redis.usedMemoryBytes - firstLoad.redis.usedMemoryBytes) /
        1024 /
        1024 /
        ((lastLoad.elapsedSeconds - firstLoad.elapsedSeconds) / 60)
      : 0;
  const failures: string[] = [];
  if (webhooks.unexpected > 0)
    failures.push(
      `${webhooks.unexpected} webhook responses had an unexpected status (${JSON.stringify(webhooks.unexpectedStatuses)})`,
    );
  if (deadLettered > 0) failures.push(`${deadLettered} job runs dead-lettered`);
  if (exitedEarly.length > 0)
    failures.push(`processes exited before the run ended: ${exitedEarly.join(", ")}`);
  const packages = await readProvenance();

  const summary: CapacitySummary = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    gitSha: config.gitSha,
    label: config.label,
    mode: config.mode,
    config,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      postgresImage: POSTGRES_IMAGE,
      redisImage: REDIS_IMAGE,
      packages,
    },
    loadSeconds,
    jobs: {
      ...jobs,
      completedRows: Object.values(perTenant).reduce((sum, value) => sum + value, 0),
      perTenant,
      fairness: spread(Object.values(perTenant)),
      worstWindowFairness: worstWindow,
      peakWaiting: peak((sample) => sample.jobs.waiting),
      peakDelayed: peak((sample) => sample.jobs.delayed),
      peakActive: peak((sample) => sample.jobs.active),
      peakOldestWaitingAgeMs: peak((sample) => sample.jobs.oldestWaitingAgeMs),
      queueLagMs: lag.queueLagMs,
      runMs: lag.runMs,
      lagSampled: lag.sampled,
      contendedRuns: lag.contendedRuns,
      backendCounts,
      deadLettered,
      drained,
      drainMs,
    },
    outboxBacklog: {
      startPending: samples[0]?.outboxPending ?? 0,
      peakPending: peak((sample) => sample.outboxPending),
      endOfLoadPending: lastLoad?.outboxPending ?? 0,
      finalPending: finalSample.outboxPending,
      drained: outboxDrained,
    },
    realtime,
    webhooks,
    postgres: {
      peakClientBackends: peak((sample) => sample.postgres.clientBackends),
      peakActive: peak((sample) => sample.postgres.active),
      peakIdleInTransaction: peak((sample) => sample.postgres.idleInTransaction),
      peakWaitingOnLock: peak((sample) => sample.postgres.waitingOnLock),
      peakLocksNotGranted: peak((sample) => sample.postgres.locksNotGranted),
    },
    redis: {
      peakUsedMemoryBytes: peak((sample) => sample.redis.usedMemoryBytes),
      peakConnectedClients: peak((sample) => sample.redis.connectedClients),
      growthMiBPerMinute: Math.round(redisGrowthMiBPerMinute * 10) / 10,
    },
    outbox: finalSample.outbox,
    workers: workerSummaries,
    gateways: gatewaySummaries,
    gates: { passed: failures.length === 0, failures },
    samples,
  };

  await composed.close();
  const outputDirectory = resolve(config.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const stem = `${summary.recordedAt.replace(/[:.]/gu, "-")}-${config.label}`;
  const markdown = renderMarkdown(summary);
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  await Promise.all([
    writeFile(resolve(outputDirectory, `${stem}.json`), json),
    writeFile(resolve(outputDirectory, `${stem}.md`), markdown),
    writeFile(resolve(outputDirectory, "latest.json"), json),
    writeFile(resolve(outputDirectory, "latest.md"), markdown),
  ]);
  process.stdout.write(`\n${summaryTable(summary)}\n\n`);
  log(`wrote ${resolve(outputDirectory, `${stem}.md`)} and .json`);
  if (!summary.gates.passed) {
    log(`gates failed: ${failures.join("; ")}`);
    exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `[capacity] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  exitCode = 1;
} finally {
  for (const child of children) await child.stop().catch(() => undefined);
  await database.cleanup().catch(() => undefined);
  await redisContainer?.stop().catch(() => undefined);
}
process.exit(exitCode);

async function readProvenance(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(
      await readFile(resolve(".ship", "framework-provenance.json"), "utf8"),
    ) as {
      packages?: Record<string, { version: string }>;
    };
    return Object.fromEntries(
      Object.entries(raw.packages ?? {}).map(([name, entry]) => [name, entry.version]),
    );
  } catch {
    return {};
  }
}
