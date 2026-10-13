import type { RegistryClient } from "../registryClient.js";
import type { RouteEntry, RouteMethod } from "../types.js";

/**
 * `describe_route` — full per-route detail including JSON Schema for each
 * input target. The route registry pre-converts Zod schemas to JSON Schema
 * via Zod v4's native `z.toJSONSchema()` before serializing to
 * `/dev/routes.json`, so the MCP server has zero Zod runtime cost.
 *
 * Returns `null` when the route doesn't exist — agents check the result
 * before generating downstream code (or pair with `find_route_collisions`
 * before scaffolding a new route).
 */

export interface DescribeRouteArgs {
  method: RouteMethod;
  path: string;
}

export type DescribeRouteResult = RouteEntry | null;

export async function describeRoute(
  client: RegistryClient,
  args: DescribeRouteArgs,
): Promise<DescribeRouteResult> {
  const { routes } = await client.fetch();
  return routes.find((r) => r.method === args.method && r.path === args.path) ?? null;
}
