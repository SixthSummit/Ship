import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../observability/logger.js";
import { HealthCheckRegistry, healthCheckRegistry } from "../health/HealthCheck.js";
import { createDb, createPool, handleIdleClientErrors } from "./client.js";

// No connection is opened: pools connect lazily, and these tests only emit the event pg emits
// when an idle client's connection fails.
const config = { connectionString: "postgres://user:secret@db.internal:5432/app" };
const terminated = Object.assign(new Error("terminating connection due to administrator command"), {
  code: "57P01",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("idle client errors", () => {
  it("a bare pg.Pool throws on an idle client error — the crash this guards against", async () => {
    const pool = new pg.Pool(config);
    expect(() => pool.emit("error", terminated)).toThrow("terminating connection");
    await pool.end();
  });

  it("createPool logs the code and keeps the process alive", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const pool = createPool(config);
    expect(() => pool.emit("error", terminated)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      { errorCode: "57P01", errorName: "Error" },
      "Idle Postgres connection failed; the pool discarded it",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|db\.internal|administrator/);
    await pool.end();
  });

  it("createDb guards an injected pool", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { pool } = createDb({ config, schema: {}, pool: new pg.Pool(config) });
    expect(() => pool.emit("error", terminated)).not.toThrow();
    await pool.end();
  });

  it("leaves a caller's own listener in charge", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const own = vi.fn();
    const pool = new pg.Pool(config);
    pool.on("error", own);
    handleIdleClientErrors(pool);
    pool.emit("error", terminated);
    expect(own).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(pool.listenerCount("error")).toBe(1);
    await pool.end();
  });
});

describe("createDb db.primary readiness check", () => {
  function fakePool(query: () => Promise<unknown>): pg.Pool {
    const pool = new pg.Pool(config);
    vi.spyOn(pool, "query").mockImplementation(query as never);
    return pool;
  }

  it("registers exactly one db.primary check on the framework-wide registry by default", async () => {
    healthCheckRegistry.clear();
    const pool = fakePool(async () => ({ rows: [{ "?column?": 1 }] }));
    createDb({ config, schema: {}, pool });

    expect(healthCheckRegistry.list().map((c) => c.name)).toEqual(["db.primary"]);
    const result = await healthCheckRegistry.runAll();
    expect(result.ok).toBe(true);
    expect(pool.query).toHaveBeenCalledWith("select 1");
    healthCheckRegistry.clear();
    await pool.end();
  });

  it("a consumer's own db.primary replaces the default: one check, the consumer's", async () => {
    vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    const pool = fakePool(async () => ({ rows: [] }));
    createDb({ config, schema: {}, pool, healthCheck: { registry } });
    const own = vi.fn(async () => ({ ok: true, latencyMs: 0 }));

    expect(() => registry.add({ name: "db.primary", check: own })).not.toThrow();
    expect(registry.size()).toBe(1);
    await registry.runAll();
    expect(own).toHaveBeenCalledOnce();
    expect(pool.query).not.toHaveBeenCalled();
    await pool.end();
  });

  it("a second createDb does not double the check", async () => {
    vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    const first = fakePool(async () => ({ rows: [] }));
    const second = fakePool(async () => ({ rows: [] }));
    createDb({ config, schema: {}, pool: first, healthCheck: { registry } });
    createDb({ config, schema: {}, pool: second, healthCheck: { registry } });

    expect(registry.size()).toBe(1);
    await registry.runAll();
    expect(first.query).toHaveBeenCalledOnce();
    expect(second.query).not.toHaveBeenCalled();
    await first.end();
    await second.end();
  });

  it("supports a custom name and opting out", async () => {
    const registry = new HealthCheckRegistry();
    const a = fakePool(async () => ({ rows: [] }));
    const b = fakePool(async () => ({ rows: [] }));
    createDb({ config, schema: {}, pool: a, healthCheck: { registry, name: "db.replica" } });
    createDb({ config, schema: {}, pool: b, healthCheck: false });
    expect(registry.list().map((c) => c.name)).toEqual(["db.replica"]);
    await a.end();
    await b.end();
  });

  it("a failing query fails the check with the raw error kept for the failure callback", async () => {
    const registry = new HealthCheckRegistry();
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
      code: "ECONNREFUSED",
    });
    const pool = fakePool(async () => {
      throw refused;
    });
    createDb({ config, schema: {}, pool, healthCheck: { registry } });
    const onCheckFailure = vi.fn();
    const result = await registry.runAll({ onCheckFailure });
    expect(result.ok).toBe(false);
    expect(onCheckFailure).toHaveBeenCalledWith({
      name: "db.primary",
      error: refused,
      timedOut: false,
    });
    await pool.end();
  });
});
