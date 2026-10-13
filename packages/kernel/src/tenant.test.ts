import { describe, expect, it, vi } from "vitest";
import { operationActor, providerActor, systemActor } from "./actor.js";
import {
  createTenantBypassAuthority,
  createTenantScopeAuthority,
  isTenantBypass,
  isTenantScope,
  recordTenantBypassUse,
} from "./tenant.js";

const actor = operationActor({ id: "actor-1", permissions: ["tenant:read"] });

describe("tenant scope capabilities", () => {
  it("issues immutable tenant evidence only after authorization", async () => {
    const authorize = vi.fn(() => true);
    const authority = createTenantScopeAuthority({ id: "accounts.tenant-scope", authorize });
    const request = { tenantId: "tenant-a" as const, requestId: "request-1", actor };

    const scope = await authority.issue(request);

    expect(authority).toMatchObject({
      kind: "ship.tenant-scope-authority",
      id: "accounts.tenant-scope",
    });
    expect(scope).toMatchObject({
      kind: "ship.tenant-scope",
      tenantId: "tenant-a",
      requestId: "request-1",
      actorId: "actor-1",
    });
    expect(authorize).toHaveBeenCalledWith(request);
    expect(Object.isFrozen(authorize.mock.calls[0]![0])).toBe(true);
    expect(isTenantScope(scope)).toBe(true);
    expect(isTenantScope({ ...scope })).toBe(false);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it("issues the same actor and tenant snapshot that asynchronous policy authorized", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalActor = {
      id: "allowed-actor",
      kind: "human" as const,
      permissions: new Set(["tenant:read"]),
    };
    const request = { tenantId: "allowed", requestId: "request-1", actor: originalActor };
    const authority = createTenantScopeAuthority({
      id: "accounts.tenant",
      authorize: async (snapshot) => {
        await pending;
        expect(snapshot.actor.id).toBe("allowed-actor");
        expect([...snapshot.actor.permissions!]).toEqual(["tenant:read"]);
        return snapshot.tenantId === "allowed";
      },
    });
    const issued = authority.issue(request);
    request.tenantId = "forbidden";
    request.requestId = "request-2";
    originalActor.id = "forbidden-actor";
    originalActor.permissions.clear();
    release();
    await expect(issued).resolves.toMatchObject({
      tenantId: "allowed",
      requestId: "request-1",
      actorId: "allowed-actor",
    });
  });

  it("preserves an authorized numeric tenant identifier", async () => {
    const authority = createTenantScopeAuthority({
      id: "accounts.tenant-scope",
      authorize: async () => true,
    });

    await expect(
      authority.issue({ tenantId: 42, requestId: "job-1", actor }),
    ).resolves.toMatchObject({ tenantId: 42, actorId: "actor-1" });
  });

  it.each([
    [null, undefined],
    [{ id: "Bad ID", authorize: () => true }, "id"],
    [{ id: "accounts.tenant", authorize: true }, "authorize"],
  ])("rejects an invalid scope authority %#", (definition, field) => {
    expect(() => createTenantScopeAuthority(definition as never)).toThrowError(
      expect.objectContaining({ code: "SHIP_TENANT_SCOPE_AUTHORITY_INVALID", field }),
    );
  });

  it.each([
    [null, undefined],
    [{ tenantId: "", requestId: "request-1", actor }, "tenantId"],
    [{ tenantId: " tenant-a", requestId: "request-1", actor }, "tenantId"],
    [{ tenantId: Number.NaN, requestId: "request-1", actor }, "tenantId"],
    [{ tenantId: "tenant-a", requestId: "", actor }, "requestId"],
    [{ tenantId: "tenant-a", requestId: "request-1", actor: null }, "actor"],
  ])("rejects invalid tenant scope evidence %#", async (request, field) => {
    const authority = createTenantScopeAuthority({
      id: "accounts.tenant-scope",
      authorize: () => true,
    });
    await expect(authority.issue(request as never)).rejects.toMatchObject({
      code: "SHIP_TENANT_SCOPE_REQUEST_INVALID",
      field,
      authorityId: "accounts.tenant-scope",
    });
  });

  it("does not issue a scope when the application policy denies the actor", async () => {
    const authority = createTenantScopeAuthority({
      id: "accounts.tenant-scope",
      authorize: ({ actor: candidate, tenantId }) =>
        candidate.permissions?.has(`tenant:${tenantId}`) ?? false,
    });

    await expect(
      authority.issue({ tenantId: "tenant-b", requestId: "request-2", actor }),
    ).rejects.toMatchObject({
      code: "SHIP_TENANT_SCOPE_FORBIDDEN",
      authorityId: "accounts.tenant-scope",
      tenantId: "tenant-b",
    });
  });

  it("denies a system actor without membership exactly like a human", async () => {
    const memberships = new Map([["user-1", new Set(["tenant-a"])]]);
    const authorize = vi.fn(
      ({ actor, tenantId }: { actor: { id: string }; tenantId: string | number }) =>
        memberships.get(actor.id)?.has(String(tenantId)) ?? false,
    );
    const authority = createTenantScopeAuthority({ id: "accounts.tenant-scope", authorize });
    const system = systemActor({ id: "outbox.dispatcher", permissions: ["ship.outbox:manage"] });

    await expect(
      authority.issue({ tenantId: "tenant-a", requestId: "request-1", actor: system }),
    ).rejects.toMatchObject({ code: "SHIP_TENANT_SCOPE_FORBIDDEN" });
    await expect(
      authority.issue({
        tenantId: "tenant-a",
        requestId: "request-1",
        actor: operationActor({ id: "stranger" }),
      }),
    ).rejects.toMatchObject({ code: "SHIP_TENANT_SCOPE_FORBIDDEN" });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.calls[0]![0].actor).toMatchObject({ kind: "system" });
  });

  it("wraps a failed authorization dependency", async () => {
    const cause = new Error("membership store offline");
    const authority = createTenantScopeAuthority({
      id: "accounts.tenant-scope",
      authorize: () => {
        throw cause;
      },
    });

    await expect(
      authority.issue({ tenantId: "tenant-a", requestId: "request-3", actor }),
    ).rejects.toMatchObject({
      code: "SHIP_TENANT_SCOPE_AUTHORIZATION_FAILED",
      authorityId: "accounts.tenant-scope",
      tenantId: "tenant-a",
      cause,
    });
  });

  it("rejects a non-boolean authorization result", async () => {
    const authority = createTenantScopeAuthority({
      id: "accounts.tenant-scope",
      authorize: (() => "yes") as never,
    });

    await expect(
      authority.issue({ tenantId: "tenant-a", requestId: "request-4", actor }),
    ).rejects.toMatchObject({ code: "SHIP_TENANT_SCOPE_AUTHORIZATION_FAILED" });
  });
});

