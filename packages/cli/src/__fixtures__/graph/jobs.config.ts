import {
  defineApp,
  defineJob,
  defineJobManagement,
  defineModule,
  type JobBackend,
  jobBackendDependency,
  jobDependency,
  type LockProvider,
  lockProviderDependency,
  permission,
  valueProvider,
} from "@sixthsummit/ship-core";
import { z } from "zod";

const lock: LockProvider = {
  kind: "ship.lock-provider",
  acquire: async (jobId, key, ttlMs) => ({
    jobId,
    key,
    token: "fixture",
    expiresAt: new Date(Date.now() + ttlMs),
  }),
  release: async () => undefined,
};

const backend: JobBackend = {
  kind: "ship.job-backend",
  adapter: "fixture",
  concurrencyBudget: { maxInFlight: 1, maxQueueDepth: 1 },
  attach: () => undefined,
  enqueue: async () => ({ accepted: true, runId: "fixture", deduplicated: false }),
  schedule: async () => undefined,
  unschedule: async () => undefined,
  startWorkers: async () => 0,
  quit: async () => undefined,
  health: async () => ({ jobs: [] }),
  listFailed: async () => [],
  retry: async () => undefined,
  discard: async () => undefined,
  cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
};

const render = defineJob({
  id: "reports.render",
  input: z.object({ tenantId: z.string() }),
  trigger: { kind: "enqueue" },
  concurrency: { mode: "parallel", max: 3 },
  retry: { attempts: 2, backoff: { initialMs: 50 } },
  transaction: "none",
  dependencies: {},
  handler: async () => undefined,
});

const digest = defineJob({
  id: "reports.digest",
  input: z.object({ tenantId: z.string() }),
  trigger: { kind: "schedule", cron: "0 6 * * *", tz: "UTC" },
  concurrency: { mode: "single-runner", key: (input) => input.tenantId },
  retry: { attempts: 3, backoff: { initialMs: 100, multiplier: 2, maxMs: 1_000 } },
  retention: { completedMs: 60_000, deadLetteredMs: 120_000 },
  transaction: "none",
  dependencies: { render: jobDependency(render) },
  handler: async ({ input, services }) => services.render.enqueue({ tenantId: input.tenantId }),
});

const sweep = defineJob({
  id: "reports.sweep",
  input: z.object({}),
  trigger: { kind: "interval", everyMs: 60_000 },
  concurrency: { mode: "single-runner", reason: "one sweep covers every tenant" },
  retry: { attempts: 1, backoff: { initialMs: 10 } },
  transaction: "none",
  dependencies: {},
  handler: async () => undefined,
});

const management = defineJobManagement();

export const app = defineApp({
  id: "jobs-fixture",
  modules: [
    defineModule({
      id: "reports",
      operations: [render, digest, sweep],
      providers: [
        valueProvider(jobBackendDependency(), backend),
        valueProvider(lockProviderDependency(), lock),
      ],
      imports: [],
      exports: [jobBackendDependency()],
    }),
    defineModule({
      id: "jobs",
      operations: management.operations,
      providers: [],
      imports: ["reports"],
      exports: [],
    }),
  ],
  runtime: { workers: { mode: "worker", budget: 4 } },
});

void permission;
