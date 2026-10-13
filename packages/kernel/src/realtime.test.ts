import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authenticatedAccess, publicAccess } from "./access.js";
import { operationActor } from "./actor.js";
import {
  ApplicationCompilationError,
  type ApplicationDiagnosticCode,
  compileApp,
  defineApp,
} from "./application.js";
import {
  type DependencyBindings,
  dependency,
  effectDependency,
  unitOfWorkDependency,
} from "./dependency.js";
import { defineModule, InvalidModuleDefinitionError } from "./module.js";
import { defineOperation, InvalidOperationDefinitionError } from "./operation.js";
import { valueProvider } from "./provider.js";
import {
  type AnyChannel,
  type ChannelDefinitionDiagnosticCode,
  channelPublisherProvider,
  channelPublisherProviders,
  channelScopeKey,
  createChannelPublisher,
  createChannelPublisherRegistry,
  createPublicationCoalescer,
  createSubscriptionAuthorizer,
  defineChannel,
  InvalidChannelDefinitionError,
  isChannel,
  isChannelPublicationToken,
  isChannelPublisher,
  isRealtimeBackend,
  isRealtimePublishBackend,
  narrowChannelPublisher,
  pagePresenceMembers,
  REALTIME_PRESENCE_DEFAULT_LIMIT,
  REALTIME_PRESENCE_MAX_LIMIT,
  RealtimeError,
  type RealtimePublishBackend,
  realtimeHandshakeOperation,
  validateChannelPayload,
} from "./realtime.js";
import { createTenantScopeAuthority, type TenantScope } from "./tenant.js";

const payload = z.object({ status: z.string(), version: z.number().int() });

function fakeBackend(): RealtimePublishBackend & {
  readonly published: { channelId: string; scopeKey: string; payload: unknown }[];
} {
  const published: { channelId: string; scopeKey: string; payload: unknown }[] = [];
  return {
    kind: "ship.realtime-backend",
    id: "fake",
    published,
    publish: async (channel, scopeKey, value) => {
      published.push({ channelId: channel.id, scopeKey, payload: value });
    },
    health: async () => ({ ok: true, adapter: "fake" }),
    close: async () => undefined,
  };
}

function actorChannel(id = "activity.feed") {
  return defineChannel({ id, scope: "actor", payload });
}

