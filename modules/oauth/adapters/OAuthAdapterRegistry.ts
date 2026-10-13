import type { OAuthAdapter } from "./OAuthAdapter.js";

/**
 * Registry of `OAuthAdapter`s keyed by `providerCode`. The routes
 * layer does `registry.get(providerCode)` to dispatch each request
 * to the right provider implementation.
 *
 * Replaces v3's `AdapterRegistry` static-class pattern with an
 * instance-based registry — lets consumers compose multiple registries
 * (e.g., a per-tenant subset of providers) and lets tests construct a
 * registry with a single mock adapter without touching globals.
 *
 * Why instance-based: v3's `AdapterRegistry` was a static class with a
 * hard-coded `ADAPTER_MAP`, which meant adding a provider required
 * editing the framework. v4 pushes the choice of which providers a
 * consumer supports out to the consumer's bootstrap code:
 *
 * ```ts
 * const registry = new OAuthAdapterRegistry()
 *   .register(new GoogleOAuthAdapter())
 *   .register(new MicrosoftOAuthAdapter());
 *
 * defineOAuthRoutes(app, { service, provider, adapters: registry });
 * ```
 */
export class OAuthAdapterRegistry {
  private readonly adapters = new Map<string, OAuthAdapter>();

  /** Add an adapter. Chainable. Throws on duplicate `providerCode`. */
  register(adapter: OAuthAdapter): this {
    if (this.adapters.has(adapter.providerCode)) {
      throw new Error(
        `OAuthAdapterRegistry: duplicate adapter for provider "${adapter.providerCode}"`,
      );
    }
    this.adapters.set(adapter.providerCode, adapter);
    return this;
  }

  /** Look up an adapter, returns `undefined` when not registered. */
  get(providerCode: string): OAuthAdapter | undefined {
    return this.adapters.get(providerCode);
  }

  /**
   * Look up an adapter, throws when not registered. Use from routes
   * layer when the request is parameterized on a provider that
   * `mustExist` semantically.
   */
  require(providerCode: string): OAuthAdapter {
    const adapter = this.adapters.get(providerCode);
    if (!adapter) {
      throw new Error(
        `No OAuth adapter registered for provider "${providerCode}". Registered: ${this.providerCodes().join(", ") || "(none)"}.`,
      );
    }
    return adapter;
  }

  has(providerCode: string): boolean {
    return this.adapters.has(providerCode);
  }

  providerCodes(): string[] {
    return [...this.adapters.keys()];
  }

  size(): number {
    return this.adapters.size;
  }
}

export function oauthAdapterRegistry(...adapters: OAuthAdapter[]): OAuthAdapterRegistry {
  const registry = new OAuthAdapterRegistry();
  for (const a of adapters) registry.register(a);
  return registry;
}
