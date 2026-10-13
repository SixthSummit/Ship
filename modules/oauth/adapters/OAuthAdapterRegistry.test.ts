import { describe, expect, it } from "vitest";
import { MockOAuthAdapter } from "./MockOAuthAdapter.js";
import { OAuthAdapterRegistry, oauthAdapterRegistry } from "./OAuthAdapterRegistry.js";

describe("OAuthAdapterRegistry", () => {
  it("starts empty", () => {
    const registry = new OAuthAdapterRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.providerCodes()).toEqual([]);
  });

  it("register / has / get round-trip", () => {
    const adapter = new MockOAuthAdapter("google");
    const registry = new OAuthAdapterRegistry().register(adapter);
    expect(registry.size()).toBe(1);
    expect(registry.has("google")).toBe(true);
    expect(registry.get("google")).toBe(adapter);
    expect(registry.providerCodes()).toEqual(["google"]);
  });

  it("get(unknown) returns undefined", () => {
    const registry = new OAuthAdapterRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });

  it("require(unknown) throws with helpful detail", () => {
    const registry = new OAuthAdapterRegistry()
      .register(new MockOAuthAdapter("google"))
      .register(new MockOAuthAdapter("microsoft"));
    expect(() => registry.require("apple")).toThrowError(/apple/);
    expect(() => registry.require("apple")).toThrowError(/google|microsoft/);
  });

  it("require(known) returns the adapter", () => {
    const adapter = new MockOAuthAdapter("google");
    const registry = new OAuthAdapterRegistry().register(adapter);
    expect(registry.require("google")).toBe(adapter);
  });

  it("rejects duplicate registrations", () => {
    const a = new MockOAuthAdapter("google");
    const b = new MockOAuthAdapter("google");
    const registry = new OAuthAdapterRegistry().register(a);
    expect(() => registry.register(b)).toThrowError(/duplicate/i);
  });

  it("register is chainable", () => {
    const registry = new OAuthAdapterRegistry();
    const result = registry
      .register(new MockOAuthAdapter("google"))
      .register(new MockOAuthAdapter("microsoft"));
    expect(result).toBe(registry);
    expect(registry.size()).toBe(2);
  });

  it("oauthAdapterRegistry() factory builds a populated registry in one call", () => {
    const registry = oauthAdapterRegistry(
      new MockOAuthAdapter("google"),
      new MockOAuthAdapter("microsoft"),
      new MockOAuthAdapter("gmail"),
    );
    expect(registry.size()).toBe(3);
    expect(registry.providerCodes().sort()).toEqual(["gmail", "google", "microsoft"]);
  });
});
