import { describe, expect, it } from "vitest";
import { StaticRegistryClient } from "../registryClient.js";
import type { RouteEntry, RoutesDump } from "../types.js";
import { describeRoute } from "./describeRoute.js";

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

describe("describeRoute", () => {
  it("returns the matching RouteEntry verbatim (incl. JSON Schemas)", async () => {
    const target: RouteEntry = entry({
      method: "POST",
      path: "/accounts",
      module: "accounts",
      auth: { required: true, provider: "firebase" },
      permissions: ["accounts:create"],
      schemas: {
        json: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    });
    const client = new StaticRegistryClient(dump([entry({ path: "/me" }), target]));

    const r = await describeRoute(client, { method: "POST", path: "/accounts" });
    expect(r).toEqual(target);
  });

  it("returns null when no route matches", async () => {
    const client = new StaticRegistryClient(dump([entry({ path: "/me" })]));
    const r = await describeRoute(client, { method: "POST", path: "/unknown" });
    expect(r).toBeNull();
  });

  it("matches exactly on (method, path) — different method same path is a miss", async () => {
    const client = new StaticRegistryClient(
      dump([entry({ method: "GET", path: "/x" }), entry({ method: "POST", path: "/x" })]),
    );

    const get = await describeRoute(client, { method: "GET", path: "/x" });
    const post = await describeRoute(client, { method: "POST", path: "/x" });
    expect(get?.method).toBe("GET");
    expect(post?.method).toBe("POST");
  });

  it("returns the first match if multiple entries somehow share (method, path)", async () => {
    // The framework registry rejects duplicates at registration time; this
    // pins the deterministic behavior in case the dump ever contains them
    // (e.g., a misbehaving custom dump source).
    const a = entry({ method: "GET", path: "/dup", module: "first" });
    const b = entry({ method: "GET", path: "/dup", module: "second" });
    const client = new StaticRegistryClient(dump([a, b]));
    const r = await describeRoute(client, { method: "GET", path: "/dup" });
    expect(r?.module).toBe("first");
  });
});
