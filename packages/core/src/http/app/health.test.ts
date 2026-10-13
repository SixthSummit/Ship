import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthCheckRegistry } from "../../app/health/HealthCheck.js";
import { logger } from "../../observability/logger.js";
import { hasHealthRoutes, registerHealthRoutes } from "./health.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function buildApp(
  registry: HealthCheckRegistry,
  opts: Parameters<typeof registerHealthRoutes>[1] = {},
): Hono {
  const app = new Hono();
  registerHealthRoutes(app, { registry, ...opts });
  return app;
}

describe("/livez", () => {
  it("always returns 200 with { ok: true }", async () => {
    const app = buildApp(new HealthCheckRegistry());
    const res = await app.request("/livez");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 200 even when registered checks would fail (livez ignores readiness)", async () => {
    const registry = new HealthCheckRegistry();
    registry.add({ name: "broken", check: () => ({ ok: false, latencyMs: 0, error: "down" }) });
    const app = buildApp(registry);
    const res = await app.request("/livez");
    expect(res.status).toBe(200);
  });
});

describe("/readyz", () => {
  it("returns 200 when all checks pass", async () => {
    const registry = new HealthCheckRegistry();
    registry.add({ name: "redis", check: () => ({ ok: true, latencyMs: 1 }) });
    registry.add({ name: "db", check: async () => ({ ok: true, latencyMs: 5 }) });
    const app = buildApp(registry);

    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.checks).toHaveLength(2);
    expect(body.checks.map((c) => c.name).sort()).toEqual(["db", "redis"]);
  });

  it("returns 503 when any check fails, with a generic per-check error", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    registry.add({ name: "redis", check: () => ({ ok: true, latencyMs: 1 }) });
    registry.add({
      name: "db",
      check: () => ({ ok: false, latencyMs: 9, error: "connection refused" }),
    });
    const app = buildApp(registry);

    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; latencyMs: number; error?: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.checks.find((c) => c.name === "db")).toEqual({
      name: "db",
      ok: false,
      latencyMs: expect.any(Number),
      error: "unavailable",
    });
    expect(body.checks.find((c) => c.name === "redis")).toEqual({
      name: "redis",
      ok: true,
      latencyMs: expect.any(Number),
    });
  });

  it("logs a returned error string as the reason, truncated, but keeps it out of the response", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    registry.add({
      name: "storage",
      check: () => ({ ok: false, latencyMs: 4, error: "bucket uploads-prod is not reachable" }),
    });
    registry.add({
      name: "search",
      check: () => ({ ok: false, latencyMs: 2, error: `index stale: ${"x".repeat(500)}` }),
    });
    registry.add({ name: "queue", check: () => ({ ok: false, latencyMs: 1 }) });

    const res = await buildApp(registry).request("/readyz");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toMatch(/bucket|uploads-prod|index stale/);
    for (const check of JSON.parse(text).checks) expect(check.error).toBe("unavailable");

    expect(warn).toHaveBeenCalledOnce();
    const [fields, message] = warn.mock.calls[0] as unknown as [
      { checks: Array<Record<string, unknown>> },
      string,
    ];
    expect(message).toBe("Readiness check failed");
    const byName = Object.fromEntries(fields.checks.map((c) => [c.name, c]));
    expect(byName.storage).toEqual({
      name: "storage",
      timedOut: false,
      reason: "bucket uploads-prod is not reachable",
    });
    expect(byName.search?.reason).toBe(`index stale: ${"x".repeat(187)}…`);
    expect((byName.search?.reason as string).length).toBe(201);
    expect(byName.queue).toEqual({ name: "queue", timedOut: false });
  });

  it("never logs a thrown string, even though a returned one is logged", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    registry.add({
      name: "legacy",
      check: () => {
        throw "postgres://app:hunter2@db.internal:5432/app refused";
      },
    });

    const res = await buildApp(registry).request("/readyz");
    expect(res.status).toBe(503);
    expect(warn).toHaveBeenCalledWith(
      { checks: [{ name: "legacy", timedOut: false }] },
      "Readiness check failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/hunter2|db\.internal|refused/);
  });

  it("never exposes a thrown error's message, and logs only its code, name and syscall", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    registry.add({
      name: "db.primary",
      check: () => {
        throw Object.assign(
          new Error('password authentication failed for user "app" at db.internal:5432 (hunter2)'),
          { code: "28P01" },
        );
      },
    });
    const app = buildApp(registry);

    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toMatch(/password|authentication|db\.internal|5432|hunter2|"app"/);
    expect(JSON.parse(text)).toEqual({
      ok: false,
      checks: [
        { name: "db.primary", ok: false, latencyMs: expect.any(Number), error: "unavailable" },
      ],
    });

    expect(warn).toHaveBeenCalledWith(
      { checks: [{ name: "db.primary", timedOut: false, errorCode: "28P01", errorName: "Error" }] },
      "Readiness check failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/password|db\.internal|hunter2/);
  });

  it("logs a thrown network error's syscall alongside its code and name, never its message", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    registry.add({
      name: "db.primary",
      check: () => {
        throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.12:5432"), {
          code: "ECONNREFUSED",
          syscall: "connect",
          address: "10.0.0.12",
          port: 5432,
        });
      },
    });

    const res = await buildApp(registry).request("/readyz");
    expect(await res.json()).toMatchObject({ checks: [{ error: "unavailable" }] });
    expect(warn).toHaveBeenCalledWith(
      {
        checks: [
          {
            name: "db.primary",
            timedOut: false,
            errorCode: "ECONNREFUSED",
            errorName: "Error",
            syscall: "connect",
          },
        ],
      },
      "Readiness check failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/10\.0\.0\.12|5432/);
  });

  it("drops check details from the public body", async () => {
    const registry = new HealthCheckRegistry();
    registry.add({
      name: "db",
      check: () => ({ ok: true, latencyMs: 1, details: { host: "db.internal", version: "16.4" } }),
    });
    const res = await buildApp(registry).request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(/db\.internal|16\.4/);
  });

  it("returns 200 with empty checks when no checks are registered", async () => {
    const app = buildApp(new HealthCheckRegistry());
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual([]);
  });

  it("supports a mount-path prefix", async () => {
    const registry = new HealthCheckRegistry();
    const app = buildApp(registry, { prefix: "/admin" });
    const live = await app.request("/admin/livez");
    expect(live.status).toBe(200);
    const ready = await app.request("/admin/readyz");
    expect(ready.status).toBe(200);
    // Without the prefix the routes are not present
    const noPrefix = await app.request("/livez");
    expect(noPrefix.status).toBe(404);
  });

  it("forwards readyzTimeoutMs to the registry's runAll (reported as timeout)", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    registry.add({
      name: "slow",
      check: () =>
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("never")), 200)),
    });
    const app = buildApp(registry, { readyzTimeoutMs: 30 });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: Array<{ name: string; error?: string }> };
    expect(body.checks[0].error).toBe("timeout");
  });
});

