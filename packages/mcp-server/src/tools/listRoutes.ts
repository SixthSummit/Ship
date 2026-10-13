import type { RegistryClient } from "../registryClient.js";
import type { RouteEntry, RouteFilter, RouteMethod } from "../types.js";

/**
 * `list_routes` — return every registered route, optionally filtered by
 * method / path / module / tag. The shape is deliberately compact (no
 * full schemas) so an agent can pull the table quickly without hitting
 * its context budget. For the full per-route detail, follow up with
 * `describe_route`.
 *
 * Filter semantics: every supplied field is AND-combined; unspecified
 * fields are wildcarded.
 */

export interface ListRoutesArgs {
  method?: RouteMethod;
  path?: string;
  module?: string;
  tag?: string;
  /** Cap the number of returned routes. Default 200. */
  limit?: number;
}

export interface ListRoutesResultEntry {
  method: RouteMethod;
  path: string;
  module?: string;
  auth: { required: boolean; provider?: string };
  permissions: string[];
  schemas: { json?: boolean; query?: boolean; param?: boolean; header?: boolean };
  rateLimit?: { windowMs: number; max: number; scope?: string };
  idempotent?: boolean;
  deprecated?: boolean;
}

export interface ListRoutesResult {
  count: number;
  truncated: boolean;
  routes: ListRoutesResultEntry[];
}

function matches(entry: RouteEntry, filter: RouteFilter): boolean {
  if (filter.method && entry.method !== filter.method) return false;
  if (filter.path && entry.path !== filter.path) return false;
  if (filter.module && entry.module !== filter.module) return false;
  if (filter.tag && !(entry.tags ?? []).includes(filter.tag)) return false;
  return true;
}

function compact(entry: RouteEntry): ListRoutesResultEntry {
  return {
    method: entry.method,
    path: entry.path,
    module: entry.module,
    auth: entry.auth,
    permissions: entry.permissions,
    schemas: {
      json: Boolean(entry.schemas.json),
      query: Boolean(entry.schemas.query),
      param: Boolean(entry.schemas.param),
      header: Boolean(entry.schemas.header),
    },
    rateLimit: entry.rateLimit,
    idempotent: entry.idempotent,
    deprecated: entry.deprecated,
  };
}

export async function listRoutes(
  client: RegistryClient,
  args: ListRoutesArgs = {},
): Promise<ListRoutesResult> {
  const { routes } = await client.fetch();
  const filtered = routes.filter((r) => matches(r, args));
  const limit = args.limit ?? 200;
  const truncated = filtered.length > limit;
  return {
    count: filtered.length,
    truncated,
    routes: filtered.slice(0, limit).map(compact),
  };
}
