import { describe, expect, it, vi } from "vitest";
import { authenticatedAccess } from "./access.js";
import {
  defineActorResolver,
  humanActor,
  isActorResolution,
  isActorResolver,
  isOperationActor,
  isOperationIdentity,
  normalizeActorResolution,
  normalizeOperationActor,
  operationActor,
  operationIdentity,
  permissionSnapshot,
  providerActor,
  systemActor,
} from "./actor.js";

describe("operationActor", () => {
  it("takes an immutable permission snapshot", () => {
    const source = new Set(["fixtures:read"]);
    const actor = operationActor({ id: "actor-1", permissions: source });
    source.add("fixtures:write");

    expect(actor.permissions?.has("fixtures:read")).toBe(true);
    expect(actor.permissions?.has("fixtures:write")).toBe(false);
    expect([...actor.permissions!]).toEqual(["fixtures:read"]);
    expect(Object.isFrozen(actor)).toBe(true);
    expect(Object.isFrozen(actor.permissions)).toBe(true);
    expect(Reflect.get(actor.permissions!, "add")).toBeUndefined();
  });

  it("implements the complete ReadonlySet iteration contract", () => {
    const snapshot = permissionSnapshot(["fixtures:read", "fixtures:write"]);
    const visited: string[] = [];
    snapshot.forEach((value, duplicate, set) => {
      expect(duplicate).toBe(value);
      expect(set).toBe(snapshot);
      visited.push(value);
    });

    expect(snapshot.size).toBe(2);
    expect([...snapshot.keys()]).toEqual(visited);
    expect([...snapshot.values()]).toEqual(visited);
    expect([...snapshot.entries()]).toEqual(visited.map((value) => [value, value]));
  });

  it("rejects malformed actors and permission snapshots from untyped callers", () => {
    const create = operationActor as (definition: unknown) => unknown;
    const snapshot = permissionSnapshot as (permissions: Iterable<unknown>) => unknown;

    expect(() => create({ id: "", permissions: [] })).toThrow(TypeError);
    expect(() => snapshot(["fixtures:read", 7])).toThrow(TypeError);
    expect(isOperationActor({ id: "actor-1", permissions: ["fixtures:read"] })).toBe(false);
  });
});

describe("operationIdentity", () => {
  it("creates a frozen verified-identity reference", () => {
    const identity = operationIdentity({ provider: "firebase.id-token", subject: "uid-1" });

    expect(identity).toEqual({ provider: "firebase.id-token", subject: "uid-1" });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(isOperationIdentity(identity)).toBe(true);
  });

  it.each([
    { provider: "Firebase", subject: "uid-1" },
    { provider: "firebase", subject: "" },
  ])("rejects malformed identity %#", (identity) => {
    expect(() => operationIdentity(identity)).toThrow(TypeError);
    expect(isOperationIdentity(identity)).toBe(false);
  });
});

