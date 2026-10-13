import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { logger } from "../../observability/logger.js";
import { safeErrorFields } from "../../observability/safeErrorFields.js";
import {
  type HealthCheck,
  type HealthCheckRegistry,
  healthCheckRegistry,
} from "../health/HealthCheck.js";

/**
 * Drizzle client + `pg.Pool` factory for ShipAPI v4.
 *
 * Replaces the v3 TypeORM `DataSource` initialization. One shared `pg.Pool`
 * underlies the Drizzle client; the `pool` is exposed for callers that need
 * raw access (e.g., `LISTEN/NOTIFY`, `pg-boss`-compatible workers, the
 * graceful-shutdown manager which calls `pool.end()`).
 *
 * Connection-pool defaults are deliberately conservative for production
 * Postgres: `max: 20` connections, 30s idle timeout, 5s acquire timeout, and
 * a per-statement timeout to bound runaway queries. All overridable via
 * `DbConfig` at construction time.
 *
 * The factory is **schema-agnostic** — pass your composed schema as the
 * `TSchema` generic so `db.query.<table>` is fully typed against the consumer's
 * tables. The framework ships no default tables; compose each module's schema
 * fragment (e.g. `accountsSchema` from the accounts module) into your schema.
 */

export interface DbConfig {
  /** Full Postgres connection URL (`postgres://...`). Preferred. */
  connectionString?: string;
  /** Or piecewise. Used when `connectionString` is not provided. */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | pg.ConnectionConfig["ssl"];
  /** Max connections in pool. Default 20. */
  max?: number;
  /** Idle timeout (ms) before a pooled connection is released. Default 30_000. */
  idleTimeoutMillis?: number;
  /** Max time (ms) to wait for an available connection. Default 5_000. */
  connectionTimeoutMillis?: number;
  /**
   * Per-statement timeout in ms. Set as a session-level Postgres parameter
   * via the pg `application_name` + `statement_timeout` mechanism. Default
   * 30_000 (30 seconds). Set to `0` to disable.
   */
  statementTimeoutMillis?: number;
  /** Optional `application_name` reported to Postgres. */
  applicationName?: string;
}

const DEFAULT_DB_CONFIG: Required<
  Pick<DbConfig, "max" | "idleTimeoutMillis" | "connectionTimeoutMillis" | "statementTimeoutMillis">
> = {
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMillis: 30_000,
};

export function createPool(config: DbConfig): pg.Pool {
  const merged = { ...DEFAULT_DB_CONFIG, ...config };

  const poolConfig: pg.PoolConfig = {
    max: merged.max,
    idleTimeoutMillis: merged.idleTimeoutMillis,
    connectionTimeoutMillis: merged.connectionTimeoutMillis,
    application_name: merged.applicationName,
    ssl: merged.ssl,
  };

  if (merged.connectionString) {
    poolConfig.connectionString = merged.connectionString;
  } else {
    poolConfig.host = merged.host;
    poolConfig.port = merged.port;
    poolConfig.database = merged.database;
    poolConfig.user = merged.user;
    poolConfig.password = merged.password;
  }

  // Apply statement_timeout as a libpq startup option (`-c statement_timeout=…`)
  // so Postgres sets it when each connection opens — no extra query. Doing this
  // via a `pool.on('connect')` query instead trips pg's "client.query() called
  // while the client is already executing a query" deprecation, because the pool
  // hands the freshly-connected client to its first caller concurrently with the
  // setter query. (A bare number is interpreted as milliseconds.)
  if (merged.statementTimeoutMillis > 0) {
    poolConfig.options = `-c statement_timeout=${merged.statementTimeoutMillis}`;
  }
  return handleIdleClientErrors(new pg.Pool(poolConfig));
}

/**
 * Keep a broken idle connection from killing the process.
 *
 * `pg` emits `error` on the pool when an idle pooled client's connection fails. A Cloud SQL
 * restart, failover or maintenance window ends every connection with `57P01 terminating
 * connection due to administrator command`, and with no listener Node treats that event as an
 * uncaught exception and exits. The pool has already discarded the broken client and the next
 * checkout opens a fresh connection, so logging is all that is needed. Only the error's code,
 * name and syscall are logged (the same fields `/readyz` logs for a thrown check error), because
 * connection error messages can name the database host or user.
 *
 * `createPool` and `createDb` call this; call it yourself on any pool you build with
 * `new pg.Pool()` (migration scripts, workers). A pool that already has an `error` listener is
 * left alone, so a caller's own handling wins.
 */
export function handleIdleClientErrors(pool: pg.Pool): pg.Pool {
  if (pool.listenerCount("error") > 0) return pool;
  pool.on("error", (error: Error) => {
    logger.warn(safeErrorFields(error), "Idle Postgres connection failed; the pool discarded it");
  });
  return pool;
}

export interface DbHealthCheckOptions {
  /** Check name reported by `/readyz`. Default `"db.primary"`. */
  name?: string;
  /** Registry to add the check to. Default: the framework-wide `healthCheckRegistry`. */
  registry?: HealthCheckRegistry;
}

/**
 * Readiness check that runs `select 1` on `pool`. The registry measures the
 * latency and enforces the per-check timeout; a failure throws, so the raw
 * error reaches the registry's failure callback (which `/readyz` logs as
 * code/name/syscall only) rather than the response body. This is the
 * recommended database check: a thrown driver error never puts its message in
 * the log, where a hand-written check returning `error: err.message` would.
 */
export function dbHealthCheck(pool: pg.Pool, opts: { name?: string } = {}): HealthCheck {
  return {
    name: opts.name ?? "db.primary",
    async check() {
      const start = performance.now();
      await pool.query("select 1");
      return { ok: true, latencyMs: Math.round(performance.now() - start) };
    },
  };
}

export interface CreateDbResult<TSchema extends Record<string, unknown>> {
  pool: pg.Pool;
  db: NodePgDatabase<TSchema>;
}

/**
 * Build a Drizzle client + pool. The `schema` is the composed schema record
 * (`{ accounts, roles, permissions, ...customTables }`); `db.query.<key>` is
 * typed against it.
 */
export function createDb<TSchema extends Record<string, unknown>>(args: {
  config: DbConfig;
  schema: TSchema;
  /** Inject an existing pool (e.g., shared with another worker). */
  pool?: pg.Pool;
  /**
   * Readiness check. By default `createDb` adds a `db.primary` check (runs
   * `select 1` on this pool) to the framework-wide `healthCheckRegistry`, so
   * `/readyz` reflects database reachability with no extra wiring.
   *
   * The check is registered as replaceable: if the app later adds its own
   * check with the same name, that check replaces this one. If a check with
   * the name already exists (say, a second `createDb` call), this one is
   * skipped — the first pool's check stays. Either way exactly one runs.
   *
   * Pass `false` to register nothing (e.g. a secondary pool for a worker or
   * migration script), or an object to change the name or registry.
   */
  healthCheck?: false | DbHealthCheckOptions;
}): CreateDbResult<TSchema> {
  const pool = args.pool ? handleIdleClientErrors(args.pool) : createPool(args.config);
  const db = drizzle(pool, { schema: args.schema, casing: "snake_case" });
  if (args.healthCheck !== false) {
    const opts = args.healthCheck ?? {};
    (opts.registry ?? healthCheckRegistry).add(dbHealthCheck(pool, { name: opts.name }), {
      replaceable: true,
    });
  }
  return { pool, db };
}

export type ShipDb<TSchema extends Record<string, unknown>> = NodePgDatabase<TSchema>;
