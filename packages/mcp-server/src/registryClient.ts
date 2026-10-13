import type { RoutesDump } from "./types.js";

/**
 * `RegistryClient` — abstraction over how the MCP server obtains the route
 * registry. Two production sources:
 *
 * 1. **Live** (`HttpRegistryClient`) — fetches `/dev/routes.json` from a
 *    running ShipAPI app. The agent runs `ship-api dev` (which exposes
 *    the endpoint) and the MCP server polls it. Always fresh; survives
 *    code changes without rebuilding.
 *
 * 2. **Static** (`StaticRegistryClient`) — receives a pre-loaded `RoutesDump`
 *    in-memory. Useful for tests, for build-time static analysis, and
 *    for read-only consumers that don't want to dial the running app.
 *
 * Both implement the same `fetch()` interface. Tools depend on the interface,
 * not the implementation.
 */

export interface RegistryClient {
  /** Returns the current route dump. May be cached or live. */
  fetch(): Promise<RoutesDump>;
}

export interface HttpRegistryClientOptions {
  /** Base URL where the ShipAPI app is reachable. Default `http://localhost:3000`. */
  baseUrl?: string;
  /**
   * Mount-path prefix the framework's `registerDevRoutes` was called with.
   * Default empty (routes at `/dev/routes.json`).
   */
  prefix?: string;
  /**
   * Cache TTL in ms. The dump is refetched after this window elapses.
   * Default 5_000 (5 s) — tight enough that a code-change reload is
   * picked up almost immediately. Set 0 to disable caching.
   */
  cacheTtlMs?: number;
  /** Override `fetch` (for tests). */
  fetchImpl?: typeof fetch;
}

export class HttpRegistryClient implements RegistryClient {
  private baseUrl: string;
  private prefix: string;
  private cacheTtlMs: number;
  private fetchImpl: typeof fetch;
  private cached: { at: number; dump: RoutesDump } | null = null;

  constructor(opts: HttpRegistryClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
    this.prefix = opts.prefix ?? "";
    this.cacheTtlMs = opts.cacheTtlMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async fetch(): Promise<RoutesDump> {
    const now = Date.now();
    if (this.cached !== null && this.cacheTtlMs > 0 && now - this.cached.at < this.cacheTtlMs) {
      return this.cached.dump;
    }
    const url = `${this.baseUrl}${this.prefix}/dev/routes.json`;
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(
        `HttpRegistryClient: ${res.status} ${res.statusText} from ${url} ` +
          `(is the app running and is registerDevRoutes enabled?)`,
      );
    }
    const dump = (await res.json()) as RoutesDump;
    this.cached = { at: now, dump };
    return dump;
  }

  /** Test helper. */
  invalidate(): void {
    this.cached = null;
  }
}

export class StaticRegistryClient implements RegistryClient {
  constructor(private dump: RoutesDump) {}
  async fetch(): Promise<RoutesDump> {
    return this.dump;
  }
  setDump(dump: RoutesDump): void {
    this.dump = dump;
  }
}