describe("tenant bypass capabilities", () => {
  it("records immutable evidence when a bypass is issued and consumed", () => {
    const audit = vi.fn();
    const authority = createTenantBypassAuthority({ id: "platform.tenant-bypass", audit });
    const bypass = authority.issue({
      requestId: "request-2",
      actor,
      reason: "reconcile duplicate accounts",
    });

    recordTenantBypassUse(bypass, "accounts.repository");

    expect(authority).toMatchObject({
      kind: "ship.tenant-bypass-authority",
      id: "platform.tenant-bypass",
    });
    expect(bypass).toMatchObject({
      kind: "ship.tenant-bypass",
      authorityId: "platform.tenant-bypass",
      requestId: "request-2",
      actorId: "actor-1",
      reason: "reconcile duplicate accounts",
    });
    expect(isTenantBypass(bypass)).toBe(true);
    expect(isTenantBypass({ ...bypass })).toBe(false);
    expect(audit.mock.calls.map(([event]) => event)).toEqual([
      {
        kind: "ship.tenant-bypass-audit",
        action: "issued",
        authorityId: "platform.tenant-bypass",
        requestId: "request-2",
        actorId: "actor-1",
        reason: "reconcile duplicate accounts",
      },
      {
        kind: "ship.tenant-bypass-audit",
        action: "repository-accessed",
        authorityId: "platform.tenant-bypass",
        repositoryId: "accounts.repository",
        requestId: "request-2",
        actorId: "actor-1",
        reason: "reconcile duplicate accounts",
      },
    ]);
    expect(audit.mock.calls.every(([event]) => Object.isFrozen(event))).toBe(true);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(bypass)).toBe(true);
  });

  it.each([
    [null, "SHIP_TENANT_BYPASS_AUTHORITY_INVALID", undefined],
    [{ id: "Bad ID", audit: () => undefined }, "SHIP_TENANT_BYPASS_AUTHORITY_INVALID", "id"],
    [{ id: "platform.bypass", audit: true }, "SHIP_TENANT_BYPASS_AUTHORITY_INVALID", "audit"],
  ])("rejects an invalid bypass authority %#", (definition, code, field) => {
    expect(() => createTenantBypassAuthority(definition as never)).toThrowError(
      expect.objectContaining({ code, field }),
    );
  });

  it.each([
    [null, undefined],
    [{ requestId: "", actor, reason: "support" }, "requestId"],
    [{ requestId: "request", actor: null, reason: "support" }, "actor"],
    [{ requestId: "request", actor, reason: " " }, "reason"],
  ])("rejects an invalid bypass request %#", (request, field) => {
    const authority = createTenantBypassAuthority({
      id: "platform.bypass",
      audit: () => undefined,
    });
    expect(() => authority.issue(request as never)).toThrowError(
      expect.objectContaining({ code: "SHIP_TENANT_BYPASS_REQUEST_INVALID", field }),
    );
  });

  it("never lets a provider actor obtain privileged access without the bypass authority", () => {
    const provider = providerActor({ id: "evt_1", provider: "stripe" });
    const forged = {
      kind: "ship.tenant-bypass",
      authorityId: "accounts.bypass",
      requestId: "request-1",
      actorId: provider.id,
      reason: "webhook replay",
    };

    expect(isTenantBypass(forged)).toBe(false);
    expect(() => recordTenantBypassUse(forged, "accounts.repository")).toThrow(
      expect.objectContaining({ code: "SHIP_TENANT_BYPASS_REQUIRED" }),
    );

    const audit = vi.fn();
    const authority = createTenantBypassAuthority({ id: "accounts.bypass", audit });
    const bypass = authority.issue({
      requestId: "request-1",
      actor: provider,
      reason: "webhook replay",
    });
    expect(isTenantBypass(bypass)).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "issued", actorId: "evt_1" }),
    );
  });

  it("fails closed when bypass issuance cannot be audited", () => {
    const cause = new Error("audit offline");
    const authority = createTenantBypassAuthority({
      id: "platform.bypass",
      audit: () => {
        throw cause;
      },
    });

    expect(() => authority.issue({ requestId: "request", actor, reason: "support" })).toThrowError(
      expect.objectContaining({
        code: "SHIP_TENANT_BYPASS_AUDIT_FAILED",
        authorityId: "platform.bypass",
        cause,
      }),
    );
  });

  it("rejects asynchronous audit sinks before issuing a capability", () => {
    const authority = createTenantBypassAuthority({
      id: "platform.bypass",
      audit: (async () => undefined) as () => void,
    });

    expect(() => authority.issue({ requestId: "request", actor, reason: "support" })).toThrowError(
      expect.objectContaining({ code: "SHIP_TENANT_BYPASS_AUDIT_FAILED" }),
    );
  });

  it("rejects forged bypasses and invalid repository evidence", () => {
    expect(() =>
      recordTenantBypassUse(
        {
          kind: "ship.tenant-bypass",
          authorityId: "platform.bypass",
          requestId: "request",
          actorId: "actor-1",
          reason: "support",
        },
        "accounts.repository",
      ),
    ).toThrowError(expect.objectContaining({ code: "SHIP_TENANT_BYPASS_REQUIRED" }));

    const authority = createTenantBypassAuthority({
      id: "platform.bypass",
      audit: () => undefined,
    });
    const bypass = authority.issue({ requestId: "request", actor, reason: "support" });
    expect(() => recordTenantBypassUse(bypass, "Bad Repository")).toThrowError(
      expect.objectContaining({
        code: "SHIP_TENANT_BYPASS_REQUIRED",
        field: "repositoryId",
      }),
    );
  });

  it("fails closed when repository access cannot be audited", () => {
    let fail = false;
    const authority = createTenantBypassAuthority({
      id: "platform.bypass",
      audit: () => {
        if (fail) throw new Error("audit offline");
      },
    });
    const bypass = authority.issue({ requestId: "request", actor, reason: "support" });
    fail = true;

    expect(() => recordTenantBypassUse(bypass, "accounts.repository")).toThrowError(
      expect.objectContaining({
        code: "SHIP_TENANT_BYPASS_AUDIT_FAILED",
        repositoryId: "accounts.repository",
      }),
    );
  });
});
