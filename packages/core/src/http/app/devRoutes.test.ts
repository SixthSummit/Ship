import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type RouteEntry, RouteRegistry } from "../../app/registry/routes.js";
import { registerDevRoutes } from "./devRoutes.js";

function entry(overrides: Partial<RouteEntry> = {}): RouteEntry {
  return {
    method: "GET",
    path: "/widgets",
    auth: { required: false },
    permissions: [],
    schemas: {},
    ...overrides,
  };
}

describe("registerDevRoutes — gating", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalWorkerMode = process.env.WORKER_MODE;

  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.WORKER_MODE;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalWorkerMode === undefined) delete process.env.WORKER_MODE;
    else process.env.WORKER_MODE = originalWorkerMode;
  });

  it("auto-enabled when WORKER_MODE=local", async () => {
    process.env.WORKER_MODE = "local";
    const registry = new RouteRegistry();
    const app = new Hono();
    registerDevRoutes(app, { registry });
    const res = await app.request("/dev/routes");
    expect(res.status).toBe(200);
  });

  it("auto-enabled when NODE_ENV is local / dev / development", async () => {
    for (const env of ["local", "dev", "development"]) {
      process.env.NODE_ENV = env;
      const registry = new RouteRegistry();
      const app = new Hono();
      registerDevRoutes(app, { registry });
      const res = await app.request("/dev/routes");
      expect(res.status).toBe(200);
    }
  });

  it("auto-disabled in production (no env match)", async () => {
    process.env.NODE_ENV = "production";
    const registry = new RouteRegistry();
    const app = new Hono();
    registerDevRoutes(app, { registry });
    const res = await app.request("/dev/routes");
    expect(res.status).toBe(404); // not registered → Hono's default 404
  });

  it("force-enabled regardless of env when enabled: true", async () => {
    process.env.NODE_ENV = "production";
    const registry = new RouteRegistry();
    const app = new Hono();
    registerDevRoutes(app, { registry, enabled: true });
    const res = await app.request("/dev/routes");
    expect(res.status).toBe(200);
  });

  it("force-disabled when enabled: false (even in dev)", async () => {
    process.env.NODE_ENV = "development";
    const registry = new RouteRegistry();
    const app = new Hono();
    registerDevRoutes(app, { registry, enabled: false });
    const res = await app.request("/dev/routes");
    expect(res.status).toBe(404);
  });
});

describe("registerDevRoutes — HTML output", () => {
  let registry: RouteRegistry;
  let app: Hono;

  beforeEach(() => {
    registry = new RouteRegistry();
    app = new Hono();
    registerDevRoutes(app, { registry, enabled: true });
  });

  it("renders the registered routes in a table", async () => {
    registry.add(entry({ method: "GET", path: "/me", module: "me" }));
    registry.add(
      entry({
        method: "POST",
        path: "/accounts",
        module: "accounts",
        auth: { required: true, provider: "firebase" },
        permissions: ["accounts:create"],
        schemas: { json: z.object({ name: z.string() }) },
        rateLimit: { windowMs: 60_000, max: 5 },
        idempotent: true,
      }),
    );

    const res = await app.request("/dev/routes");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);

    const html = await res.text();
    expect(html).toContain("/me");
    expect(html).toContain("/accounts");
    expect(html).toContain("firebase");
    expect(html).toContain("accounts:create");
    expect(html).toContain("rate-limit 5/60s");
    expect(html).toContain("idempotent");
    expect(html).toContain("2 routes registered");
  });

  it("renders a friendly empty state when no routes are registered", async () => {
    const res = await app.request("/dev/routes");
    const html = await res.text();
    expect(html).toContain("No routes registered yet");
    expect(html).toContain("0 routes registered");
  });

  it("escapes user-controllable fields to prevent XSS in dev tools", async () => {
    registry.add(entry({ path: "/<script>alert(1)</script>", permissions: ["<img onerror=x>"] }));
    const res = await app.request("/dev/routes");
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img onerror=x>");
  });

  it("marks deprecated routes with the deprecated class", async () => {
    registry.add(entry({ path: "/old", deprecated: true }));
    const res = await app.request("/dev/routes");
    const html = await res.text();
    expect(html).toContain('class="deprecated"');
    expect(html).toContain("deprecated");
  });
});

describe("registerDevRoutes — JSON output", () => {
  let registry: RouteRegistry;
  let app: Hono;

  beforeEach(() => {
    registry = new RouteRegistry();
    app = new Hono();
    registerDevRoutes(app, { registry, enabled: true });
  });

  it("returns the registry as JSON with schemas converted to JSON Schema", async () => {
    registry.add(
      entry({
        method: "POST",
        path: "/accounts",
        schemas: { json: z.object({ name: z.string() }), query: z.object({ q: z.string() }) },
      }),
    );

    const res = await app.request("/dev/routes.json");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      count: number;
      routes: Array<{
        method: string;
        path: string;
        schemas: Record<string, { type?: string; properties?: Record<string, unknown> }>;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);
    // Schemas are real JSON Schema objects so MCP / SDK consumers can introspect
    expect(body.routes[0].schemas.json.type).toBe("object");
    expect(body.routes[0].schemas.json.properties).toHaveProperty("name");
    expect(body.routes[0].schemas.query.type).toBe("object");
    expect(body.routes[0].schemas.query.properties).toHaveProperty("q");
  });

  it("returns count: 0 with empty routes when registry is empty", async () => {
    const res = await app.request("/dev/routes.json");
    const body = (await res.json()) as { ok: boolean; count: number; routes: unknown[] };
    expect(body.count).toBe(0);
    expect(body.routes).toEqual([]);
  });
});

describe("registerDevRoutes — prefix", () => {
  it("supports a custom mount-path prefix", async () => {
    const registry = new RouteRegistry();
    const app = new Hono();
    registerDevRoutes(app, { registry, enabled: true, prefix: "/admin" });

    const res = await app.request("/admin/dev/routes");
    expect(res.status).toBe(200);
    const noPrefix = await app.request("/dev/routes");
    expect(noPrefix.status).toBe(404);
  });
});
