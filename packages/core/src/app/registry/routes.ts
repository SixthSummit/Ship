import type { ZodType } from "zod";

/**
 * Runtime route registry — load-bearing primitive for agent introspection.
 *
 * Replaces what OpenAPI was buying us in earlier plan drafts. For *agents*
 * specifically this is more powerful than OpenAPI: we capture auth provider
 * identity, permission slugs, rate-limit policy, idempotency, deprecation,
 * and module ownership — none of which OpenAPI represents natively. And the
 * registry stays live with the running code (no generation step, never stale).
 *
 * Populated by `createApp`'s route-method interceptors when consumer code
 * calls `app.METHOD(path, ...handlers)`. The middleware factories
 * (`validate`, `requireAuth`, `requirePermission`, `rateLimit`, `idempotency`)
 * tag their returned handler via metaTags symbols; the interceptor walks the
 * handler list and reads those tags to assemble a `RouteEntry`.
 *
 * Consumers:
 * - MCP `list_routes` / `describe_route` / `find_route_collisions` /
 *   `execute_route` tools.
 * - The `/dev/routes` HTML debug endpoint.
 * - The `ship-reviewer` Claude plugin agent (convention enforcement).
 * - `ship-api g doctor` (schema-less mutating routes flag, etc.).
 * - v4.x OpenAPI compatibility layer (the OpenAPI generator reads from the
 *   same registry — no duplication, no two-source drift).
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export type RouteMethod = HttpMethod | "WS";

export interface RouteSchemas {
  json?: ZodType;
  query?: ZodType;
  param?: ZodType;
  header?: ZodType;
}

export interface RouteEntry {
  method: RouteMethod;
  path: string;
  /** Module that registered this route (set by InitModules during discovery). */
  module?: string;
  auth: { required: boolean; provider?: string };
  permissions: string[];
  rateLimit?: { windowMs: number; max: number; scope?: string };
  idempotent?: boolean;
  schemas: RouteSchemas;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
}

export interface RouteFilter {
  method?: RouteMethod;
  path?: string;
  module?: string;
  tag?: string;
}

export class RouteRegistry {
  private entries: RouteEntry[] = [];
  /** Module currently being registered — set by InitModules so each captured
   *  route gets `module` populated. */
  private currentModule: string | undefined;

  /** Push a new entry. Called by `createApp`'s interceptors. */
  add(entry: RouteEntry): void {
    if (this.currentModule !== undefined && entry.module === undefined) {
      this.entries.push({ ...entry, module: this.currentModule });
    } else {
      this.entries.push(entry);
    }
  }

  /** Run `fn` with `module` set so any routes registered inside are tagged. */
  async withModule<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.currentModule;
    this.currentModule = name;
    try {
      return await fn();
    } finally {
      this.currentModule = previous;
    }
  }

  /** All entries (defensively cloned). */
  list(filter?: RouteFilter): RouteEntry[] {
    return this.entries.filter((e) => matches(e, filter)).map((e) => ({ ...e }));
  }

  /** First entry matching `(method, path)` — exact path match. */
  find(method: RouteMethod, path: string): RouteEntry | undefined {
    const match = this.entries.find((e) => e.method === method && e.path === path);
    return match ? { ...match } : undefined;
  }

  /**
   * Find routes that would collide with a proposed `(method, path)`. Returns
   * exact matches only (not param-pattern overlap — that's a separate
   * route-tree concern). Empty array means safe to add.
   */
  findCollisions(method: RouteMethod, path: string): RouteEntry[] {
    return this.entries
      .filter((e) => e.method === method && e.path === path)
      .map((e) => ({ ...e }));
  }

  size(): number {
    return this.entries.length;
  }

  /** Remove all entries — primarily for tests. */
  clear(): void {
    this.entries = [];
    this.currentModule = undefined;
  }
}

function matches(entry: RouteEntry, filter?: RouteFilter): boolean {
  if (!filter) return true;
  if (filter.method && entry.method !== filter.method) return false;
  if (filter.path && entry.path !== filter.path) return false;
  if (filter.module && entry.module !== filter.module) return false;
  if (filter.tag && !(entry.tags ?? []).includes(filter.tag)) return false;
  return true;
}

/**
 * Default framework-wide registry. `createApp` populates this. Tests should
 * call `routeRegistry.clear()` in `afterEach` to avoid cross-test bleed.
 */
export const routeRegistry = new RouteRegistry();
