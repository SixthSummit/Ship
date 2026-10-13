import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type RouteEntry, RouteRegistry } from "./routes.js";

function makeEntry(overrides: Partial<RouteEntry> = {}): RouteEntry {
  return {
    method: "GET",
    path: "/widgets",
    auth: { required: false },
    permissions: [],
    schemas: {},
    ...overrides,
  };
}

describe("RouteRegistry", () => {
  let registry: RouteRegistry;

  afterEach(() => {
    registry?.clear();
  });

  it("starts empty", () => {
    registry = new RouteRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it("add() appends entries; list() returns defensive copies", () => {
    registry = new RouteRegistry();
    const entry = makeEntry({ path: "/widgets", method: "POST" });
    registry.add(entry);
    expect(registry.size()).toBe(1);

    const listed = registry.list();
    expect(listed[0]).toMatchObject({ method: "POST", path: "/widgets" });
    // Mutating the listed copy must not affect the stored entry.
    listed[0].path = "/mutated";
    expect(registry.list()[0].path).toBe("/widgets");
  });

  it("find() returns the matching entry; undefined when nothing matches", () => {
    registry = new RouteRegistry();
    registry.add(makeEntry({ method: "GET", path: "/me" }));
    registry.add(makeEntry({ method: "POST", path: "/accounts" }));

    expect(registry.find("GET", "/me")).toMatchObject({ method: "GET", path: "/me" });
    expect(registry.find("POST", "/me")).toBeUndefined();
    expect(registry.find("GET", "/missing")).toBeUndefined();
  });

  it("findCollisions() returns all entries with the same (method, path)", () => {
    registry = new RouteRegistry();
    registry.add(makeEntry({ method: "POST", path: "/accounts" }));
    registry.add(makeEntry({ method: "POST", path: "/accounts", module: "duplicate" }));
    registry.add(makeEntry({ method: "GET", path: "/accounts" }));

    const collisions = registry.findCollisions("POST", "/accounts");
    expect(collisions).toHaveLength(2);
    expect(registry.findCollisions("PATCH", "/anything")).toEqual([]);
  });

  it("list() filters by method, path, module, and tag", () => {
    registry = new RouteRegistry();
    registry.add(makeEntry({ method: "GET", path: "/me", module: "me" }));
    registry.add(
      makeEntry({ method: "GET", path: "/accounts", module: "accounts", tags: ["public"] }),
    );
    registry.add(
      makeEntry({ method: "POST", path: "/accounts", module: "accounts", tags: ["mutate"] }),
    );

    expect(registry.list({ method: "GET" })).toHaveLength(2);
    expect(registry.list({ module: "accounts" })).toHaveLength(2);
    expect(registry.list({ path: "/accounts" })).toHaveLength(2);
    expect(registry.list({ tag: "mutate" })).toHaveLength(1);
    expect(registry.list({ method: "GET", module: "accounts" })).toHaveLength(1);
  });

  it("withModule() tags subsequently-added entries with the module name", async () => {
    registry = new RouteRegistry();
    await registry.withModule("accounts", () => {
      registry.add(makeEntry({ path: "/accounts" }));
      registry.add(makeEntry({ path: "/accounts/:id", method: "GET" }));
    });

    const entries = registry.list();
    expect(entries.every((e) => e.module === "accounts")).toBe(true);
  });

  it("withModule() does not overwrite an explicitly-set module", async () => {
    registry = new RouteRegistry();
    await registry.withModule("scope", () => {
      registry.add(makeEntry({ path: "/x", module: "explicit" }));
    });
    expect(registry.list()[0].module).toBe("explicit");
  });

  it("withModule() restores the previous module on completion (and on throw)", async () => {
    registry = new RouteRegistry();
    await registry.withModule("outer", async () => {
      registry.add(makeEntry({ path: "/o" }));
      try {
        await registry.withModule("inner", () => {
          registry.add(makeEntry({ path: "/i" }));
          throw new Error("simulated");
        });
      } catch {
        /* expected */
      }
      registry.add(makeEntry({ path: "/o2" }));
    });

    const entries = registry.list();
    expect(entries.find((e) => e.path === "/o")?.module).toBe("outer");
    expect(entries.find((e) => e.path === "/i")?.module).toBe("inner");
    expect(entries.find((e) => e.path === "/o2")?.module).toBe("outer");
  });

  it("captures schemas + auth + permissions per entry", () => {
    registry = new RouteRegistry();
    const schema = z.object({ name: z.string() });
    registry.add(
      makeEntry({
        method: "POST",
        path: "/widgets",
        auth: { required: true, provider: "firebase" },
        permissions: ["widgets:create"],
        schemas: { json: schema },
        rateLimit: { windowMs: 60_000, max: 5 },
        idempotent: true,
      }),
    );

    const entry = registry.find("POST", "/widgets")!;
    expect(entry.auth).toEqual({ required: true, provider: "firebase" });
    expect(entry.permissions).toEqual(["widgets:create"]);
    expect(entry.schemas.json).toBe(schema);
    expect(entry.rateLimit).toEqual({ windowMs: 60_000, max: 5 });
    expect(entry.idempotent).toBe(true);
  });

  it("clear() empties the registry and resets the active module", async () => {
    registry = new RouteRegistry();
    await registry.withModule("x", () => {
      registry.add(makeEntry({ path: "/a" }));
    });
    registry.clear();
    expect(registry.size()).toBe(0);
    // After clear, fresh additions don't get a stale module
    registry.add(makeEntry({ path: "/b" }));
    expect(registry.list()[0].module).toBeUndefined();
  });
});
