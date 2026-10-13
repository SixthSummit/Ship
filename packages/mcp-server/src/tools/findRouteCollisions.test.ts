import { describe, expect, it } from "vitest";
import { StaticRegistryClient } from "../registryClient.js";
import type { RouteEntry, RoutesDump } from "../types.js";
import { findRouteCollisions } from "./findRouteCollisions.js";

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

describe("findRouteCollisions — exact match", () => {
  it("returns empty when no route exists at (method, path)", async () => {
    const client = new StaticRegistryClient(dump([entry({ method: "GET", path: "/me" })]));
    const r = await findRouteCollisions(client, { method: "POST", path: "/billing" });
    expect(r.collisions).toEqual([]);
    expect(r.overlaps).toEqual([]);
  });

  it("returns the exact match in collisions[]", async () => {
    const target = entry({ method: "POST", path: "/accounts", module: "accounts" });
    const client = new StaticRegistryClient(dump([entry({ method: "GET", path: "/me" }), target]));
    const r = await findRouteCollisions(client, { method: "POST", path: "/accounts" });
    expect(r.collisions).toEqual([target]);
  });

  it("ignores different methods at the same path", async () => {
    const client = new StaticRegistryClient(dump([entry({ method: "GET", path: "/x" })]));
    const r = await findRouteCollisions(client, { method: "POST", path: "/x" });
    expect(r.collisions).toEqual([]);
  });
});

describe("findRouteCollisions — path-pattern overlap", () => {
  it("does NOT report overlaps unless includePathPatternOverlap is true", async () => {
    const client = new StaticRegistryClient(dump([entry({ method: "GET", path: "/users/:id" })]));
    const r = await findRouteCollisions(client, { method: "GET", path: "/users/me" });
    expect(r.collisions).toEqual([]);
    expect(r.overlaps).toEqual([]);
  });

  it("reports `/users/:id` as overlapping `/users/me` when opted in", async () => {
    const overlap = entry({ method: "GET", path: "/users/:id" });
    const client = new StaticRegistryClient(dump([overlap]));
    const r = await findRouteCollisions(client, {
      method: "GET",
      path: "/users/me",
      includePathPatternOverlap: true,
    });
    expect(r.collisions).toEqual([]);
    expect(r.overlaps).toEqual([overlap]);
  });

  it("reports `/users/me` as overlapping a fresh `/users/:id` when opted in", async () => {
    const overlap = entry({ method: "GET", path: "/users/me" });
    const client = new StaticRegistryClient(dump([overlap]));
    const r = await findRouteCollisions(client, {
      method: "GET",
      path: "/users/:id",
      includePathPatternOverlap: true,
    });
    expect(r.overlaps).toEqual([overlap]);
  });

  it("does NOT flag different segment counts as overlapping", async () => {
    const client = new StaticRegistryClient(dump([entry({ method: "GET", path: "/users/:id" })]));
    const r = await findRouteCollisions(client, {
      method: "GET",
      path: "/users",
      includePathPatternOverlap: true,
    });
    expect(r.overlaps).toEqual([]);
  });

  it("excludes the queried path itself from overlaps (it's already in collisions if exact)", async () => {
    const exact = entry({ method: "GET", path: "/users/:id" });
    const client = new StaticRegistryClient(dump([exact]));
    const r = await findRouteCollisions(client, {
      method: "GET",
      path: "/users/:id",
      includePathPatternOverlap: true,
    });
    expect(r.collisions).toEqual([exact]);
    expect(r.overlaps).toEqual([]);
  });

  it("supports `{param}` style alongside `:param` style", async () => {
    const overlap = entry({ method: "GET", path: "/users/{id}" });
    const client = new StaticRegistryClient(dump([overlap]));
    const r = await findRouteCollisions(client, {
      method: "GET",
      path: "/users/me",
      includePathPatternOverlap: true,
    });
    expect(r.overlaps).toEqual([overlap]);
  });
});