describe("registerHealthRoutes on an app that already has the routes", () => {
  it("mounts nothing a second time and does not throw", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const registry = new HealthCheckRegistry();
    const app = new Hono();
    registerHealthRoutes(app, { registry });
    expect(hasHealthRoutes(app)).toBe(true);
    const routesBefore = app.routes.length;

    expect(() => registerHealthRoutes(app)).not.toThrow();
    expect(() => registerHealthRoutes(app, { registry })).not.toThrow();
    expect(app.routes.length).toBe(routesBefore);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug.mock.calls[1]?.[0]).toEqual({ updated: [] });
    expect((await app.request("/livez")).status).toBe(200);
  });

  it("applies a later registry and timeout to the mounted routes", async () => {
    vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const app = new Hono();
    registerHealthRoutes(app, { registry: new HealthCheckRegistry() });
    const own = new HealthCheckRegistry();
    own.add({ name: "slow", check: () => new Promise<never>(() => undefined) });

    registerHealthRoutes(app, { registry: own, readyzTimeoutMs: 20 });

    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      checks: [{ name: "slow", ok: false, latencyMs: expect.any(Number), error: "timeout" }],
    });
  });

  it("warns that a different prefix is ignored", async () => {
    vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const app = new Hono();
    registerHealthRoutes(app, { registry: new HealthCheckRegistry() });
    registerHealthRoutes(app, { prefix: "/admin" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toEqual({ mountedPrefix: "", ignoredPrefix: "/admin" });
    expect((await app.request("/admin/livez")).status).toBe(404);
  });

  it("tracks apps individually", () => {
    const a = new Hono();
    const b = new Hono();
    registerHealthRoutes(a, { registry: new HealthCheckRegistry() });
    expect(hasHealthRoutes(a)).toBe(true);
    expect(hasHealthRoutes(b)).toBe(false);
  });
});
