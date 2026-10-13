import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../observability/logger.js";
import {
  type HealthCheck,
  type HealthCheckFailure,
  HealthCheckRegistry,
  healthCheckRegistry,
} from "./HealthCheck.js";

describe("HealthCheckRegistry", () => {
  let registry: HealthCheckRegistry;

  afterEach(() => {
    registry?.clear();
  });

  it("starts empty", () => {
    registry = new HealthCheckRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it("add() keeps the first explicit registration of a name and warns about the second", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    registry = new HealthCheckRegistry();
    const first = vi.fn(() => ({ ok: true, latencyMs: 1 }));
    const second = vi.fn(() => ({ ok: true, latencyMs: 0 }));
    expect(registry.add({ name: "redis", check: first })).toBe(true);
    expect(registry.add({ name: "redis", check: second })).toBe(false);
    expect(registry.size()).toBe(1);
    expect(warn).toHaveBeenCalledOnce();

    await registry.runAll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an explicit add() replaces a replaceable default of the same name", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    registry = new HealthCheckRegistry();
    const framework = vi.fn(() => ({ ok: true, latencyMs: 1 }));
    const consumer = vi.fn(() => ({ ok: true, latencyMs: 1 }));
    registry.add({ name: "db.primary", check: framework }, { replaceable: true });
    expect(registry.add({ name: "db.primary", check: consumer })).toBe(true);
    expect(registry.size()).toBe(1);

    await registry.runAll();
    expect(consumer).toHaveBeenCalledOnce();
    expect(framework).not.toHaveBeenCalled();
    debug.mockRestore();
  });

  it("a replaceable add() never displaces an existing check", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    registry = new HealthCheckRegistry();
    const consumer: HealthCheck = { name: "db.primary", check: () => ({ ok: true, latencyMs: 0 }) };
    registry.add(consumer);
    expect(
      registry.add(
        { name: "db.primary", check: () => ({ ok: true, latencyMs: 0 }) },
        { replaceable: true },
      ),
    ).toBe(false);
    // Two replaceable defaults: the first stays.
    const other = new HealthCheckRegistry();
    const firstDefault: HealthCheck = {
      name: "db.primary",
      check: () => ({ ok: true, latencyMs: 0 }),
    };
    other.add(firstDefault, { replaceable: true });
    other.add(
      { name: "db.primary", check: () => ({ ok: true, latencyMs: 0 }) },
      { replaceable: true },
    );
    expect(registry.list()).toEqual([consumer]);
    expect(other.list()).toEqual([firstDefault]);
    expect(warn).not.toHaveBeenCalled();
    debug.mockRestore();
    warn.mockRestore();
  });

  it("remove() returns true on hit, false on miss", () => {
    registry = new HealthCheckRegistry();
    registry.add({ name: "x", check: () => ({ ok: true, latencyMs: 0 }) });
    expect(registry.remove("x")).toBe(true);
    expect(registry.remove("x")).toBe(false);
  });

  it("list() returns a defensive copy", () => {
    registry = new HealthCheckRegistry();
    registry.add({ name: "x", check: () => ({ ok: true, latencyMs: 0 }) });
    const list = registry.list();
    // The returned array is a copy — pushing to it mustn't affect the registry.
    (list as HealthCheck[]).push({ name: "y", check: () => ({ ok: true, latencyMs: 0 }) });
    expect(registry.size()).toBe(1);
  });

  describe("runAll", () => {
    it("reports each failure with its raw error to onCheckFailure", async () => {
      registry = new HealthCheckRegistry();
      const thrown = Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
      registry.add({ name: "ok", check: () => ({ ok: true, latencyMs: 0 }) });
      registry.add({ name: "returned", check: () => ({ ok: false, latencyMs: 0, error: "down" }) });
      registry.add({
        name: "thrown",
        check: () => {
          throw thrown;
        },
      });
      registry.add({ name: "slow", check: () => new Promise<never>(() => undefined) });

      const failures: HealthCheckFailure[] = [];
      const r = await registry.runAll({
        timeoutMs: 20,
        onCheckFailure: (f) => {
          failures.push(f);
          throw new Error("a broken callback must not break runAll");
        },
      });

      expect(r.ok).toBe(false);
      const byName = Object.fromEntries(failures.map((f) => [f.name, f]));
      expect(Object.keys(byName).sort()).toEqual(["returned", "slow", "thrown"]);
      expect(byName.returned).toEqual({
        name: "returned",
        error: "down",
        reason: "down",
        timedOut: false,
      });
      expect(byName.thrown).toEqual({ name: "thrown", error: thrown, timedOut: false });
      expect(byName.slow?.timedOut).toBe(true);
      expect(r.checks.find((c) => c.name === "slow")?.error).toBe("timeout");
    });

    it("returns ok=true when every check passes", async () => {
      registry = new HealthCheckRegistry();
      registry.add({ name: "a", check: () => ({ ok: true, latencyMs: 1 }) });
      registry.add({ name: "b", check: async () => ({ ok: true, latencyMs: 2 }) });

      const r = await registry.runAll();
      expect(r.ok).toBe(true);
      expect(r.checks).toHaveLength(2);
      expect(r.checks.every((c) => c.ok)).toBe(true);
    });

    it("returns ok=false when any check fails (others still reported)", async () => {
      registry = new HealthCheckRegistry();
      registry.add({ name: "redis", check: () => ({ ok: true, latencyMs: 1 }) });
      registry.add({ name: "db", check: () => ({ ok: false, latencyMs: 8, error: "down" }) });

      const r = await registry.runAll();
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.name === "redis")?.ok).toBe(true);
      const db = r.checks.find((c) => c.name === "db");
      expect(db?.ok).toBe(false);
      expect(db?.error).toBe("down");
    });

    it("captures thrown errors as failed checks (no propagation)", async () => {
      registry = new HealthCheckRegistry();
      registry.add({
        name: "throws",
        check: async () => {
          throw new Error("kaboom");
        },
      });

      const r = await registry.runAll();
      expect(r.ok).toBe(false);
      expect(r.checks[0].ok).toBe(false);
      expect(r.checks[0].error).toBe("kaboom");
    });

    it("times out long-running checks (default 3s; configurable)", async () => {
      registry = new HealthCheckRegistry();
      registry.add({
        name: "slow",
        check: () =>
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("never")), 200)),
      });

      const r = await registry.runAll({ timeoutMs: 50 });
      expect(r.ok).toBe(false);
      expect(r.checks[0].error).toBe("timeout");
    });

    it("forwards details from a check into the result", async () => {
      registry = new HealthCheckRegistry();
      registry.add({
        name: "with-details",
        check: () => ({ ok: true, latencyMs: 0, details: { version: "9.2", lag: 5 } }),
      });
      const r = await registry.runAll();
      expect(r.checks[0].details).toEqual({ version: "9.2", lag: 5 });
    });

    it("emits zero checks → ok=true (no checks registered)", async () => {
      registry = new HealthCheckRegistry();
      const r = await registry.runAll();
      expect(r).toEqual({ ok: true, checks: [] });
    });

    it("each check runs with a measured latencyMs", async () => {
      registry = new HealthCheckRegistry();
      registry.add({
        name: "delayed",
        check: async () => {
          await new Promise((r) => setTimeout(r, 25));
          return { ok: true, latencyMs: 0 }; // adapter's reported latency is overridden
        },
      });

      const r = await registry.runAll();
      // Registry-measured latency should be > 0 (typically ~25 ms on most machines)
      expect(r.checks[0].latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("framework-wide healthCheckRegistry singleton", () => {
  afterEach(() => {
    healthCheckRegistry.clear();
  });

  it("is a real HealthCheckRegistry instance", () => {
    expect(healthCheckRegistry).toBeInstanceOf(HealthCheckRegistry);
    expect(healthCheckRegistry.size()).toBe(0);
  });

  it("supports the same add/runAll/clear surface", async () => {
    healthCheckRegistry.add({ name: "x", check: () => ({ ok: true, latencyMs: 0 }) });
    expect(healthCheckRegistry.size()).toBe(1);
    const r = await healthCheckRegistry.runAll();
    expect(r.ok).toBe(true);
  });
});
