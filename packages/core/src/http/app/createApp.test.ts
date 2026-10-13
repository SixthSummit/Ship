import type { Hono, MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HealthCheckRegistry, healthCheckRegistry } from "../../app/health/HealthCheck.js";
import { RouteRegistry } from "../../app/registry/routes.js";
import { logger } from "../../observability/logger.js";
import {
  AUTH_META,
  type AuthMeta,
  IDEMPOTENCY_META,
  type IdempotencyMeta,
  PERMISSION_META,
  type PermissionMeta,
  RATE_LIMIT_META,
  type RateLimitMeta,
  setMetaTag,
} from "../utils/metaTags.js";
import { validate } from "../utils/validate.js";
import { createApp } from "./createApp.js";
import { hasHealthRoutes, registerHealthRoutes } from "./health.js";

/**
 * The auth/permission/rate-limit middleware factories haven't landed in this
 * sub-batch — they come in 4b/4c. To exercise the full tag-extraction path
 * now, hand-roll a tagged middleware via the framework's metaTag helpers.
 * Once the real factories ship, these synthetic stubs go away.
 */
function fakeRequireAuth(opts: { optional?: boolean; provider?: string } = {}): MiddlewareHandler {
  const mw: MiddlewareHandler = async (_c, next) => next();
  const tag: AuthMeta = {
    required: !opts.optional,
    providerName: opts.provider,
  };
  setMetaTag(mw, AUTH_META, tag);
  return mw;
}

function fakeRequirePermission(...permissions: string[]): MiddlewareHandler {
  const mw: MiddlewareHandler = async (_c, next) => next();
  const tag: PermissionMeta = { permissions };
  setMetaTag(mw, PERMISSION_META, tag);
  return mw;
}

function fakeRateLimit(opts: RateLimitMeta): MiddlewareHandler {
  const mw: MiddlewareHandler = async (_c, next) => next();
  setMetaTag(mw, RATE_LIMIT_META, opts);
  return mw;
}

function fakeIdempotency(opts: IdempotencyMeta): MiddlewareHandler {
  const mw: MiddlewareHandler = async (_c, next) => next();
  setMetaTag(mw, IDEMPOTENCY_META, opts);
  return mw;
}