function operation(
  id: string,
  options: {
    readonly dependencies?: DependencyBindings;
    readonly publishes?: readonly AnyChannel[];
    readonly transaction?: "none" | "read" | "write";
  } = {},
) {
  return defineOperation({
    id,
    input: {},
    output: { 200: z.object({ ok: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: options.transaction ?? "none",
    dependencies: options.dependencies ?? {},
    ...(options.publishes ? { publishes: options.publishes } : {}),
    handler: () => ({ ok: true as const }),
  });
}

function expectChannelFailure(
  definition: unknown,
  code: ChannelDefinitionDiagnosticCode,
  field?: string,
) {
  let caught: unknown;
  try {
    defineChannel(definition as never);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidChannelDefinitionError);
  expect((caught as InvalidChannelDefinitionError).code).toBe(code);
  if (field) expect((caught as InvalidChannelDefinitionError).field).toBe(field);
}

function diagnosticCodes(modules: Parameters<typeof compileApp>[0]["modules"]) {
  let caught: unknown;
  try {
    compileApp({ id: "realtime-fixture", modules });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApplicationCompilationError);
  return (caught as ApplicationCompilationError).diagnostics.map((item) => item.code);
}

describe("defineChannel", () => {
  it("freezes a channel with defaults and a publication effect token", () => {
    const channel = defineChannel({ id: "activity.feed", scope: "actor", payload });

    expect(channel).toMatchObject({
      kind: "ship.channel",
      id: "activity.feed",
      scope: "actor",
      presence: false,
      slowSubscriber: "drop-oldest",
    });
    expect(channel.publication).toEqual({
      kind: "ship.dependency",
      id: "activity.feed.publish",
      scope: "effect",
      delivery: "immediate",
      channelId: "activity.feed",
    });
    expect(Object.isFrozen(channel)).toBe(true);
    expect(Object.isFrozen(channel.publication)).toBe(true);
    expect(isChannel(channel)).toBe(true);
    expect(isChannelPublicationToken(channel.publication)).toBe(true);
    expect(isChannelPublicationToken(effectDependency("x.y", { delivery: "immediate" }))).toBe(
      false,
    );
    expect(isChannel({ ...channel, publication: dependency("activity.feed.publish") })).toBe(false);
  });

  it("copies coalesce, presence, slow-subscriber, and authorization declarations", () => {
    const authorizeSubscription = async () => true;
    const key = (value: { status: string }) => value.status;
    const channel = defineChannel({
      id: "board.updates",
      scope: "resource",
      payload,
      coalesce: { windowMs: 50, key },
      presence: true,
      slowSubscriber: "disconnect",
      authorizeSubscription,
    });

    expect(channel.coalesce).toEqual({ windowMs: 50, key });
    expect(channel.presence).toBe(true);
    expect(channel.slowSubscriber).toBe("disconnect");
    expect(channel.authorizeSubscription).toBe(authorizeSubscription);
  });

  it("rejects malformed definitions with stable codes", () => {
    expectChannelFailure(null, "SHIP_CHANNEL_DEFINITION_INVALID");
    expectChannelFailure({ id: "Feed", scope: "actor", payload }, "SHIP_CHANNEL_ID_INVALID", "id");
    expectChannelFailure({ id: "feed", scope: "actor", payload }, "SHIP_CHANNEL_ID_INVALID");
    expectChannelFailure(
      { id: "activity.feed", scope: "global", payload },
      "SHIP_CHANNEL_SCOPE_INVALID",
      "scope",
    );
    expectChannelFailure(
      { id: "activity.feed", scope: "actor", payload: {} },
      "SHIP_CHANNEL_PAYLOAD_INVALID",
      "payload",
    );
    for (const coalesce of [
      null,
      { windowMs: 0, key: () => "" },
      { windowMs: 1.5, key: () => "" },
      { windowMs: 60_001, key: () => "" },
      { windowMs: 10 },
    ]) {
      expectChannelFailure(
        { id: "activity.feed", scope: "actor", payload, coalesce },
        "SHIP_CHANNEL_COALESCE_INVALID",
        "coalesce",
      );
    }
    expectChannelFailure(
      { id: "activity.feed", scope: "actor", payload, presence: "yes" },
      "SHIP_CHANNEL_PRESENCE_INVALID",
      "presence",
    );
    expectChannelFailure(
      { id: "activity.feed", scope: "actor", payload, slowSubscriber: "buffer" },
      "SHIP_CHANNEL_SLOW_SUBSCRIBER_INVALID",
      "slowSubscriber",
    );
    expectChannelFailure(
      { id: "activity.feed", scope: "actor", payload, authorizeSubscription: true },
      "SHIP_CHANNEL_AUTHORIZATION_INVALID",
      "authorizeSubscription",
    );
    expectChannelFailure(
      { id: "board.updates", scope: "resource", payload },
      "SHIP_CHANNEL_AUTHORIZATION_REQUIRED",
      "authorizeSubscription",
    );
  });
});

describe("channel publisher", () => {
  it("validates scope keys and payloads before handing off to the backend", async () => {
    const backend = fakeBackend();
    const channel = actorChannel();
    const publisher = createChannelPublisher(channel, backend);

    await publisher.publish("actor-1", { status: "open", version: 1 });
    expect(backend.published).toEqual([
      { channelId: "activity.feed", scopeKey: "actor-1", payload: { status: "open", version: 1 } },
    ]);
    expect(publisher.channel).toBe(channel);
    expect(Object.isFrozen(publisher)).toBe(true);

    await expect(
      publisher.publish("actor-1", { status: "open", version: 1.5 }),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_PAYLOAD_INVALID", channelId: "activity.feed" });
    await expect(
      publisher.publish("bad key!", { status: "open", version: 1 }),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_SCOPE_KEY_INVALID" });
    await expect(
      publisher.publish(123 as unknown as string, { status: "open", version: 1 }),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_SCOPE_KEY_INVALID" });
    expect(backend.published).toHaveLength(1);
  });

  it("requires an authentic tenant scope for tenant channels", async () => {
    const backend = fakeBackend();
    const channel = defineChannel({ id: "tenant.updates", scope: "tenant", payload });
    const publisher = createChannelPublisher(channel, backend);
    const authority = createTenantScopeAuthority({ id: "tenants", authorize: () => true });
    const scope = await authority.issue({
      tenantId: 42,
      requestId: "r1",
      actor: operationActor({ id: "a" }),
    });

    await publisher.publish(scope, { status: "open", version: 1 });
    expect(backend.published[0]?.scopeKey).toBe("42");
    await expect(
      publisher.publish({ tenantId: 42 } as never, { status: "open", version: 1 }),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_TENANT_SCOPE_REQUIRED" });
    expect(channelScopeKey(actorChannel(), "actor-1")).toBe("actor-1");
  });

  it("rejects invalid channels and backends at construction", () => {
    expect(() => createChannelPublisher({} as never, fakeBackend())).toThrow(RealtimeError);
    expect(() => createChannelPublisher(actorChannel(), {} as never)).toThrowError(
      expect.objectContaining({ code: "SHIP_REALTIME_BACKEND_INVALID" }),
    );
    expect(isRealtimePublishBackend(fakeBackend())).toBe(true);
    expect(isRealtimeBackend(fakeBackend())).toBe(false);
    expect(
      isRealtimeBackend({
        ...fakeBackend(),
        subscribe: () => undefined,
        unsubscribe: () => undefined,
        disconnect: () => undefined,
      }),
    ).toBe(true);
  });

  it("exposes a validated payload helper", async () => {
    await expect(
      validateChannelPayload(actorChannel(), { status: "x", version: 2 }),
    ).resolves.toEqual({ status: "x", version: 2 });
    await expect(validateChannelPayload(actorChannel(), { status: 1 })).rejects.toMatchObject({
      issues: expect.any(Array),
    });
  });

  it("binds publication providers to the channel token", () => {
    const backend = fakeBackend();
    const channel = actorChannel();
    const provider = channelPublisherProvider(channel, backend);
    expect(provider.token).toBe(channel.publication);
    expect(provider.lifetime).toBe("singleton");
    const providers = channelPublisherProviders(backend, [channel, actorChannel("other.feed")]);
    expect(providers.map((item) => item.token.id)).toEqual([
      "activity.feed.publish",
      "other.feed.publish",
    ]);
  });
});

describe("channel publisher registry", () => {
  const room = defineChannel({ id: "activity.room", scope: "tenant", payload });
  const tenants = createTenantScopeAuthority({
    id: "tenants",
    authorize: ({ actor, tenantId }) => actor.permissions?.has(`tenant:${tenantId}`) ?? false,
  });

  it("derives one publisher per declared channel and publishes by id with validation", async () => {
    const backend = fakeBackend();
    const feed = actorChannel();
    const registry = createChannelPublisherRegistry([room, feed], backend);
    expect(registry.kind).toBe("ship.channel-publisher-registry");
    expect(registry.channels.map((channel) => channel.id)).toEqual([
      "activity.feed",
      "activity.room",
    ]);
    expect(registry.providers.map((provider) => provider.token.id)).toEqual([
      "activity.feed.publish",
      "activity.room.publish",
    ]);
    expect(registry.has("activity.feed")).toBe(true);
    expect(registry.has("activity.other")).toBe(false);
    expect(registry.get("activity.other")).toBeUndefined();
    const erased = registry.get("activity.feed");
    expect(isChannelPublisher(erased)).toBe(true);
    expect(erased?.channel).toBe(feed);

    await registry.publish("activity.feed", "actor-1", { status: "open", version: 1 });
    const scope = await tenants.issue({
      tenantId: "acme",
      requestId: "r1",
      actor: operationActor({ id: "actor-1", permissions: ["tenant:acme"] }),
    });
    await registry.publish("activity.room", scope, { status: "closed", version: 2 });
    expect(backend.published).toEqual([
      { channelId: "activity.feed", scopeKey: "actor-1", payload: { status: "open", version: 1 } },
      { channelId: "activity.room", scopeKey: "acme", payload: { status: "closed", version: 2 } },
    ]);

    await expect(registry.publish("activity.feed", "actor-1", { status: 1 })).rejects.toMatchObject(
      { code: "SHIP_REALTIME_PAYLOAD_INVALID", channelId: "activity.feed" },
    );
    await expect(
      registry.publish("activity.room", "acme", { status: "open", version: 1 }),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_TENANT_SCOPE_REQUIRED" });
    await expect(
      registry.publish("activity.other", "actor-1", { status: "open", version: 1 }),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_CHANNEL_INVALID", channelId: "activity.other" });
    expect(backend.published).toHaveLength(2);
  });

  it("reads channels from anything that composes modules and rejects duplicates", () => {
    const backend = fakeBackend();
    const feed = actorChannel();
    const modules = [
      defineModule({
        id: "activity",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        channels: [feed],
      }),
      defineModule({
        id: "rooms",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        channels: [room],
      }),
    ];
    const registry = createChannelPublisherRegistry({ modules }, backend);
    expect(registry.channels).toEqual([feed, room]);
    expect(() => createChannelPublisherRegistry([feed, actorChannel()], backend)).toThrow(
      RealtimeError,
    );
    expect(() => createChannelPublisherRegistry([feed, feed], backend)).toThrow(
      expect.objectContaining({ code: "SHIP_REALTIME_CHANNEL_INVALID" }),
    );
    expect(() => createChannelPublisherRegistry([feed], {} as never)).toThrow(RealtimeError);
  });

  it("narrows an erased publisher back to its channel and refuses foreign channels", async () => {
    const backend = fakeBackend();
    const feed = actorChannel();
    const registry = createChannelPublisherRegistry([feed, room], backend);
    const typed = registry.for(feed);
    await typed.publish("actor-1", { status: "open", version: 1 });
    expect(backend.published).toHaveLength(1);
    const erased = registry.get("activity.feed") as NonNullable<ReturnType<typeof registry.get>>;
    expect(narrowChannelPublisher(erased, feed)).toBe(erased);
    // Same id, different declaration: still refused.
    expect(() => narrowChannelPublisher(erased, actorChannel())).toThrow(
      expect.objectContaining({
        code: "SHIP_REALTIME_CHANNEL_INVALID",
        channelId: "activity.feed",
      }),
    );
    expect(() => narrowChannelPublisher(erased, room)).toThrow(RealtimeError);
    expect(() => registry.for(actorChannel("activity.other"))).toThrow(
      expect.objectContaining({
        code: "SHIP_REALTIME_CHANNEL_INVALID",
        channelId: "activity.other",
      }),
    );
    expect(() => registry.for({} as never)).toThrow(RealtimeError);
    expect(() => narrowChannelPublisher({} as never, feed)).toThrow(
      expect.objectContaining({ code: "SHIP_REALTIME_CHANNEL_INVALID" }),
    );
    expect(isChannelPublisher({ kind: "ship.channel-publisher" })).toBe(false);
    expect(isChannelPublisher(createChannelPublisher(feed, backend))).toBe(true);
    // Type-level: a typed publisher is an erased publisher; the erased publish accepts either scope kind.
    const widened: Parameters<typeof narrowChannelPublisher>[0] = typed;
    await widened.publish({ tenantId: "x" } as unknown as TenantScope, {}).catch(() => undefined);
    expect(backend.published).toHaveLength(1);
  });
});

describe("createSubscriptionAuthorizer", () => {
  const actor = operationActor({ id: "actor-1", permissions: ["tenant:acme"] });
  const request = { requestId: "req-1" };

  it("admits only the actor's own key on actor channels", async () => {
    const authorize = createSubscriptionAuthorizer();
    const channel = actorChannel();
    await expect(authorize({ channel, scopeKey: "actor-1", actor, ...request })).resolves.toEqual({
      ok: true,
    });
    await expect(authorize({ channel, scopeKey: "actor-2", actor, ...request })).resolves.toEqual({
      ok: false,
      reason: "scope-invalid",
    });
    await expect(authorize({ channel, scopeKey: "actor-1", ...request })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    await expect(authorize({ channel, scopeKey: "bad key", actor, ...request })).resolves.toEqual({
      ok: false,
      reason: "scope-invalid",
    });
  });

  it("issues tenant scopes through the application authority", async () => {
    const channel = defineChannel({ id: "tenant.updates", scope: "tenant", payload });
    const tenantScopes = createTenantScopeAuthority({
      id: "tenants",
      authorize: ({ actor: candidate, tenantId }) => {
        if (tenantId === "boom") throw new Error("directory down");
        return candidate.permissions?.has(`tenant:${tenantId}`) ?? false;
      },
    });
    const authorize = createSubscriptionAuthorizer({ tenantScopes });
    await expect(authorize({ channel, scopeKey: "acme", actor, ...request })).resolves.toEqual({
      ok: true,
    });
    await expect(authorize({ channel, scopeKey: "other", actor, ...request })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    await expect(authorize({ channel, scopeKey: "boom", actor, ...request })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(
      createSubscriptionAuthorizer()({ channel, scopeKey: "acme", actor, ...request }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("defers resource channels to the declared policy and fails closed", async () => {
    const policy = vi.fn(async (_actor: unknown, ref: string) => {
      if (ref === "throws") throw new Error("nope");
      return ref === "board-1";
    });
    const channel = defineChannel({
      id: "board.updates",
      scope: "resource",
      payload,
      authorizeSubscription: policy,
    });
    const authorize = createSubscriptionAuthorizer();
    await expect(authorize({ channel, scopeKey: "board-1", actor, ...request })).resolves.toEqual({
      ok: true,
    });
    expect(policy).toHaveBeenCalledWith(actor, "board-1", {
      requestId: "req-1",
      signal: undefined,
    });
    await expect(authorize({ channel, scopeKey: "board-2", actor, ...request })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    await expect(authorize({ channel, scopeKey: "throws", actor, ...request })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    const truthy = defineChannel({
      id: "board.other",
      scope: "resource",
      payload,
      authorizeSubscription: (() => "yes") as never,
    });
    await expect(authorize({ channel: truthy, scopeKey: "x", actor, ...request })).resolves.toEqual(
      {
        ok: false,
        reason: "forbidden",
      },
    );
  });

  it("applies an optional policy on actor channels too", async () => {
    const channel = defineChannel({
      id: "activity.feed",
      scope: "actor",
      payload,
      authorizeSubscription: () => false,
    });
    await expect(
      createSubscriptionAuthorizer()({ channel, scopeKey: "actor-1", actor, ...request }),
    ).resolves.toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("pagePresenceMembers", () => {
  it("sorts and dedupes members, bounds the page and reports the whole count", () => {
    expect(pagePresenceMembers(["c", "a", "b", "a"])).toEqual({
      ok: true,
      snapshot: { count: 3, actorIds: ["a", "b", "c"] },
    });
    expect(pagePresenceMembers(["c", "a", "b"], { limit: 2 })).toEqual({
      ok: true,
      snapshot: { count: 3, actorIds: ["a", "b"], nextCursor: "b" },
    });
    expect(pagePresenceMembers(["c", "a", "b"], { limit: 2, cursor: "b" })).toEqual({
      ok: true,
      snapshot: { count: 3, actorIds: ["c"] },
    });
    // A cursor whose member left still resumes after it.
    expect(pagePresenceMembers(["c", "a"], { limit: 2, cursor: "b" })).toEqual({
      ok: true,
      snapshot: { count: 2, actorIds: ["c"] },
    });
    expect(pagePresenceMembers(["a"], { cursor: "z" })).toEqual({
      ok: true,
      snapshot: { count: 1, actorIds: [] },
    });
    expect(pagePresenceMembers([])).toEqual({ ok: true, snapshot: { count: 0, actorIds: [] } });
  });

  it("clamps oversized limits and rejects malformed paging", () => {
    const many = Array.from({ length: REALTIME_PRESENCE_MAX_LIMIT + 5 }, (_, index) =>
      String(index).padStart(5, "0"),
    );
    const page = pagePresenceMembers(many, { limit: REALTIME_PRESENCE_MAX_LIMIT * 10 });
    expect(page.ok && page.snapshot.actorIds.length).toBe(REALTIME_PRESENCE_MAX_LIMIT);
    expect(page.ok && page.snapshot.nextCursor).toBe(many[REALTIME_PRESENCE_MAX_LIMIT - 1]);
    const unpaged = pagePresenceMembers(many);
    expect(unpaged.ok && unpaged.snapshot.actorIds.length).toBe(REALTIME_PRESENCE_DEFAULT_LIMIT);
    expect(unpaged.ok && unpaged.snapshot.count).toBe(many.length);
    for (const limit of [0, -1, 1.5, Number.NaN, "10" as unknown as number]) {
      expect(pagePresenceMembers(many, { limit })).toEqual({ ok: false, reason: "page-invalid" });
    }
    expect(pagePresenceMembers(many, { cursor: 5 as unknown as string })).toEqual({
      ok: false,
      reason: "page-invalid",
    });
  });
});

describe("realtimeHandshakeOperation", () => {
  it("defaults to authenticated access and validates overrides", () => {
    expect(realtimeHandshakeOperation()).toEqual({
      id: "realtime.connect",
      access: authenticatedAccess(),
    });
    expect(realtimeHandshakeOperation(publicAccess()).access.kind).toBe("public");
    expect(() => realtimeHandshakeOperation({ kind: "nope" } as never)).toThrow(TypeError);
  });
});

describe("createPublicationCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes through when the channel declares no window", () => {
    const flush = vi.fn();
    const coalescer = createPublicationCoalescer(actorChannel());
    expect(coalescer.push("a", { n: 1 }, flush)).toBe(false);
    expect(flush).toHaveBeenCalledWith({ n: 1 });
    coalescer.drain();
  });

  it("collapses publications per scope and key inside the window", () => {
    const channel = defineChannel({
      id: "board.updates",
      scope: "actor",
      payload: z.object({ id: z.string(), n: z.number() }),
      coalesce: { windowMs: 100, key: (value) => value.id },
    });
    const flush = vi.fn();
    const coalescer = createPublicationCoalescer(channel);
    expect(coalescer.push("a", { id: "x", n: 1 }, flush)).toBe(false);
    expect(coalescer.push("a", { id: "x", n: 2 }, flush)).toBe(true);
    expect(coalescer.push("a", { id: "y", n: 3 }, flush)).toBe(false);
    expect(coalescer.push("b", { id: "x", n: 4 }, flush)).toBe(false);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([
      { id: "x", n: 2 },
      { id: "y", n: 3 },
      { id: "x", n: 4 },
    ]);
    expect(coalescer.push("a", { id: "x", n: 5 }, flush)).toBe(false);
    coalescer.drain();
    expect(flush).toHaveBeenLastCalledWith({ id: "x", n: 5 });
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(4);
  });
});

describe("operation and module declarations", () => {
  it("freezes publishes and rejects invalid or duplicate channels", () => {
    const channel = actorChannel();
    const op = operation("activity.touch", {
      dependencies: { feed: channel.publication },
      publishes: [channel],
    });
    expect(op.publishes).toEqual([channel]);
    expect(Object.isFrozen(op.publishes)).toBe(true);
    expect(operation("activity.plain").publishes).toEqual([]);

    expect(() => operation("activity.touch", { publishes: [{} as never] })).toThrowError(
      expect.objectContaining({ code: "SHIP_OPERATION_PUBLISH_INVALID" }),
    );
    expect(() => operation("activity.touch", { publishes: [channel, channel] })).toThrowError(
      expect.objectContaining({ code: "SHIP_OPERATION_PUBLISH_DUPLICATE" }),
    );
    let caught: unknown;
    try {
      defineOperation({
        id: "activity.touch",
        input: {},
        output: { 200: z.object({ ok: z.literal(true) }) },
        successStatus: 200,
        errors: [],
        access: publicAccess(),
        transaction: "none",
        dependencies: { feed: channel.publication },
        effects: [channel.publication],
        handler: () => ({ ok: true as const }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidOperationDefinitionError);
    expect((caught as InvalidOperationDefinitionError).code).toBe("SHIP_OPERATION_EFFECT_INVALID");
  });

  it("validates module channel lists", () => {
    const channel = actorChannel();
    const module = defineModule({
      id: "activity",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      channels: [channel],
    });
    expect(module.channels).toEqual([channel]);
    expect(
      defineModule({ id: "activity", operations: [], providers: [], imports: [], exports: [] })
        .channels,
    ).toEqual([]);
    for (const [channels, code] of [
      [[{}], "SHIP_MODULE_CHANNEL_INVALID"],
      [[channel, actorChannel()], "SHIP_MODULE_CHANNEL_DUPLICATE"],
    ] as const) {
      let caught: unknown;
      try {
        defineModule({
          id: "activity",
          operations: [],
          providers: [],
          imports: [],
          exports: [],
          channels: channels as never,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidModuleDefinitionError);
      expect((caught as InvalidModuleDefinitionError).code).toBe(code);
    }
  });
});

describe("application compilation", () => {
  const backend = fakeBackend();

  it("projects channels, publishers, and operation publications into the graph", () => {
    const channel = defineChannel({
      id: "activity.feed",
      scope: "actor",
      payload,
      presence: true,
      coalesce: { windowMs: 25, key: (value) => value.status },
    });
    const touch = operation("activity.touch", {
      dependencies: { feed: channel.publication },
      publishes: [channel],
    });
    const app = defineApp({
      id: "realtime-fixture",
      modules: [
        defineModule({
          id: "activity",
          operations: [touch],
          providers: [channelPublisherProvider(channel, backend)],
          imports: [],
          exports: [],
          channels: [channel],
        }),
      ],
    });

    expect(app.graph.channels).toEqual([
      {
        id: "activity.feed",
        moduleId: "activity",
        scope: "actor",
        payload: { vendor: "zod", projectable: true },
        presence: true,
        coalesce: { windowMs: 25 },
        slowSubscriber: "drop-oldest",
        publishers: ["activity.touch"],
      },
    ]);
    expect(app.graph.modules[0]?.channels).toEqual(["activity.feed"]);
    expect(app.graph.operations[0]?.publishes).toEqual(["activity.feed"]);
    expect(app.graph.operations[0]?.effects).toEqual([]);
    expect(app.graph.providers[0]).toMatchObject({
      id: "activity.feed.publish",
      scope: "effect",
      delivery: "immediate",
    });
    const serialized = JSON.stringify(app.graph);
    expect(serialized).not.toContain("authorizeSubscription");
    expect(serialized).not.toContain("~standard");
  });

  it("warns when a channel payload carries no client-manifest projection", () => {
    const opaque = defineChannel({
      id: "activity.opaque",
      scope: "actor",
      payload: {
        "~standard": {
          version: 1,
          vendor: "fixture",
          validate: (value: unknown) => ({ value: value as { readonly n: number } }),
        },
      },
    });
    const app = defineApp({
      id: "realtime-fixture",
      modules: [
        defineModule({
          id: "activity",
          operations: [],
          providers: [],
          imports: [],
          exports: [],
          channels: [opaque, actorChannel()],
        }),
      ],
    });
    expect(app.graph.channels.map((node) => node.payload)).toEqual([
      { vendor: "zod", projectable: true },
      { vendor: "fixture", projectable: false },
    ]);
    expect(app.diagnostics).toEqual([
      expect.objectContaining({
        code: "SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE",
        severity: "warning",
        moduleId: "activity",
        providerId: "activity.opaque.publish",
        hint: expect.stringContaining("contractSchema()"),
      }),
    ]);
  });

  it("allows cross-module publication through imports", () => {
    const channel = actorChannel();
    const owner = defineModule({
      id: "activity",
      operations: [],
      providers: [channelPublisherProvider(channel, backend)],
      imports: [],
      exports: [channel.publication],
      channels: [channel],
    });
    const publisher = defineModule({
      id: "reports",
      operations: [
        operation("reports.touch", {
          dependencies: { feed: channel.publication },
          publishes: [channel],
        }),
      ],
      providers: [],
      imports: ["activity"],
      exports: [],
    });
    expect(() => defineApp({ id: "realtime-fixture", modules: [owner, publisher] })).not.toThrow();
    expect(diagnosticCodes([owner, defineModule({ ...publisher, imports: [] })])).toEqual<
      ApplicationDiagnosticCode[]
    >(["SHIP_CHANNEL_IMPORT_REQUIRED", "SHIP_MODULE_IMPORT_REQUIRED"]);
  });

  // The positive transactional path (a write operation recording a publication
  // intent that the framework dispatcher publishes after commit) is covered by
  // realtime-publication.test.ts; this test pins the remaining diagnostics.
  it("reports undeclared, unbound, duplicate, read-only, and undispatched publications", () => {
    const channel = actorChannel();
    const twin = actorChannel();
    const base = {
      providers: [channelPublisherProvider(channel, backend)],
      imports: [],
      exports: [],
    };

    expect(
      diagnosticCodes([
        defineModule({
          id: "activity",
          ...base,
          operations: [
            operation("activity.touch", {
              dependencies: { feed: channel.publication },
              publishes: [channel],
            }),
          ],
        }),
      ]),
    ).toEqual(["SHIP_CHANNEL_UNDECLARED"]);

    expect(
      diagnosticCodes([
        defineModule({
          id: "activity",
          ...base,
          channels: [twin],
          operations: [
            operation("activity.touch", {
              dependencies: { feed: channel.publication },
              publishes: [channel],
            }),
          ],
        }),
      ]),
    ).toEqual(["SHIP_CHANNEL_UNDECLARED"]);

    expect(
      diagnosticCodes([
        defineModule({
          id: "activity",
          ...base,
          channels: [channel],
          operations: [operation("activity.touch", { publishes: [channel] })],
        }),
      ]),
    ).toEqual(["SHIP_OPERATION_PUBLISH_UNBOUND"]);

    expect(
      diagnosticCodes([
        defineModule({
          id: "activity",
          ...base,
          channels: [channel],
          operations: [
            operation("activity.touch", { dependencies: { feed: channel.publication } }),
          ],
        }),
      ]),
    ).toEqual(["SHIP_OPERATION_PUBLISH_UNDECLARED"]);

    expect(
      diagnosticCodes([
        defineModule({ id: "activity", ...base, channels: [channel], operations: [] }),
        defineModule({
          id: "reports",
          operations: [],
          providers: [],
          imports: [],
          exports: [],
          channels: [twin],
        }),
      ]),
    ).toEqual(["SHIP_CHANNEL_ID_DUPLICATE"]);

    const unitOfWork = unitOfWorkDependency<{ run(): void }>("database.primary");
    expect(
      diagnosticCodes([
        defineModule({
          id: "activity",
          providers: [
            channelPublisherProvider(channel, backend),
            valueProvider(unitOfWork, { run() {} }),
          ],
          imports: [],
          exports: [],
          channels: [channel],
          operations: [
            operation("activity.touch", {
              dependencies: { feed: channel.publication },
              publishes: [channel],
              transaction: "none",
            }),
            defineOperation({
              id: "activity.peek",
              input: {},
              output: { 200: z.object({ ok: z.literal(true) }) },
              successStatus: 200,
              errors: [],
              access: publicAccess(),
              transaction: "read",
              dependencies: { tx: unitOfWork, feed: channel.publication },
              publishes: [channel],
              handler: () => ({ ok: true as const }),
            }),
            defineOperation({
              id: "activity.save",
              input: {},
              output: { 200: z.object({ ok: z.literal(true) }) },
              successStatus: 200,
              errors: [],
              access: publicAccess(),
              transaction: "write",
              dependencies: { tx: unitOfWork, feed: channel.publication },
              publishes: [channel],
              handler: () => ({ ok: true as const }),
            }),
          ],
        }),
      ]),
    ).toEqual([
      "SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING",
      "SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN",
    ]);
  });
});
