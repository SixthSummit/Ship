import { describe, expect, it } from "vitest";
import {
  anyPermission,
  authenticatedAccess,
  isOperationAccess,
  optionalIdentityAccess,
  permission,
  providerAccess,
  publicAccess,
  systemAccess,
} from "./access.js";

describe("operation access declarations", () => {
  it("creates immutable public, optional-identity, and authenticated declarations", () => {
    const anonymous = publicAccess();
    const optionalIdentity = optionalIdentityAccess();
    const authenticated = authenticatedAccess();

    expect(anonymous).toEqual({ kind: "public" });
    expect(optionalIdentity).toEqual({ kind: "optional-identity" });
    expect(authenticated).toEqual({ kind: "authenticated" });
    expect(Object.isFrozen(anonymous)).toBe(true);
    expect(Object.isFrozen(optionalIdentity)).toBe(true);
    expect(Object.isFrozen(authenticated)).toBe(true);
    expect(isOperationAccess(anonymous)).toBe(true);
    expect(isOperationAccess(optionalIdentity)).toBe(true);
    expect(isOperationAccess(authenticated)).toBe(true);
  });

  it("creates all-of and any-of permission declarations", () => {
    expect(permission("accounts:read", "accounts:details:read")).toEqual({
      kind: "permissions",
      mode: "all",
      permissions: ["accounts:read", "accounts:details:read"],
    });
    expect(anyPermission("accounts:read", "accounts:read-any")).toEqual({
      kind: "permissions",
      mode: "any",
      permissions: ["accounts:read", "accounts:read-any"],
    });
    expect(permission("companies.view", "agent-billing.manage")).toEqual({
      kind: "permissions",
      mode: "all",
      permissions: ["companies.view", "agent-billing.manage"],
    });
  });

  it.each([
    ["empty list", () => permission()],
    ["invalid slug", () => permission("Accounts.Read")],
    ["unscoped slug", () => permission("accounts")],
    ["duplicate slug", () => permission("accounts:read", "accounts:read")],
  ])("rejects %s", (_name, create) => {
    expect(create).toThrow(TypeError);
  });

  it("rejects malformed declarations supplied by JavaScript callers", () => {
    expect(isOperationAccess({ kind: "permissions", mode: "some", permissions: ["a:b"] })).toBe(
      false,
    );
    expect(
      isOperationAccess({ kind: "permissions", mode: "all", permissions: ["a:b", "a:b"] }),
    ).toBe(false);
    expect(isOperationAccess({ kind: "custom" })).toBe(false);
  });
});

describe("actor kind access declarations", () => {
  it("creates frozen system and provider declarations", () => {
    const system = systemAccess();
    const provider = providerAccess("stripe.webhooks");

    expect(system).toEqual({ kind: "system" });
    expect(provider).toEqual({ kind: "provider", provider: "stripe.webhooks" });
    expect(Object.isFrozen(system)).toBe(true);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(isOperationAccess(system)).toBe(true);
    expect(isOperationAccess(provider)).toBe(true);
  });

  it("rejects malformed provider ids", () => {
    expect(() => providerAccess("Stripe")).toThrow(TypeError);
    expect(() => (providerAccess as (value: unknown) => unknown)(undefined)).toThrow(TypeError);
    expect(isOperationAccess({ kind: "provider", provider: "" })).toBe(false);
    expect(isOperationAccess({ kind: "provider" })).toBe(false);
  });
});
