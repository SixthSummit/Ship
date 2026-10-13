import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { RouteRegistry } from "../../app/registry/routes.js";
import { validate } from "../utils/validate.js";
import { createApp, createModuleApp } from "./createApp.js";

const noopMw: MiddlewareHandler = async (_c, next) => next();

/**
 * `createModuleApp` is the building block of the v4 mount-at-root composition:
 * each module builds its own sub-app, the consumer mounts them onto the root
 * with `root.route("/", subApp)`. These tests pin the two properties that make
 * that safe for the route registry — absolute paths are recorded verbatim, and
 * every entry is tagged with its module — plus the runtime mount behavior.
 */
describe("createModuleApp", () => {
  let registry: RouteRegistry;
  afterEach(() => registry?.clear());

  it("stamps the module tag on every captured route", () => {
    registry = new RouteRegistry();
    const app = createModuleApp("accounts", { registry });

    app.post("/accounts", (c) => c.json({}, 201));
    app.get("/accounts/:id", (c) => c.json({}));

    expect(registry.list().map((e) => `${e.method} ${e.path} [${e.module}]`)).toEqual([
      "POST /accounts [accounts]",
      "GET /accounts/:id [accounts]",
    ]);
  });

  it("records absolute paths verbatim (no prefix math) so execute_route stays accurate", () => {
    registry = new RouteRegistry();
    const app = createModuleApp("oauth", { registry });

    app.get("/oauth/:providerCode/callback", (c) => c.json({}));

    const entry = registry.find("GET", "/oauth/:providerCode/callback");
    expect(entry?.path).toBe("/oauth/:providerCode/callback");
    expect(entry?.module).toBe("oauth");
  });

  it("still captures schema/auth metadata like createApp does", () => {
    registry = new RouteRegistry();
    const app = createModuleApp("widgets", { registry });

    const body = z.object({ name: z.string() });
    app.post("/widgets", validate("json", body), (c) => c.json({}, 201));

    expect(registry.find("POST", "/widgets")?.schemas.json).toBe(body);
  });

  it("wires no CORS (cross-cutting middleware belongs on the root)", async () => {
    registry = new RouteRegistry();
    const mod = createModuleApp("widgets", { registry });
    mod.get("/widgets", (c) => c.json({ ok: true }));

    const res = await mod.request("/widgets", {
      headers: { origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("mounts at root with absolute paths: routes respond and the registry sees them all", async () => {
    registry = new RouteRegistry();

    const accounts = createModuleApp("accounts", { registry });
    accounts.get("/accounts", (c) => c.json({ list: "accounts" }));
    accounts.get("/accounts/:id", (c) => c.json({ id: c.req.param("id") }));

    const outbox = createModuleApp("outbox", { registry });
    outbox.get("/outbox", (c) => c.json({ list: "outbox" }));

    const root = createApp({ registry }).route("/", accounts).route("/", outbox);

    // Runtime: both modules dispatch through the mounted root.
    expect(await (await root.request("/accounts")).json()).toEqual({ list: "accounts" });
    expect(await (await root.request("/accounts/7")).json()).toEqual({ id: "7" });
    expect(await (await root.request("/outbox")).json()).toEqual({ list: "outbox" });

    // Registry: every absolute path present, each tagged with its module.
    expect(
      registry
        .list()
        .map((e) => `${e.path} [${e.module}]`)
        .sort(),
    ).toEqual(["/accounts [accounts]", "/accounts/:id [accounts]", "/outbox [outbox]"]);

    // Cross-module collision detection still works off the shared registry.
    expect(registry.findCollisions("GET", "/accounts")).toHaveLength(1);
  });

  it("shares the default framework registry with createApp", async () => {
    const { routeRegistry } = await import("../../app/registry/routes.js");
    routeRegistry.clear();

    const root = createApp();
    root.get("/", (c) => c.json({}));
    const mod = createModuleApp("billing");
    mod.get("/billing", (c) => c.json({}));
    root.route("/", mod);

    expect(routeRegistry.find("GET", "/")?.module).toBeUndefined();
    expect(routeRegistry.find("GET", "/billing")?.module).toBe("billing");
    routeRegistry.clear();
  });
});

describe("createModuleApp — cross-cutting guard (fail-fast)", () => {
  let registry: RouteRegistry;
  afterEach(() => registry?.clear());

  it("throws if a module sub-app sets its own onError (would shadow registerErrorHandlers)", () => {
    registry = new RouteRegistry();
    const mod = createModuleApp("billing", { registry });
    expect(() => mod.onError(() => new Response("nope"))).toThrow(
      /createModuleApp\("billing"\): app\.onError/,
    );
  });

  it("throws if a module sub-app sets its own notFound", () => {
    registry = new RouteRegistry();
    const mod = createModuleApp("billing", { registry });
    expect(() => mod.notFound(() => new Response("nope"))).toThrow(/app\.notFound/);
  });

  it("throws on global middleware: use('*', mw) and path-less use(mw)", () => {
    registry = new RouteRegistry();
    const mod = createModuleApp("billing", { registry });
    expect(() => mod.use("*", noopMw)).toThrow(/app\.use\("\*", \.\.\.\)/);
    expect(() => mod.use(noopMw)).toThrow(/cross-cutting middleware/);
  });

  it("points the developer at the root app in the error message", () => {
    registry = new RouteRegistry();
    const mod = createModuleApp("billing", { registry });
    expect(() => mod.onError(() => new Response(""))).toThrow(/root app/);
  });

  it("ALLOWS path-scoped middleware (use('/x/*', mw)) and normal route registration", () => {
    registry = new RouteRegistry();
    const mod = createModuleApp("billing", { registry });
    expect(() => mod.use("/billing/*", noopMw)).not.toThrow();
    expect(() => mod.get("/billing", (c) => c.json({}))).not.toThrow();
    expect(registry.find("GET", "/billing")?.module).toBe("billing");
  });

  it("does NOT guard the root createApp — registerErrorHandlers/use stay available there", () => {
    registry = new RouteRegistry();
    const root = createApp({ registry });
    expect(() => root.onError(() => new Response(""))).not.toThrow();
    expect(() => root.use("*", noopMw)).not.toThrow();
  });
});
