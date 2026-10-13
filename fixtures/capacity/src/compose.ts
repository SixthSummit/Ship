/**
 * Composes the customized golden consumer's application with the production
 * adapters the capacity baseline measures: PostgreSQL through Drizzle for the
 * unit of work, outboxes, idempotency and webhook events; BullMQ on Redis for
 * jobs; the Redis lock provider; the Redis cache backend; and the Socket.IO
 * Redis publisher for realtime. Every process (API, worker) composes the same
 * application; only the job runtime mode differs.
 */
import { createRedisCacheBackend } from "@sixthsummit/ship-cache-redis";
import { createExecutor, startJobRuntime, webhookSecret } from "@sixthsummit/ship-core";
import { createBullmqJobBackend, createRedisLockProvider } from "@sixthsummit/ship-jobs-bullmq";
import { createRealtimePublisher } from "@sixthsummit/ship-realtime-socketio";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "ioredis";
import pg from "pg";
import { type CustomizedInfrastructure, publishedChannels } from "../consumer/application.js";
import type { PaymentEventSink, ReportNotifier } from "../consumer/effects.js";
import { createCustomizedHttpApplication } from "../consumer/http.js";
import {
  createCacheInvalidationOutbox,
  createIdempotencyStore,
  createPaymentsOutbox,
  createPortfolioUnitOfWork,
  createRealtimePublicationOutbox,
  createReportsOutbox,
  createWebhookEventStore,
} from "../consumer/repository.js";
import { portfolioSchema } from "../consumer/schema.js";
import { capacitySessions } from "./sessions.js";

export const STRIPE_SECRET = "whsec_capacity_baseline";
export const TWILIO_TOKEN = "capacity-twilio-token";
export const PUBLIC_BASE_URL = "https://capacity.example.test";

export interface ComposeOptions {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** Namespace shared by every process of one run; keeps Redis keys disjoint between runs. */
  readonly prefix: string;
  readonly processName: string;
  readonly poolSize: number;
  readonly maxInFlight: number;
  readonly tenants: readonly string[];
  readonly mode: "api" | "worker";
}

export interface EffectCounters {
  notifications: number;
  paymentEvents: number;
  publisherDropped: number;
}

export function realtimeKeyPrefix(prefix: string): string {
  return `${prefix}:realtime`;
}

export function jobsPrefix(prefix: string): string {
  return `${prefix}-jobs`;
}

export async function composeCapacityApplication(options: ComposeOptions) {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: options.poolSize });
  const database = drizzle(pool, { schema: portfolioSchema });
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const counters: EffectCounters = { notifications: 0, paymentEvents: 0, publisherDropped: 0 };
  const notifier: ReportNotifier = {
    adapter: "capacity-noop",
    send: async () => {
      counters.notifications += 1;
    },
  };
  const paymentSink: PaymentEventSink = {
    adapter: "capacity-noop",
    record: async () => {
      counters.paymentEvents += 1;
    },
  };
  const backend = createBullmqJobBackend({
    connection: {
      host: redis.options.host,
      port: redis.options.port,
      maxRetriesPerRequest: null,
    },
    prefix: jobsPrefix(options.prefix),
    maxInFlight: options.maxInFlight,
    onError: (error, context) => {
      process.stderr.write(`[jobs ${context.jobId}] ${String(error)}\n`);
    },
  });
  const publisher = createRealtimePublisher({
    redis: { url: options.redisUrl },
    channels: publishedChannels,
    id: options.processName,
    keyPrefix: realtimeKeyPrefix(options.prefix),
    onDropped: () => {
      counters.publisherDropped += 1;
    },
  });
  const infrastructure: CustomizedInfrastructure = {
    unitOfWork: createPortfolioUnitOfWork(database),
    notifier,
    outbox: createReportsOutbox(database),
    idempotency: createIdempotencyStore(database),
    cache: createRedisCacheBackend({ client: redis, keyPrefix: `${options.prefix}:cache:` }),
    cacheOutbox: createCacheInvalidationOutbox(database),
    realtime: publisher,
    realtimeOutbox: createRealtimePublicationOutbox(database),
    paymentSink,
    paymentsOutbox: createPaymentsOutbox(database),
    webhookEvents: createWebhookEventStore(database),
    webhookSecrets: { stripe: webhookSecret(STRIPE_SECRET), twilio: webhookSecret(TWILIO_TOKEN) },
    jobs: backend,
    locks: createRedisLockProvider({ client: redis, keyPrefix: `${options.prefix}:lock` }),
    scheduledTenants: options.tenants,
  };
  const { application, http } = createCustomizedHttpApplication(
    infrastructure,
    capacitySessions(options.tenants),
    { publicBaseUrl: PUBLIC_BASE_URL },
  );
  const runtime = await startJobRuntime(application, { backend, mode: options.mode });
  const executor = createExecutor(application);
  return {
    application,
    http,
    executor,
    backend,
    publisher,
    runtime,
    pool,
    redis,
    counters,
    close: async () => {
      await runtime.stop().catch(() => undefined);
      await publisher.close().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
  };
}

export type ComposedApplication = Awaited<ReturnType<typeof composeCapacityApplication>>;