describe("createApp", () => {
  let registry: RouteRegistry;

  afterEach(() => {
    registry?.clear();
  });

  it("intercepts app.get/post/put/patch/delete and registers routes", () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });

    app.get("/me", (c) => c.json({}));
    app.post("/widgets", (c) => c.json({}));
    app.put("/widgets/:id", (c) => c.json({}));
    app.patch("/widgets/:id", (c) => c.json({}));
    app.delete("/widgets/:id", (c) => c.json({}));

    expect(registry.size()).toBe(5);
    expect(registry.list().map((e) => `${e.method} ${e.path}`)).toEqual([
      "GET /me",
      "POST /widgets",
      "PUT /widgets/:id",
      "PATCH /widgets/:id",
      "DELETE /widgets/:id",
    ]);
  });

  it("captures schema from validate() in the registry entry", () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });

    const bodySchema = z.object({ name: z.string() });
    const querySchema = z.object({ q: z.string() });

    app.post("/widgets", validate("json", bodySchema), validate("query", querySchema), (c) =>
      c.json({}),
    );

    const entry = registry.find("POST", "/widgets")!;
    expect(entry.schemas.json).toBe(bodySchema);
    expect(entry.schemas.query).toBe(querySchema);
  });

  it("captures auth metadata from a tagged middleware", () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });

    app.get("/me", fakeRequireAuth({ provider: "firebase" }), (c) => c.json({}));
    app.get("/public", fakeRequireAuth({ optional: true, provider: "firebase" }), (c) =>
      c.json({}),
    );

    expect(registry.find("GET", "/me")?.auth).toEqual({ required: true, provider: "firebase" });
    expect(registry.find("GET", "/public")?.auth).toEqual({
      required: false,
      provider: "firebase",
    });
  });

  it("captures permissions and unions across multiple requirePermission middlewares", () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });

    app.post(
      "/admin/widgets",
      fakeRequirePermission("admin:write"),
      fakeRequirePermission("widgets:create"),
      (c) => c.json({}),
    );

    const entry = registry.find("POST", "/admin/widgets")!;
    expect(entry.permissions.sort()).toEqual(["admin:write", "widgets:create"]);
  });

  it("dedupes permissions if the same slug appears twice", () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });
    app.post("/x", fakeRequirePermission("a", "b"), fakeRequirePermission("b", "c"), (c) =>
      c.json({}),
    );
    expect(registry.find("POST", "/x")!.permissions).toEqual(["a", "b", "c"]);
  });

  it("captures rate-limit and idempotency metadata", () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });

    app.post(
      "/widgets",
      fakeRateLimit({ windowMs: 60_000, max: 5, scope: "user" }),
      fakeIdempotency({ ttlSec: 86_400 }),
      (c) => c.json({}),
    );

    const entry = registry.find("POST", "/widgets")!;
    expect(entry.rateLimit).toEqual({ windowMs: 60_000, max: 5, scope: "user" });
    expect(entry.idempotent).toBe(true);
  });

  it("forwards through to Hono's actual routing — handler still runs", async () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });

    app.get("/me", (c) => c.json({ ok: true }));
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("end-to-end: validate runs at request time, registry captures schema", async () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });

    const schema = z.object({ name: z.string() });
    app.post("/widgets", validate("json", schema), (c) => {
      const body = c.req.valid("json" as never) as { name: string };
      return c.json({ name: body.name });
    });

    // Registry got the schema
    expect(registry.find("POST", "/widgets")?.schemas.json).toBe(schema);

    // Request still works
    const res = await app.request("/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "alpha" });
  });

  it("entries default to no-auth, no-permissions, empty schemas", () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });
    app.get("/anon", (c) => c.json({}));

    const entry = registry.find("GET", "/anon")!;
    expect(entry.auth).toEqual({ required: false });
    expect(entry.permissions).toEqual([]);
    expect(entry.schemas).toEqual({});
    expect(entry.rateLimit).toBeUndefined();
    expect(entry.idempotent).toBeUndefined();
  });

  it("uses the framework default registry when none is injected", async () => {
    // Import the default singleton lazily and verify add() lands there.
    const { routeRegistry } = await import("../../app/registry/routes.js");
    routeRegistry.clear();
    const app = createApp();
    app.get("/xyz", (c) => c.json({}));
    expect(routeRegistry.find("GET", "/xyz")).toBeDefined();
    routeRegistry.clear();
  });
});

