import { describe, expect, it } from "vitest";
import { StaticRegistryClient } from "../registryClient.js";
import type { RouteEntry, RoutesDump } from "../types.js";
import { listRoutes } from "./listRoutes.js";

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

function dump(routes: RouteEntry[]): RoutesDump {
  return { ok: true, count: routes.length, routes };
}

describe("listRoutes", () => {
  it("returns every route compactly when no filter is provided", async () => {
    const client = new StaticRegistryClient(
      dump([
        entry({ method: "GET", path: "/me", module: "me" }),
        entry({ method: "POST", path: "/accounts", module: "accounts" }),
      ]),
    );
    const r = await listRoutes(client);
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.routes).toHaveLength(2);
  });

  it("filters by method", async () => {
    const client = new StaticRegistryClient(
      dump([
        entry({ method: "GET", path: "/me" }),
        entry({ method: "POST", path: "/accounts" }),
        entry({ method: "POST", path: "/widgets" }),
      ]),
    );
    const r = await listRoutes(client, { method: "POST" });
    expect(r.count).toBe(2);
    expect(r.routes.every((rt) => rt.method === "POST")).toBe(true);
  });

  it("filters by exact path", async () => {
    const client = new StaticRegistryClient(
      dump([entry({ path: "/a" }), entry({ path: "/b" }), entry({ path: "/a" })]),
    );
    const r = await listRoutes(client, { path: "/a" });
    expect(r.count).toBe(2);
  });

  it("filters by module", async () => {
    const client = new StaticRegistryClient(
      dump([
        entry({ path: "/a", module: "x" }),
        entry({ path: "/b", module: "y" }),
        entry({ path: "/c", module: "x" }),
      ]),
    );
    const r = await listRoutes(client, { module: "x" });
    expect(r.routes.map((rt) => rt.path).sort()).toEqual(["/a", "/c"]);
  });

  it("filters by tag", async () => {
    const client = new StaticRegistryClient(
      dump([
        entry({ path: "/a", tags: ["public"] }),
        entry({ path: "/b", tags: ["admin"] }),
        entry({ path: "/c", tags: ["public", "admin"] }),
      ]),
    );
    const r = await listRoutes(client, { tag: "admin" });
    expect(r.routes.map((rt) => rt.path).sort()).toEqual(["/b", "/c"]);
  });

  it("AND-combines multiple filters", async () => {
    const client = new StaticRegistryClient(
      dump([
        entry({ method: "GET", path: "/me", module: "me" }),
        entry({ method: "POST", path: "/me", module: "me" }),
        entry({ method: "GET", path: "/accounts", module: "accounts" }),
      ]),
    );
    const r = await listRoutes(client, { method: "GET", module: "me" });
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0].path).toBe("/me");
  });

  it("compacts schemas to presence flags so JSON Schema doesn't bloat the listing", async () => {
    const client = new StaticRegistryClient(
      dump([
        entry({
          path: "/a",
          schemas: {
            json: { type: "object" },
            query: { type: "object" },
          },
        }),
      ]),
    );
    const r = await listRoutes(client);
    expect(r.routes[0].schemas).toEqual({
      json: true,
      query: true,
      param: false,
      header: false,
    });
  });

  it("respects the limit and reports truncated: true", async () => {
    const client = new StaticRegistryClient(
      dump(Array.from({ length: 5 }, (_, i) => entry({ path: `/r${i}` }))),
    );
    const r = await listRoutes(client, { limit: 3 });
    expect(r.routes).toHaveLength(3);
    expect(r.count).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it("preserves auth + permissions + rateLimit + idempotent + deprecated flags", async () => {
    const client = new StaticRegistryClient(
      dump([
        entry({
          method: "POST",
          path: "/login",
          auth: { required: true, provider: "firebase" },
          permissions: ["accounts:create"],
          rateLimit: { windowMs: 60000, max: 5, scope: "login" },
          idempotent: true,
          deprecated: false,
        }),
      ]),
    );
    const r = await listRoutes(client);
    expect(r.routes[0]).toMatchObject({
      auth: { required: true, provider: "firebase" },
      permissions: ["accounts:create"],
      rateLimit: { windowMs: 60000, max: 5, scope: "login" },
      idempotent: true,
    });
  });

  it("returns count: 0 with empty routes when registry is empty", async () => {
    const client = new StaticRegistryClient(dump([]));
    const r = await listRoutes(client);
    expect(r).toEqual({ count: 0, truncated: false, routes: [] });
  });
});