describe("actor resolver declarations", () => {
  it("preserves a typed resolver as an immutable structural boundary", async () => {
    const resolve = vi.fn(async () => ({
      ok: true as const,
      actor: operationActor({ id: "actor-1" }),
    }));
    const resolver = defineActorResolver<string>({ id: "auth.fixture", resolve });
    const request = {
      credential: "token",
      operation: { id: "fixtures.read", access: authenticatedAccess() },
      requestId: "request-1",
    };

    await expect(resolver.resolve(request)).resolves.toMatchObject({
      ok: true,
      actor: { id: "actor-1" },
    });
    expect(resolve).toHaveBeenCalledWith(request);
    expect(isActorResolver(resolver)).toBe(true);
    expect(Object.isFrozen(resolver)).toBe(true);
  });

  it("normalises a kind-less actor before any caller sees it, sync or async", async () => {
    const legacy = { id: "actor-1", permissions: new Set(["fixtures:read"]) };
    const request = {
      credential: "token",
      operation: { id: "fixtures.read", access: authenticatedAccess() },
      requestId: "request-1",
    };
    const asyncResolver = defineActorResolver<string>({
      id: "auth.legacy-async",
      resolve: async () => ({ ok: true, actor: legacy }),
    });
    const syncResolver = defineActorResolver<string>({
      id: "auth.legacy-sync",
      resolve: () => ({ ok: true, actor: legacy }),
    });

    for (const resolution of [
      await asyncResolver.resolve(request),
      await syncResolver.resolve(request),
    ]) {
      expect(resolution).toMatchObject({ ok: true, actor: { id: "actor-1", kind: "human" } });
    }
    // An invalid result is passed through for the request boundary to reject, as before.
    const broken = defineActorResolver<string>({
      id: "auth.broken",
      resolve: () => ({ ok: "yes" }) as never,
    });
    expect(await broken.resolve(request)).toEqual({ ok: "yes" });
  });

  it.each([
    [{ ok: true }, true],
    [
      {
        ok: true,
        actor: { id: "actor-1", kind: "human", permissions: new Set(["fixtures:read"]) },
      },
      true,
    ],
    // ship-core 1.0 actors carry no kind; they are human actors, not invalid results.
    [{ ok: true, actor: { id: "actor-1", permissions: new Set(["fixtures:read"]) } }, true],
    [{ ok: true, actor: { id: "actor-1", provider: "stripe" } }, false],
    [{ ok: true, actor: { id: "actor-1", onBehalfOf: { actorId: "user-2" } } }, false],
    [{ ok: true, actor: { id: "actor-1", permissions: ["fixtures:read"] } }, false],
    [{ ok: true, actor: { id: "job-1", kind: "system" } }, true],
    [{ ok: true, actor: { id: "hook-1", kind: "provider", provider: "stripe" } }, true],
    [{ ok: true, actor: { id: "hook-1", kind: "provider" } }, false],
    [{ ok: true, identity: { provider: "firebase", subject: "uid-1" } }, true],
    [{ ok: true, identity: { provider: "Firebase", subject: "uid-1" } }, false],
    [{ ok: false, reason: "invalid-credential" }, true],
    [{ ok: false, reason: "forbidden" }, true],
    [{ ok: false, reason: "unavailable" }, true],
    [{ ok: false, reason: "unknown" }, false],
    [{ ok: true, actor: { id: "" } }, false],
    [null, false],
  ])("validates resolution shape %#", (resolution, expected) => {
    expect(isActorResolution(resolution)).toBe(expected);
  });

  it("normalises a kind-less (ship-core 1.0) actor to a frozen human actor", () => {
    const legacy = { id: "actor-1", permissions: new Set(["fixtures:read"]) };
    const resolution = normalizeActorResolution({
      ok: true,
      actor: legacy,
      identity: { provider: "firebase", subject: "uid-1" },
    });

    expect(resolution).toMatchObject({
      ok: true,
      actor: { id: "actor-1", kind: "human" },
      identity: { provider: "firebase", subject: "uid-1" },
    });
    const actor = resolution?.ok ? resolution.actor : undefined;
    expect(actor && isOperationActor(actor)).toBe(true);
    expect(Object.isFrozen(actor)).toBe(true);
    expect(actor?.permissions?.has("fixtures:read")).toBe(true);
  });

  it("keeps valid actors and failures unchanged and rejects what cannot be normalised", () => {
    const system = systemActor({ id: "job-1" });

    expect(normalizeOperationActor(system)).toBe(system);
    expect(normalizeOperationActor({ id: "user-1" })).toEqual({ id: "user-1", kind: "human" });
    expect(normalizeOperationActor({ id: "" })).toBeUndefined();
    expect(normalizeOperationActor({ id: "hook-1", provider: "stripe" })).toBeUndefined();
    expect(normalizeOperationActor({ id: "user-1", kind: "robot" })).toBeUndefined();
    expect(normalizeOperationActor(null)).toBeUndefined();
    expect(normalizeActorResolution({ ok: false, reason: "forbidden" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(normalizeActorResolution({ ok: true })).toEqual({ ok: true });
    expect(normalizeActorResolution({ ok: true, actor: { id: "" } })).toBeUndefined();
    expect(normalizeActorResolution({ ok: "yes" })).toBeUndefined();
  });

  it("rejects malformed resolver declarations", () => {
    const define = defineActorResolver as (resolver: unknown) => unknown;

    expect(() => define({ id: "Bad Resolver", resolve: () => ({ ok: true }) })).toThrow(TypeError);
    expect(() => define({ id: "auth.fixture" })).toThrow(TypeError);
    expect(isActorResolver({ id: "auth.fixture" })).toBe(false);
  });
});

describe("actor kinds", () => {
  it("defaults an untyped definition to a human actor", () => {
    const actor = operationActor({ id: "user-1", permissions: ["fixtures:read"] });

    expect(actor).toMatchObject({ id: "user-1", kind: "human" });
    expect(humanActor({ id: "user-2" })).toEqual({ id: "user-2", kind: "human" });
    expect(Reflect.get(actor, "provider")).toBeUndefined();
  });

  it("creates system and provider actors with separate audit attribution", () => {
    const system = systemActor({
      id: "outbox.dispatcher",
      permissions: ["ship.outbox:manage"],
      onBehalfOf: { actorId: "user-1" },
    });
    const provider = providerActor({ id: "evt_1", provider: "stripe.webhooks" });

    expect(system).toMatchObject({
      id: "outbox.dispatcher",
      kind: "system",
      onBehalfOf: { actorId: "user-1" },
    });
    expect(provider).toEqual({ id: "evt_1", kind: "provider", provider: "stripe.webhooks" });
    expect(Object.isFrozen(system)).toBe(true);
    expect(Object.isFrozen(system.onBehalfOf)).toBe(true);
    expect(isOperationActor(system)).toBe(true);
    expect(isOperationActor(provider)).toBe(true);
  });

  it.each([
    ["missing provider id", { id: "evt_1", kind: "provider" }],
    ["malformed provider id", { id: "evt_1", kind: "provider", provider: "Stripe" }],
    ["unknown kind", { id: "actor-1", kind: "robot" }],
    ["empty attribution", { id: "actor-1", kind: "system", onBehalfOf: { actorId: " " } }],
    ["non-object", null],
  ])("rejects %s", (_name, definition) => {
    const create = operationActor as (definition: unknown) => unknown;
    expect(() => create(definition)).toThrow(TypeError);
    expect(isOperationActor(definition)).toBe(false);
  });

  it("drops a provider id from non-provider definitions and rejects such raw snapshots", () => {
    const create = operationActor as (definition: unknown) => { readonly provider?: string };
    expect(create({ id: "actor-1", kind: "human", provider: "stripe" }).provider).toBeUndefined();
    expect(create({ id: "actor-1", kind: "system", provider: "stripe" }).provider).toBeUndefined();
    expect(isOperationActor({ id: "actor-1", kind: "human", provider: "stripe" })).toBe(false);
    expect(isOperationActor({ id: "actor-1", kind: "system", provider: "stripe" })).toBe(false);
  });

  it("rejects a human actor carrying attribution and validates attribution shape", () => {
    expect(
      isOperationActor({ id: "actor-1", kind: "human", onBehalfOf: { actorId: "user-2" } }),
    ).toBe(false);
    expect(isOperationActor({ id: "actor-1", kind: "system", onBehalfOf: { actorId: "" } })).toBe(
      false,
    );
    expect(isOperationActor({ id: "actor-1", kind: "system", onBehalfOf: null })).toBe(false);
  });
});
