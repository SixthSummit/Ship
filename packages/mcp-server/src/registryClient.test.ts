import { describe, expect, it, vi } from "vitest";
import { HttpRegistryClient, StaticRegistryClient } from "./registryClient.js";
import type { RoutesDump } from "./types.js";

function fixtureDump(): RoutesDump {
  return {
    ok: true,
    count: 1,
    routes: [
      {
        method: "GET",
        path: "/me",
        auth: { required: true, provider: "firebase" },
        permissions: ["me:read"],
        schemas: {},
      },
    ],
  };
}

function makeFakeFetch(
  responder: (url: string) =>
    | { ok: boolean; status?: number; json: unknown }
    | Promise<{
        ok: boolean;
        status?: number;
        json: unknown;
      }>,
): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const r = await responder(String(url));
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.ok ? "OK" : "Error",
      async json() {
        return r.json;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("HttpRegistryClient", () => {
  it("fetches /dev/routes.json from the configured baseUrl", async () => {
    const fakeFetch = makeFakeFetch(() => ({ ok: true, json: fixtureDump() }));
    const client = new HttpRegistryClient({
      baseUrl: "http://app.local:4000",
      fetchImpl: fakeFetch,
      cacheTtlMs: 0,
    });
    const dump = await client.fetch();
    expect(dump.count).toBe(1);
    expect(fakeFetch).toHaveBeenCalledWith("http://app.local:4000/dev/routes.json");
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fakeFetch = makeFakeFetch(() => ({ ok: true, json: fixtureDump() }));
    const client = new HttpRegistryClient({
      baseUrl: "http://app.local:4000/",
      fetchImpl: fakeFetch,
      cacheTtlMs: 0,
    });
    await client.fetch();
    expect(fakeFetch).toHaveBeenCalledWith("http://app.local:4000/dev/routes.json");
  });

  it("respects a mount-path prefix", async () => {
    const fakeFetch = makeFakeFetch(() => ({ ok: true, json: fixtureDump() }));
    const client = new HttpRegistryClient({
      baseUrl: "http://app.local:4000",
      prefix: "/admin",
      fetchImpl: fakeFetch,
      cacheTtlMs: 0,
    });
    await client.fetch();
    expect(fakeFetch).toHaveBeenCalledWith("http://app.local:4000/admin/dev/routes.json");
  });

  it("caches the dump for cacheTtlMs and refetches after expiry", async () => {
    let calls = 0;
    const fakeFetch = makeFakeFetch(() => {
      calls += 1;
      return { ok: true, json: fixtureDump() };
    });
    const client = new HttpRegistryClient({
      baseUrl: "http://x:1",
      cacheTtlMs: 100,
      fetchImpl: fakeFetch,
    });

    await client.fetch();
    await client.fetch();
    expect(calls).toBe(1); // second call hit cache

    await new Promise((r) => setTimeout(r, 110));
    await client.fetch();
    expect(calls).toBe(2);
  });

  it("disables caching with cacheTtlMs: 0", async () => {
    let calls = 0;
    const fakeFetch = makeFakeFetch(() => {
      calls += 1;
      return { ok: true, json: fixtureDump() };
    });
    const client = new HttpRegistryClient({
      baseUrl: "http://x:1",
      cacheTtlMs: 0,
      fetchImpl: fakeFetch,
    });

    await client.fetch();
    await client.fetch();
    expect(calls).toBe(2);
  });

  it("invalidate() forces a refetch", async () => {
    let calls = 0;
    const fakeFetch = makeFakeFetch(() => {
      calls += 1;
      return { ok: true, json: fixtureDump() };
    });
    const client = new HttpRegistryClient({
      baseUrl: "http://x:1",
      cacheTtlMs: 60_000,
      fetchImpl: fakeFetch,
    });

    await client.fetch();
    client.invalidate();
    await client.fetch();
    expect(calls).toBe(2);
  });

  it("throws a clear error when the app responds non-OK", async () => {
    const fakeFetch = makeFakeFetch(() => ({ ok: false, status: 404, json: {} }));
    const client = new HttpRegistryClient({
      baseUrl: "http://x:1",
      fetchImpl: fakeFetch,
      cacheTtlMs: 0,
    });
    await expect(client.fetch()).rejects.toThrow(/404/);
  });
});

describe("StaticRegistryClient", () => {
  it("returns the dump it was constructed with", async () => {
    const dump = fixtureDump();
    const client = new StaticRegistryClient(dump);
    expect(await client.fetch()).toEqual(dump);
  });

  it("setDump replaces the held dump", async () => {
    const a = fixtureDump();
    const b: RoutesDump = { ok: true, count: 0, routes: [] };
    const client = new StaticRegistryClient(a);
    client.setDump(b);
    expect((await client.fetch()).count).toBe(0);
  });
});
