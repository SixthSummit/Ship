/**
 * Real-Postgres proof of the default readiness wiring: `createDb` registers a
 * `db.primary` check that runs `select 1` on its pool, and `createApp` serves
 * it on `/readyz` with no extra wiring. A pool that cannot authenticate turns
 * `/readyz` into a 503 whose body names only the check — never the user,
 * password, host or the Postgres error text — while the server-side log
 * carries the SQLSTATE code.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../app/db/client.js";
import { HealthCheckRegistry } from "../../app/health/HealthCheck.js";
import { RouteRegistry } from "../../app/registry/routes.js";
import { createApp } from "../../http/app/createApp.js";
import { logger } from "../../observability/logger.js";

describe("default /readyz db.primary check (real Postgres)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
  }, 60_000);

  afterAll(async () => {
    await container?.stop().catch(() => undefined);
  });

  it("reports db.primary ok with a measured latency", async () => {
    const health = new HealthCheckRegistry();
    const { pool } = createDb({
      config: { connectionString: container.getConnectionUri() },
      schema: {},
      healthCheck: { registry: health },
    });
    const app = createApp({ registry: new RouteRegistry(), health: { registry: health } });

    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; latencyMs: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0]).toMatchObject({ name: "db.primary", ok: true });
    expect(body.checks[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    await pool.end();
  });

  it("returns 503 without leaking connection details when authentication fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const health = new HealthCheckRegistry();
    const url = new URL(container.getConnectionUri());
    url.username = "leaky_user";
    url.password = "hunter2-secret";
    const { pool } = createDb({
      config: { connectionString: url.toString() },
      schema: {},
      healthCheck: { registry: health },
    });
    const app = createApp({ registry: new RouteRegistry(), health: { registry: health } });

    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      checks: [
        { name: "db.primary", ok: false, latencyMs: expect.any(Number), error: "unavailable" },
      ],
    });
    const leaks = [
      url.hostname,
      url.port,
      "leaky_user",
      "hunter2-secret",
      "password",
      "authentication",
    ];
    for (const leak of leaks) expect(text).not.toContain(leak);

    expect(warn).toHaveBeenCalledWith(
      { checks: [{ name: "db.primary", timedOut: false, errorCode: "28P01", errorName: "error" }] },
      "Readiness check failed",
    );
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of ["leaky_user", "hunter2-secret", "authentication"]) {
      expect(logged).not.toContain(leak);
    }
    await pool.end();
    warn.mockRestore();
  });

  it("logs a returned failure's reason, but never puts it in the /readyz body", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const health = new HealthCheckRegistry();
    const { pool } = createDb({
      config: { connectionString: container.getConnectionUri() },
      schema: {},
      healthCheck: { registry: health },
    });
    // The documented hand-written shape: query, then return ok: false with a reason.
    health.add({
      name: "db.migrations",
      async check() {
        const start = performance.now();
        const { rows } = await pool.query<{ ready: boolean }>("select false as ready");
        return {
          ok: rows[0]?.ready === true,
          latencyMs: Math.round(performance.now() - start),
          error: "schema migrations are behind",
        };
      },
    });
    const app = createApp({ registry: new RouteRegistry(), health: { registry: health } });

    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("migrations are behind");
    expect(JSON.parse(text).checks).toEqual(
      expect.arrayContaining([
        { name: "db.primary", ok: true, latencyMs: expect.any(Number) },
        { name: "db.migrations", ok: false, latencyMs: expect.any(Number), error: "unavailable" },
      ]),
    );
    expect(warn).toHaveBeenCalledWith(
      {
        checks: [
          { name: "db.migrations", timedOut: false, reason: "schema migrations are behind" },
        ],
      },
      "Readiness check failed",
    );
    await pool.end();
    warn.mockRestore();
  });
});
