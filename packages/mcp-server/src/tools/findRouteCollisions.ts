import type { RegistryClient } from "../registryClient.js";
import type { RouteEntry, RouteMethod } from "../types.js";

/**
 * `find_route_collisions` — load-bearing for agent-driven scaffolding.
 *
 * Before adding a new route, the agent checks whether `(method, path)`
 * already exists. Empty result → safe to add. Non-empty → existing
 * registration; agent should either pick a different path, edit the
 * existing handler, or surface the conflict to the user.
 *
 * Match semantics:
 *
 *   - Exact match (same method, same path) — primary check.
 *   - Optional `{ includePathPatternOverlap: true }` also flags routes
 *     whose path patterns would route the same concrete URL. E.g.,
 *     `GET /users/:id` overlaps `GET /users/me` for any value of `:id`.
 *     This is best-effort static analysis, not a full route-tree
 *     resolution.
 */

export interface FindRouteCollisionsArgs {
  method: RouteMethod;
  path: string;
  includePathPatternOverlap?: boolean;
}

export interface FindRouteCollisionsResult {
  collisions: RouteEntry[];
  overlaps: RouteEntry[];
}

function pathPatternsOverlap(a: string, b: string): boolean {
  const aSegs = a.split("/");
  const bSegs = b.split("/");
  if (aSegs.length !== bSegs.length) return false;
  for (let i = 0; i < aSegs.length; i++) {
    const aSeg = aSegs[i] ?? "";
    const bSeg = bSegs[i] ?? "";
    const aIsParam = aSeg.startsWith(":") || aSeg.startsWith("{");
    const bIsParam = bSeg.startsWith(":") || bSeg.startsWith("{");
    if (aIsParam || bIsParam) continue; // a segment of either is wildcard
    if (aSeg !== bSeg) return false;
  }
  return true;
}

export async function findRouteCollisions(
  client: RegistryClient,
  args: FindRouteCollisionsArgs,
): Promise<FindRouteCollisionsResult> {
  const { routes } = await client.fetch();

  const collisions = routes.filter((r) => r.method === args.method && r.path === args.path);

  let overlaps: RouteEntry[] = [];
  if (args.includePathPatternOverlap) {
    overlaps = routes.filter(
      (r) =>
        r.method === args.method && r.path !== args.path && pathPatternsOverlap(r.path, args.path),
    );
  }

  return { collisions, overlaps };
}
