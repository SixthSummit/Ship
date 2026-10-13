import { Redis, type RedisOptions } from "ioredis";
import { logger as defaultLogger } from "../../observability/logger.js";

/**
 * Connection-lifecycle wrapper around an ioredis client.
 *
 * One instance per service process; passed into `RedisCache`, `rateLimit`,
 * `idempotency`, and BullMQ producers/workers. The connection is **lazy** —
 * nothing happens until the first command, so unit tests that import code
 * referencing the provider don't accidentally try to dial Redis.
 *
 * Configured per BullMQ's hard requirement (`maxRetriesPerRequest: null`)
 * so the same client can drive both Cache and BullMQ. `enableReadyCheck`
 * kept on so failures surface promptly via `/readyz` rather than as
 * mysterious slow timeouts.
 *
 * Errors are logged via the framework pino logger but never crash the
 * process — degraded operation is the framework default. `/readyz` (in
 * a later batch) reports the unhealthy state so the load balancer pulls
 * the pod out of rotation.
 */

export interface RedisProviderOptions {
  /** Full URL form, e.g. `redis://default:secret@host:6379/0`. */
  url?: string;
  /** Or piecewise. Used when `url` is not provided. */
  host?: string;
  port?: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: boolean;
  /** Override the framework default pino logger. */
  logger?: typeof defaultLogger;
  /**
   * Override any underlying ioredis option. Use sparingly — the framework
   * already sets the BullMQ-required values; overriding them risks subtle
   * breakage.
   */
  ioredis?: Partial<RedisOptions>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6379;

export class RedisProvider {
  readonly client: Redis;
  private readonly logger: typeof defaultLogger;
  private quitting = false;

  constructor(opts: RedisProviderOptions = {}) {
    this.logger = opts.logger ?? defaultLogger;

    const baseOptions: RedisOptions = {
      lazyConnect: true,
      enableReadyCheck: true,
      // BullMQ hard requirement: workers use blocking commands, so a
      // bounded retry count would orphan jobs. Keep null. (BullMQ v5
      // throws a clear error if this is anything else.)
      maxRetriesPerRequest: null,
      ...opts.ioredis,
    };

    if (opts.url) {
      this.client = new Redis(opts.url, baseOptions);
    } else {
      this.client = new Redis({
        host: opts.host ?? DEFAULT_HOST,
        port: opts.port ?? DEFAULT_PORT,
        password: opts.password,
        username: opts.username,
        db: opts.db,
        tls: opts.tls ? {} : undefined,
        ...baseOptions,
      });
    }

    this.client.on("error", (err: Error) => {
      // Silence the noisy "client lost connection during shutdown" path;
      // log everything else.
      if (this.quitting) return;
      this.logger.warn({ err }, "redis.error");
    });

    this.client.on("ready", () => {
      this.logger.info("redis.ready");
    });
  }

  /** Connect (no-op if already connected). Surfaced for `/readyz` use. */
  async connect(): Promise<void> {
    if (this.client.status === "ready" || this.client.status === "connecting") return;
    await this.client.connect();
  }

  /** Graceful shutdown. Idempotent. */
  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    try {
      await this.client.quit();
    } catch (err) {
      // ioredis throws if the client is already disconnected; swallow.
      this.logger.debug({ err }, "redis.quit.swallowed");
    }
  }

  /** Health-check probe — used by `/readyz` (next batch). */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === "PONG";
    } catch {
      return false;
    }
  }
}
