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
import { Redis } from "ioredis";
import { z } from "zod";
import { createBullmqJobBackend } from "../backend.js";
import { createRedisLockProvider } from "../lock.js";

export interface FixtureRuntimeOptions {
  readonly redisUrl: string;
  readonly prefix: string;
  readonly workerName: string;
  readonly mode: "api" | "worker";
  /** Handler duration for the serial job, in milliseconds. */
  readonly holdMs?: number;
}

export interface FixtureEvent {
  readonly job: string;
  readonly worker: string;
  readonly key: string;
  readonly runId: string;
  readonly phase: "start" | "end";
  readonly at: number;
}

export const EVENTS_KEY = (prefix: string) => `${prefix}:fixture:events`;

/**
 * Two jobs used by the multi-process integration tests: a keyed single-runner
 * whose handler records start/end timestamps so overlap can be asserted, and
 * an interval-scheduled job whose runs record their durable run ids.
 */
export async function createFixtureRuntime(options: FixtureRuntimeOptions): Promise<{
  readonly runtime: JobRuntime;
  readonly redis: Redis;
  readonly backend: ReturnType<typeof createBullmqJobBackend>;
}> {
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const record = async (event: FixtureEvent) => {
    await redis.rpush(EVENTS_KEY(options.prefix), JSON.stringify(event));
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
  const backend = createBullmqJobBackend({
    connection: { host: redis.options.host, port: redis.options.port, maxRetriesPerRequest: null },
    prefix: options.prefix,
    maxInFlight: 8,
    worker: { lockDuration: 3_000, stalledInterval: 1_000 },
  });
  const app = defineApp({
    id: "fixture-jobs",
    modules: [
      defineModule({
        id: "fixture",
        operations: [serial, tick],
        providers: [
          valueProvider(jobBackendDependency(), backend),
          valueProvider(
            lockProviderDependency(),
            createRedisLockProvider({ client: redis, keyPrefix: `${options.prefix}:lock` }),
          ),
        ],
        imports: [],
        exports: [],
      }),
    ],
  });
  const runtime = await startJobRuntime(app, { backend, mode: options.mode });
  return { runtime, redis, backend };
}

export function parseEvents(raw: readonly string[]): readonly FixtureEvent[] {
  return raw.map((item) => JSON.parse(item) as FixtureEvent);
}
