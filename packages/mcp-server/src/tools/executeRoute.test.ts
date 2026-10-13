import { describe, expect, it, vi } from "vitest";
import { StaticRegistryClient } from "../registryClient.js";
import type { RouteEntry, RoutesDump } from "../types.js";
import { executeRoute } from "./executeRoute.js";

function makeDump(routes: RouteEntry[]): RoutesDump {
  return {
    generatedAt: new Date("2025-06-01T00:00:00Z").toISOString(),
    routes,
  };
}

const ROUTE_GET_USERS: RouteEntry = {
  method: "GET",
  path: "/users",
  module: "accounts",
  auth: { required: true, provider: "fake-firebase" },
  permissions: ["accounts:read"],
  schemas: {},
  tags: [],
};

const ROUTE_POST_USERS: RouteEntry = {
  method: "POST",
  path: "/users",
  module: "accounts",
  auth: { required: true, provider: "fake-firebase" },
  permissions: ["accounts:create"],
  schemas: {
    json: {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        name: { type: "string", minLength: 1, maxLength: 100 },
        age: { type: "integer", minimum: 0, maximum: 150 },
      },
      required: ["email", "name"],
      additionalProperties: false,
    },
  },
  tags: [],
};

describe("executeRoute", () => {
  describe("pre-flight: registry lookup", () => {
    it("returns reason='not-found' when no route matches", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      const result = await executeRoute({ method: "DELETE", path: "/users/42" }, client);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("not-found");
      expect(result.entry).toBeUndefined();
    });

    it("returns the matching entry on success", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      const fetchImpl = vi.fn(
        async () =>
          new Response('{"items":[]}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const result = await executeRoute({ method: "GET", path: "/users" }, client, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result.entry).toMatchObject({
        method: "GET",
        path: "/users",
        permissions: ["accounts:read"],
      });
    });
  });

  describe("pre-flight: body schema validation", () => {
    it("returns reason='schema-mismatch' with validation errors when body misses required field", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      const result = await executeRoute(
        {
          method: "POST",
          path: "/users",
          body: { email: "alice@example.test" }, // missing 'name'
        },
        client,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("schema-mismatch");
      expect(result.validationErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "name", message: expect.stringMatching(/required/i) }),
        ]),
      );
    });

    it("rejects extra properties when additionalProperties: false", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      const result = await executeRoute(
        {
          method: "POST",
          path: "/users",
          body: {
            email: "alice@example.test",
            name: "Alice",
            unexpectedField: 42,
          },
        },
        client,
      );
      expect(result.reason).toBe("schema-mismatch");
      expect(result.validationErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "unexpectedField",
            message: expect.stringMatching(/extra/i),
          }),
        ]),
      );
    });

    it("rejects type mismatches", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      const result = await executeRoute(
        {
          method: "POST",
          path: "/users",
          body: {
            email: "alice@example.test",
            name: "Alice",
            age: "not a number",
          },
        },
        client,
      );
      expect(result.reason).toBe("schema-mismatch");
      expect(result.validationErrors?.some((e) => e.path === "age")).toBe(true);
    });

    it("rejects strings that don't match the email format", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      const result = await executeRoute(
        {
          method: "POST",
          path: "/users",
          body: { email: "not-an-email", name: "Alice" },
        },
        client,
      );
      expect(result.reason).toBe("schema-mismatch");
      expect(
        result.validationErrors?.some((e) => e.path === "email" && /email/i.test(e.message)),
      ).toBe(true);
    });

    it("rejects strings that don't match minLength / maxLength", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      const result = await executeRoute(
        {
          method: "POST",
          path: "/users",
          body: { email: "a@b.test", name: "" },
        },
        client,
      );
      expect(result.reason).toBe("schema-mismatch");
      expect(result.validationErrors?.some((e) => e.path === "name")).toBe(true);
    });

    it("rejects integers outside minimum / maximum", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      const result = await executeRoute(
        {
          method: "POST",
          path: "/users",
          body: { email: "a@b.test", name: "Alice", age: -1 },
        },
        client,
      );
      expect(result.reason).toBe("schema-mismatch");
      expect(result.validationErrors?.some((e) => e.path === "age")).toBe(true);
    });

    it("validates uuid format", async () => {
      const route: RouteEntry = {
        ...ROUTE_GET_USERS,
        method: "GET",
        path: "/users/:id",
        schemas: {
          param: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
        },
      };
      // executeRoute only validates `body` (the json target). Param /
      // query schemas aren't applied to this tool's args; the framework's
      // validate() middleware catches them at runtime. So a uuid param
      // mismatch surfaces as a 4xx FROM the dev server, not from our
      // pre-flight. This test confirms we DO validate the json target.
      const post: RouteEntry = {
        method: "POST",
        path: "/users/by-id",
        module: "accounts",
        auth: { required: true },
        permissions: ["accounts:read"],
        schemas: {
          json: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
          },
        },
        tags: [],
      };
      const client = new StaticRegistryClient(makeDump([route, post]));
      const result = await executeRoute(
        { method: "POST", path: "/users/by-id", body: { id: "not-a-uuid" } },
        client,
      );
      expect(result.reason).toBe("schema-mismatch");
      expect(result.validationErrors?.some((e) => e.path === "id" && /uuid/i.test(e.message))).toBe(
        true,
      );
    });

    it("passes when the body is valid", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
      const result = await executeRoute(
        {
          method: "POST",
          path: "/users",
          body: { email: "alice@example.test", name: "Alice", age: 30 },
        },
        client,
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("executed");
    });

    it("skips validation when the route has no JSON schema", async () => {
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      const fetchImpl = vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const result = await executeRoute(
        { method: "GET", path: "/users", body: { anything: "goes" } },
        client,
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("execution: HTTP fetch", () => {
    it("forwards method / headers / body to the dev server", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response('{"id":"abc"}', {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      await executeRoute(
        {
          method: "POST",
          path: "/users",
          headers: { authorization: "Bearer xyz" },
          body: { email: "a@b.test", name: "Alice" },
          baseUrl: "http://localhost:4000",
        },
        client,
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );

      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("http://localhost:4000/users");
      expect(init.method).toBe("POST");
      expect(init.headers["authorization"]).toBe("Bearer xyz");
      expect(init.headers["content-type"]).toBe("application/json");
      expect(init.body).toBe(JSON.stringify({ email: "a@b.test", name: "Alice" }));
    });

    it("does not override an explicit Content-Type", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_POST_USERS]));
      await executeRoute(
        {
          method: "POST",
          path: "/users",
          headers: { "Content-Type": "application/vnd.api+json" },
          body: { email: "a@b.test", name: "Alice" },
        },
        client,
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      const init = fetchImpl.mock.calls[0][1];
      expect(init.headers["Content-Type"]).toBe("application/vnd.api+json");
    });

    it("returns response.status / headers / body / json + durationMs on success", async () => {
      const responseBody = JSON.stringify({ ok: true, count: 7 });
      const fetchImpl = vi.fn(
        async () =>
          new Response(responseBody, {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json", "x-custom": "yes" },
          }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      const result = await executeRoute({ method: "GET", path: "/users" }, client, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result.reason).toBe("executed");
      expect(result.response?.status).toBe(200);
      expect(result.response?.statusText).toBe("OK");
      expect(result.response?.body).toBe(responseBody);
      expect(result.response?.json).toEqual({ ok: true, count: 7 });
      expect(result.response?.headers["x-custom"]).toBe("yes");
      expect(typeof result.durationMs).toBe("number");
    });

    it("returns reason='network' on fetch failure", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:3000");
      });
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      const result = await executeRoute({ method: "GET", path: "/users" }, client, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("network");
      expect(result.error).toContain("ECONNREFUSED");
      expect(result.entry).toBeDefined(); // still surfaces the route entry
    });

    it("does not parse non-JSON response bodies", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("plain text", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      const result = await executeRoute({ method: "GET", path: "/users" }, client, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result.response?.body).toBe("plain text");
      expect(result.response?.json).toBeUndefined();
    });

    it("recovers gracefully when content-type claims JSON but body isn't valid JSON", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("not-actually-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      const result = await executeRoute({ method: "GET", path: "/users" }, client, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result.response?.body).toBe("not-actually-json");
      expect(result.response?.json).toBeUndefined();
    });
  });

  describe("baseUrl resolution", () => {
    it("uses opts.baseUrl when supplied", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      await executeRoute({ method: "GET", path: "/users" }, client, {
        baseUrl: "https://api.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: true,
        remoteLogSink: () => undefined,
      });
      expect(fetchImpl.mock.calls[0][0]).toBe("https://api.example.com/users");
    });

    it("falls back to args.baseUrl when opts.baseUrl is unset", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      await executeRoute(
        { method: "GET", path: "/users", baseUrl: "https://from-args.example.com" },
        client,
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          allowRemote: true,
          remoteLogSink: () => undefined,
        },
      );
      expect(fetchImpl.mock.calls[0][0]).toBe("https://from-args.example.com/users");
    });

    it("defaults to http://localhost:3000 when neither is supplied", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      await executeRoute({ method: "GET", path: "/users" }, client, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(fetchImpl.mock.calls[0][0]).toBe("http://localhost:3000/users");
    });

    it("strips a trailing slash from the baseUrl", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
      const client = new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
      await executeRoute({ method: "GET", path: "/users", baseUrl: "https://api.test/" }, client, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: true,
        remoteLogSink: () => undefined,
      });
      expect(fetchImpl.mock.calls[0][0]).toBe("https://api.test/users");
    });
  });

  describe("loopback-only guard (F7)", () => {
    function freshClient() {
      return new StaticRegistryClient(makeDump([ROUTE_GET_USERS]));
    }
    function okFetch() {
      return vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
    }

    it("refuses a non-loopback baseUrl without the allow-remote opt-in", async () => {
      const fetchImpl = okFetch();
      const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
        baseUrl: "https://prod.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: false,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("remote-not-allowed");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.error).toMatch(/SHIP_API_MCP_ALLOW_REMOTE=1/);
    });

    it("the refused-call surface still includes the matched route entry", async () => {
      const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
        baseUrl: "https://prod.example.com",
        fetchImpl: okFetch() as unknown as typeof fetch,
        allowRemote: false,
      });
      expect(result.entry).toMatchObject({ method: "GET", path: "/users" });
    });

    it("proceeds when allow-remote is set, and writes an audit line to the sink", async () => {
      const fetchImpl = okFetch();
      const log: string[] = [];
      const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
        baseUrl: "https://prod.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: true,
        remoteLogSink: (line) => log.push(line),
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("executed");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/remote execute_route/);
      expect(log[0]).toContain("https://prod.example.com");
      expect(log[0]).toContain("GET /users");
    });

    it("accepts localhost without opt-in", async () => {
      const fetchImpl = okFetch();
      const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
        baseUrl: "http://localhost:3000",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: false,
      });
      expect(result.ok).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("accepts 127.0.0.1 / 127.0.0.5 (entire 127/8) without opt-in", async () => {
      for (const ip of ["127.0.0.1", "127.0.0.5", "127.99.0.1"]) {
        const fetchImpl = okFetch();
        const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
          baseUrl: `http://${ip}:3000`,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          allowRemote: false,
        });
        expect(result.ok, `accepted ${ip}`).toBe(true);
      }
    });

    it("accepts ::1 bracketed IPv6 without opt-in", async () => {
      const fetchImpl = okFetch();
      const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
        baseUrl: "http://[::1]:3000",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: false,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts 0.0.0.0 without opt-in (dev binds-all-interfaces)", async () => {
      const fetchImpl = okFetch();
      const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
        baseUrl: "http://0.0.0.0:3000",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: false,
      });
      expect(result.ok).toBe(true);
    });

    it("rejects 127.0.0.1.nip.io (DNS rebinding-style hostname)", async () => {
      const fetchImpl = okFetch();
      const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
        baseUrl: "http://127.0.0.1.nip.io:3000",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: false,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("remote-not-allowed");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("rejects link-local (169.254.x.x) — not loopback even if dev-shaped", async () => {
      const fetchImpl = okFetch();
      const result = await executeRoute({ method: "GET", path: "/users" }, freshClient(), {
        baseUrl: "http://169.254.169.254/",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        allowRemote: false,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("remote-not-allowed");
    });
  });
});
