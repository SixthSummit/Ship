/**
 * End-to-end test for the MCP server's tool surface — drives the
 * real `McpServer` lifecycle via the SDK's `InMemoryTransport`.
 *
 * V4_STATUS G4 slice 2. Per-tool tests already exist
 * (listRoutes / describeRoute / findRouteCollisions / executeRoute);
 * this layer verifies that:
 *
 *   1. `buildServer({ client })` registers all four tools and they
 *      surface via `client.listTools()` with the right names.
 *   2. Each tool's `inputSchema` validates correctly — wrong-shape
 *      inputs come back as MCP errors, not runtime crashes.
 *   3. The tools' return-shape (text content with JSON body) matches
 *      what Claude Code expects to read.
 *
 * Uses `InMemoryTransport.createLinkedPair()` — same machinery as
 * the SDK's own integration tests. No child processes, no stdio,
 * no flake from process startup.
 */

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { StaticRegistryClient } from "./registryClient.js";
import { buildServer, PACKAGE_VERSION } from "./server.js";
import type { RouteEntry, RoutesDump } from "./types.js";

const SAMPLE_ROUTES: RouteEntry[] = [
  {
    method: "GET",
    path: "/me",
    module: "accounts",
    auth: { required: true, provider: "fake-firebase" },
    permissions: ["me:read"],
    schemas: {},
    tags: [],
  },
  {
    method: "POST",
    path: "/accounts",
    module: "accounts",
    auth: { required: true, provider: "fake-firebase" },
    permissions: ["accounts:create"],
    schemas: {
      json: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          name: { type: "string", minLength: 1 },
        },
        required: ["email", "name"],
        additionalProperties: false,
      },
    },
    tags: [],
  },
];

const SAMPLE_DUMP: RoutesDump = {
  generatedAt: new Date("2025-06-01T00:00:00Z").toISOString(),
  routes: SAMPLE_ROUTES,
};

async function buildLinkedClient(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({
    client: new StaticRegistryClient(SAMPLE_DUMP),
  });
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

describe("MCP server — end-to-end (in-memory transport)", () => {
  it("advertises the package's own version by default", async () => {
    const { client, cleanup } = await buildLinkedClient();
    try {
      const manifest = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      expect(PACKAGE_VERSION).toBe(manifest.version);
      expect(client.getServerVersion()).toEqual({
        name: "ship-api-mcp-server",
        version: manifest.version,
      });
    } finally {
      await cleanup();
    }
  });

  it("listTools surfaces all four tools registered by buildServer", async () => {
    const { client, cleanup } = await buildLinkedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "describe_route",
        "execute_route",
        "find_route_collisions",
        "list_routes",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("each tool advertises a non-empty description (the LLM uses it for tool-selection)", async () => {
    const { client, cleanup } = await buildLinkedClient();
    try {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeDefined();
        expect((tool.description as string).length).toBeGreaterThan(20);
      }
    } finally {
      await cleanup();
    }
  });

  describe("list_routes", () => {
    it("returns the full route table when no filter is supplied", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "list_routes",
          arguments: {},
        });
        const payload = parseFirstTextPayload(result);
        expect(payload.routes).toHaveLength(2);
      } finally {
        await cleanup();
      }
    });

    it("filters by method when supplied", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "list_routes",
          arguments: { method: "POST" },
        });
        const payload = parseFirstTextPayload(result);
        expect(payload.routes).toHaveLength(1);
        expect(payload.routes[0].method).toBe("POST");
      } finally {
        await cleanup();
      }
    });
  });

  describe("describe_route", () => {
    it("returns the full RouteEntry incl. JSON Schema for an existing route", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "describe_route",
          arguments: { method: "POST", path: "/accounts" },
        });
        const payload = parseFirstTextPayload(result);
        expect(payload.method).toBe("POST");
        expect(payload.path).toBe("/accounts");
        expect(payload.permissions).toEqual(["accounts:create"]);
        expect(payload.schemas?.json).toBeDefined();
      } finally {
        await cleanup();
      }
    });

    it("returns null for a route that doesn't exist", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "describe_route",
          arguments: { method: "DELETE", path: "/nonexistent" },
        });
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(text).toBe("null");
      } finally {
        await cleanup();
      }
    });
  });

  describe("find_route_collisions", () => {
    it("returns the collision when a (method, path) is already registered", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "find_route_collisions",
          arguments: { method: "GET", path: "/me" },
        });
        const payload = parseFirstTextPayload(result);
        expect(payload.collisions).toHaveLength(1);
        expect(payload.collisions[0].path).toBe("/me");
      } finally {
        await cleanup();
      }
    });

    it("returns empty collisions for a free (method, path)", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "find_route_collisions",
          arguments: { method: "POST", path: "/billing" },
        });
        const payload = parseFirstTextPayload(result);
        expect(payload.collisions).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });

  describe("execute_route", () => {
    it("returns reason='not-found' when the route doesn't exist", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "execute_route",
          arguments: { method: "DELETE", path: "/nonexistent" },
        });
        const payload = parseFirstTextPayload(result);
        expect(payload.ok).toBe(false);
        expect(payload.reason).toBe("not-found");
      } finally {
        await cleanup();
      }
    });

    it("returns reason='schema-mismatch' with validationErrors when body fails the route's schema", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "execute_route",
          arguments: {
            method: "POST",
            path: "/accounts",
            // Missing required `name`; this should fail pre-flight
            // schema validation BEFORE any HTTP call.
            body: { email: "alice@example.test" },
          },
        });
        const payload = parseFirstTextPayload(result);
        expect(payload.ok).toBe(false);
        expect(payload.reason).toBe("schema-mismatch");
        expect(payload.validationErrors).toBeDefined();
        expect(payload.validationErrors.length).toBeGreaterThan(0);
        expect(
          payload.validationErrors.some(
            (e: { path: string; message: string }) =>
              e.path === "name" && /required/i.test(e.message),
          ),
        ).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("input validation", () => {
    it("rejects describe_route when method is missing", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "describe_route",
          arguments: { path: "/me" }, // no method
        });
        // MCP wraps Zod validation errors in `result.isError === true`.
        expect(result.isError).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("rejects unknown tool names with an isError result", async () => {
      const { client, cleanup } = await buildLinkedClient();
      try {
        const result = await client.callTool({
          name: "this_tool_does_not_exist",
          arguments: {},
        });
        // The MCP SDK wraps unknown-tool dispatch failures in
        // `{ isError: true, content: [{ type: 'text', text: 'MCP error -32602: ...' }] }`
        // rather than throwing — this is what Claude Code sees and
        // surfaces back to the user.
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(text).toMatch(/this_tool_does_not_exist/);
      } finally {
        await cleanup();
      }
    });
  });
});

/** Pull the JSON-decoded body from the first `text` content block. */
function parseFirstTextPayload(result: {
  content: unknown;
}): Record<string, unknown> & { [key: string]: any } {
  const blocks = result.content as Array<{ type: string; text: string }>;
  const first = blocks.find((b) => b.type === "text");
  if (!first) throw new Error("no text content in tool result");
  return JSON.parse(first.text);
}