describe("createApp — CORS wiring (F4)", () => {
  let registry: RouteRegistry;
  afterEach(() => registry?.clear());

  it("throws at construction when origin: '*' is combined with credentials: true", () => {
    registry = new RouteRegistry();
    expect(() =>
      createApp({
        registry,
        cors: { origin: "*", credentials: true },
      }),
    ).toThrow(/incompatible with credentials/);
  });

  it("throws when origin: ['*'] is combined with credentials: true", () => {
    registry = new RouteRegistry();
    expect(() =>
      createApp({
        registry,
        cors: { origin: ["*"], credentials: true },
      }),
    ).toThrow(/incompatible with credentials/);
  });

  it("throws when origin array contains '*' alongside other entries with credentials: true", () => {
    registry = new RouteRegistry();
    expect(() =>
      createApp({
        registry,
        cors: { origin: ["*", "https://app.example.com"], credentials: true },
      }),
    ).toThrow(/ambiguous under credentials/);
  });

  it("permits origin: '*' without credentials (public-read APIs)", () => {
    registry = new RouteRegistry();
    expect(() =>
      createApp({
        registry,
        cors: { origin: "*" },
      }),
    ).not.toThrow();
  });

  it("emits CORS allow-origin headers for an allowlisted origin", async () => {
    registry = new RouteRegistry();
    const app = createApp({
      registry,
      cors: {
        origin: ["https://app.example.com"],
        credentials: true,
      },
    });
    app.get("/me", (c) => c.json({ ok: true }));
    const res = await app.request("/me", {
      headers: { origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does NOT emit allow-origin for a non-allowlisted origin", async () => {
    registry = new RouteRegistry();
    const app = createApp({
      registry,
      cors: {
        origin: ["https://app.example.com"],
        credentials: true,
      },
    });
    app.get("/me", (c) => c.json({ ok: true }));
    const res = await app.request("/me", {
      headers: { origin: "https://attacker.example.com" },
    });
    // Hono's cors() omits the allow-origin header for unmatched origins;
    // browsers then refuse to expose the response to the page JS.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("responds to OPTIONS preflight with the configured allow-methods + allow-headers", async () => {
    registry = new RouteRegistry();
    const app = createApp({
      registry,
      cors: {
        origin: ["https://app.example.com"],
        allowMethods: ["GET", "POST"],
        allowHeaders: ["content-type", "x-csrf-token"],
        credentials: true,
        maxAge: 600,
      },
    });
    app.post("/widgets", (c) => c.json({}));
    const res = await app.request("/widgets", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("preflight carries hono's default allow-methods when allowMethods is not configured", async () => {
    // Regression: forwarding `allowMethods: undefined` into hono's cors()
    // OVERRIDES its spread-in default — the preflight then has NO
    // Access-Control-Allow-Methods header, and browsers reject every
    // non-simple method (DELETE/PUT/PATCH) while GET/POST keep working.
    // Found live: an app's first browser-issued DELETE failed cross-origin.
    registry = new RouteRegistry();
    const app = createApp({
      registry,
      cors: {
        origin: ["https://app.example.com"],
        credentials: true,
      },
    });
    app.delete("/widgets/1", (c) => c.json({}));
    const res = await app.request("/widgets/1", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "DELETE",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("supports a function origin resolver", async () => {
    registry = new RouteRegistry();
    const app = createApp({
      registry,
      cors: {
        origin: (origin) => (origin.endsWith(".example.com") ? origin : null),
        credentials: true,
      },
    });
    app.get("/me", (c) => c.json({ ok: true }));

    const allow = await app.request("/me", {
      headers: { origin: "https://app.example.com" },
    });
    expect(allow.headers.get("access-control-allow-origin")).toBe("https://app.example.com");

    const deny = await app.request("/me", {
      headers: { origin: "https://attacker.com" },
    });
    expect(deny.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("omitting cors leaves no CORS headers on responses (legacy behavior)", async () => {
    registry = new RouteRegistry();
    const app = createApp({ registry });
    app.get("/me", (c) => c.json({ ok: true }));
    const res = await app.request("/me", {
      headers: { origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("createApp — default health routes", () => {
  let registry: RouteRegistry;
  afterEach(() => {
    registry?.clear();
    vi.restoreAllMocks();
  });

  it("serves /livez and /readyz with no extra wiring", async () => {
    registry = new RouteRegistry();
    const health = new HealthCheckRegistry();
    health.add({ name: "db.primary", check: () => ({ ok: true, latencyMs: 1 }) });
    const app = createApp({ registry, health: { registry: health } });

    const live = await app.request("/livez");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true });

    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      ok: true,
      checks: [{ name: "db.primary", ok: true, latencyMs: expect.any(Number) }],
    });
  });

  it("mounts them against the framework-wide registry by default", async () => {
    registry = new RouteRegistry();
    healthCheckRegistry.clear();
    const app = createApp({ registry });
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checks: [] });
  });

  it("keeps them out of the route registry", () => {
    registry = new RouteRegistry();
    createApp({ registry, health: { registry: new HealthCheckRegistry() } });
    expect(registry.size()).toBe(0);
  });

  it("runs them ahead of consumer middleware added afterwards", async () => {
    registry = new RouteRegistry();
    const app = createApp({ registry, health: { registry: new HealthCheckRegistry() } });
    app.use("*", async (c) => c.json({ error: "unauthorized" }, 401));
    app.get("/private", (c) => c.json({ ok: true }));

    expect((await app.request("/livez")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/private")).status).toBe(401);
  });

  it("honours prefix and readyzTimeoutMs", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    registry = new RouteRegistry();
    const health = new HealthCheckRegistry();
    health.add({ name: "slow", check: () => new Promise<never>(() => undefined) });
    const app = createApp({
      registry,
      health: { registry: health, prefix: "/_internal", readyzTimeoutMs: 20 },
    });

    expect((await app.request("/livez")).status).toBe(404);
    expect((await app.request("/_internal/livez")).status).toBe(200);
    const ready = await app.request("/_internal/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      ok: false,
      checks: [{ name: "slow", ok: false, latencyMs: expect.any(Number), error: "timeout" }],
    });
  });

  it("health: false mounts nothing", async () => {
    registry = new RouteRegistry();
    const app = createApp({ registry, health: false });
    expect(hasHealthRoutes(app)).toBe(false);
    expect((await app.request("/livez")).status).toBe(404);
    expect((await app.request("/readyz")).status).toBe(404);

    // ...and an opted-out app can still wire them by hand.
    const manual = createApp({ registry, health: false });
    registerHealthRoutes(manual as unknown as Hono, { registry: new HealthCheckRegistry() });
    expect(hasHealthRoutes(manual)).toBe(true);
    expect((await manual.request("/livez")).status).toBe(200);
  });

  it("a later registerHealthRoutes(app) mounts nothing again", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    registry = new RouteRegistry();
    const app = createApp({ registry, health: { registry: new HealthCheckRegistry() } });
    const routesBefore = app.routes.length;

    expect(() => registerHealthRoutes(app as unknown as Hono)).not.toThrow();
    expect(app.routes.length).toBe(routesBefore);
    expect(debug).toHaveBeenCalledOnce();
    // Still exactly one registration and nothing leaked into the route registry.
    expect(app.routes.filter((r) => r.path === "/readyz")).toHaveLength(1);
    expect(registry.size()).toBe(0);
    expect((await app.request("/readyz")).status).toBe(200);
    // A bare call configures nothing, so it is not deprecated and stays quiet.
    expect(warn).not.toHaveBeenCalled();
  });

  it("a later registerHealthRoutes(app, { registry }) keeps that app's own checks", async () => {
    vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    registry = new RouteRegistry();
    healthCheckRegistry.clear();
    const app = createApp({ registry });
    const own = new HealthCheckRegistry();
    own.add({ name: "db.primary", check: () => ({ ok: true, latencyMs: 1 }) });

    registerHealthRoutes(app as unknown as Hono, { registry: own });

    expect(await (await app.request("/readyz")).json()).toEqual({
      ok: true,
      checks: [{ name: "db.primary", ok: true, latencyMs: expect.any(Number) }],
    });
  });

  it("warns once per app that late configuration is deprecated", () => {
    vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    registry = new RouteRegistry();
    const app = createApp({ registry, health: { registry: new HealthCheckRegistry() } });

    registerHealthRoutes(app as unknown as Hono, { registry: new HealthCheckRegistry() });
    registerHealthRoutes(app as unknown as Hono, { readyzTimeoutMs: 1_000 });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toMatch(/deprecated.*createApp\(\{ health/);

    // Passing the values already in effect changes nothing and is not warned about.
    const other = createApp({ registry: new RouteRegistry(), health: { readyzTimeoutMs: 500 } });
    registerHealthRoutes(other as unknown as Hono, { readyzTimeoutMs: 500 });
    expect(warn).toHaveBeenCalledOnce();
  });
});
