#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HttpRegistryClient, type RegistryClient } from "./registryClient.js";
import { describeRoute, executeRoute, findRouteCollisions, listRoutes } from "./tools/index.js";

/**
 * Stdio MCP server that exposes ShipAPI's route registry to Claude Code,
 * Cursor, and any other MCP-aware LLM agent.
 *
 * Agent invokes the framework's `/dev/routes.json` (running app, typically
 * `ship-api dev`) via this server's tools:
 *
 *   - `list_routes(method?, path?, module?, tag?, limit?)` — compact route
 *     table for scanning.
 *   - `describe_route(method, path)` — full RouteEntry incl. JSON Schema
 *     for each input target. Returns null when the route doesn't exist.
 *   - `find_route_collisions(method, path, includePathPatternOverlap?)` —
 *     pre-flight check before scaffolding a new route.
 *
 * The route-table contents come from a `RegistryClient`. Default is an
 * `HttpRegistryClient` pointed at `process.env.SHIP_API_DEV_URL` (default
 * `http://localhost:3000`). Tests construct an in-process client (e.g.,
 * `StaticRegistryClient`) and pass it to `buildServer(...)`.
 *
 * Run via: `npx ship-api-mcp-server` (the bin entry point).
 *
 * Configure in Claude Code via `.mcp.json`:
 *   {
 *     "mcpServers": {
 *       "ship-api": {
 *         "command": "npx",
 *         "args": ["ship-api-mcp-server"],
 *         "env": { "SHIP_API_DEV_URL": "http://localhost:3000" }
 *       }
 *     }
 *   }
 */

/**
 * Version advertised to MCP clients by default: the package's own
 * `package.json` version, so the value tracks releases instead of a
 * hard-coded literal. Resolved relative to this module, which works from
 * both `src/` and the built `lib/`.
 */
export const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export interface BuildServerOptions {
  /** Registry data source. Defaults to an HttpRegistryClient using env config. */
  client?: RegistryClient;
  /** Server name advertised to clients. */
  name?: string;
  /** Server version advertised to clients. Defaults to the package's own version. */
  version?: string;
}

export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const client =
    opts.client ??
    new HttpRegistryClient({
      baseUrl: process.env.SHIP_API_DEV_URL,
    });

  const server = new McpServer({
    name: opts.name ?? "ship-api-mcp-server",
    version: opts.version ?? PACKAGE_VERSION,
  });

  server.registerTool(
    "list_routes",
    {
      description:
        "List ShipAPI routes registered in the running dev app, optionally filtered by method / path / module / tag. " +
        "Returns a compact table (no full JSON Schemas) for quick scanning. " +
        "Follow up with describe_route(method, path) for the full per-route detail.",
      inputSchema: {
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "WS"])
          .optional(),
        path: z.string().optional(),
        module: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const result = await listRoutes(client, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "describe_route",
    {
      description:
        "Fetch the full RouteEntry for a single route (method + path), including JSON Schema for each input target " +
        "(json/query/param/header), auth requirements, permission slugs, rate-limit policy, idempotency flag, " +
        "deprecation flag, and tags. Returns null when the route doesn't exist.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "WS"]),
        path: z.string(),
      },
    },
    async (args) => {
      const result = await describeRoute(client, args);
      return {
        content: [
          {
            type: "text",
            text: result === null ? "null" : JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "find_route_collisions",
    {
      description:
        "Check whether a (method, path) tuple is already registered before scaffolding a new route. " +
        "Returns { collisions: [...], overlaps: [...] } where collisions are exact matches and " +
        "overlaps are path-pattern matches (e.g., GET /users/:id vs GET /users/me) when includePathPatternOverlap=true. " +
        "Empty arrays mean safe to add.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "WS"]),
        path: z.string(),
        includePathPatternOverlap: z.boolean().optional(),
      },
    },
    async (args) => {
      const result = await findRouteCollisions(client, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "execute_route",
    {
      description:
        "Execute a registered route against the running dev server and return the response. " +
        "Pre-flight: looks up the route in the registry (returns reason='not-found' if missing); " +
        "validates the JSON body against the route's schema (returns reason='schema-mismatch' with " +
        "validationErrors when the body doesn't fit). On execution success, returns " +
        "reason='executed' with response { status, statusText, headers, body, json? } and durationMs. " +
        "On network failure, returns reason='network' with the error message. " +
        "Non-loopback baseUrls (anything that isn't localhost / 127.x.x.x / ::1 / 0.0.0.0) are refused " +
        "with reason='remote-not-allowed' unless the operator sets SHIP_API_MCP_ALLOW_REMOTE=1; " +
        "this is a dev-time MCP server, not a production driver. " +
        "The load-bearing differentiator: agents iterate against the real middleware chain, not a static schema dump.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "WS"]),
        path: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
        baseUrl: z.string().optional(),
      },
    },
    async (args) => {
      const result = await executeRoute(args, client, {
        baseUrl: args.baseUrl ?? process.env.SHIP_API_DEV_URL,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-run when executed as the binary (not when imported as a module).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/server.js") ||
  process.argv[1]?.endsWith("\\server.js")
) {
  main().catch((err: unknown) => {
    process.stderr.write(`ship-api-mcp-server failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
