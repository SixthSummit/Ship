/**
 * Real-Postgres proof that a server-side disconnect of an idle pooled
 * connection no longer crashes the process. Postgres ends the backend with
 * `57P01 terminating connection due to administrator command` — the same
 * thing a Cloud SQL restart or failover does to every open connection.
 * Without the pool's `error` listener that arrives as an uncaught exception
 * and Vitest fails the run.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "../../app/db/client.js";
import { logger } from "../../observability/logger.js";

describe("pool survives a terminated idle connection (real Postgres)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
  }, 60_000);

  afterAll(async () => {
    await container?.stop().catch(() => undefined);
  });

  it("logs, discards the broken client and serves the next query", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const pool = createPool({ connectionString: container.getConnectionUri(), max: 2 });
    const idle = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    const pid = idle.rows[0]?.pid;

    const admin = new pg.Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await admin.query("select pg_terminate_backend($1)", [pid]);
    await admin.end();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5_000 });
    expect(warn.mock.calls[0]?.[0]).toEqual({ errorCode: "57P01", errorName: "error" });

    const next = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    expect(next.rows[0]?.pid).not.toBe(pid);
    await pool.end();
    warn.mockRestore();
  });
});
