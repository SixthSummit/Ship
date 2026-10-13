import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authenticatedAccess, optionalIdentityAccess, permission, publicAccess } from "./access.js";
import { operationActor } from "./actor.js";
import { ApplicationCompilationError, compileApp, defineApp } from "./application.js";
import {
  type CacheBackend,
  CacheContractError,
  cacheBackendDependency,
  cacheControlHeader,
  cacheScopeKey,
  canonicalJson,
  createSingleFlight,
  deriveCacheKey,
  isCacheBackend,
  isCachedOperationResult,
  isCacheInvalidationList,
  isCacheTagList,
  isOperationCache,
  normalizeCacheInvalidations,
  scopedCacheTag,
} from "./cache.js";
import {
  cacheInvalidationEffect,
  cacheInvalidationOutbox,
  defineCacheInvalidationModule,
} from "./cache-invalidation.js";
import { type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { createExecutor } from "./executor.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import { operationError, operationFailure } from "./operation-error.js";
import type {
  OutboxBackend,
  OutboxIntentInput,
  OutboxRecord,
  OutboxRecordResult,
} from "./outbox.js";
import { valueProvider } from "./provider.js";
import { createTenantScopeAuthority } from "./tenant.js";

const cacheToken = cacheBackendDependency("platform.cache");
const transactionToken = unitOfWorkDependency<{ readonly writes: string[] }>("database.primary");

interface FakeCacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
  readonly tags: readonly string[];
}

function createFakeCache(clock: () => number = () => Date.now()): CacheBackend & {
  readonly entries: Map<string, FakeCacheEntry>;
} {
  const entries = new Map<string, FakeCacheEntry>();
  const gate = createSingleFlight();
  return {
    kind: "ship.cache-backend" as const,
    entries,
    get: async (key) => {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= clock()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set: async (key, value, options) => {
      entries.set(key, {
        value,
        expiresAt: clock() + options.ttlMs,
        tags: [...(options.tags ?? [])],
      });
    },
    del: async (key) => {
      entries.delete(key);
    },
    delByTag: async (tag) => {
      for (const [key, entry] of entries) {
        if (entry.tags.includes(tag)) entries.delete(key);
      }
    },
    health: async () => ({ available: true }),
    singleFlight: gate,
  };
}

/** Records intents against a scope object and drops them when the scope rolls back. */
function createFakeOutbox(): OutboxBackend & {
  readonly committed: OutboxRecord[];
  recordedFor(scope: object): OutboxIntentInput[];
} {
  const pending = new WeakMap<object, OutboxIntentInput[]>();
  const committed: OutboxRecord[] = [];
  return {
    kind: "ship.outbox-backend" as const,
    outboxId: cacheInvalidationOutbox.id,
    committed,
    recordedFor: (scope) => pending.get(scope) ?? [],
    record: async (scope, intents): Promise<readonly OutboxRecordResult[]> => {
      const bucket = pending.get(scope) ?? [];
      bucket.push(...intents);
      pending.set(scope, bucket);
      return intents.map((_, index) => ({
        recordId: `record-${bucket.length - intents.length + index}`,
        deduplicated: false as const,
      }));
    },
    claimDue: async () => [],
    claimUnknownDue: async () => [],
    complete: async () => undefined,
    fail: async () => undefined,
    listDeadLettered: async () => [],
    retry: async () => undefined,
    discard: async () => undefined,
    cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
    health: async () => ({ pending: 0, claimed: 0, deadLettered: 0 }),
  };
}

/**
 * Minimal unit of work: the capability object is the transaction scope, and a
 * throwing handler rolls back by discarding everything recorded against it.
 */
function createUnitOfWork(options: { readonly onRollback?: (scope: object) => void } = {}) {
  const scopes: object[] = [];
  const controller: UnitOfWork<{ readonly writes: string[] }> = {
    kind: "ship.unit-of-work" as const,
    id: transactionToken.id,
    run: async (_mode, work) => {
      const scope = { writes: [] as string[] };
      scopes.push(scope);
      try {
        return await work(scope);
      } catch (error) {
        options.onRollback?.(scope);
        throw error;
      }
    },
  };
  return { controller, scopes };
}

describe("cacheBackendDependency", () => {
  it("creates a cache-scoped dependency token", () => {
    expect(cacheToken).toEqual({
      kind: "ship.dependency",
      id: "platform.cache",
      scope: "cache",
    });
  });

  it("rejects an id that is not a lowercase dot-separated identifier", () => {
    expect(() => cacheBackendDependency("Platform Cache")).toThrow(CacheContractError);
    expect(() => cacheBackendDependency("Platform Cache")).toThrow(/lowercase dot-separated/);
  });
});

describe("cache guards", () => {
  it("accepts a complete backend and rejects a partial one", () => {
    expect(isCacheBackend(createFakeCache())).toBe(true);
    expect(isCacheBackend({ kind: "ship.cache-backend", get: () => undefined })).toBe(false);
    expect(isCacheBackend(null)).toBe(false);
  });

  it("accepts only 2xx cached results with string headers", () => {
    expect(isCachedOperationResult({ status: 200, data: { ok: true } })).toBe(true);
    expect(isCachedOperationResult({ status: 200, data: 1, headers: { etag: "a" } })).toBe(true);
    expect(isCachedOperationResult({ status: 404, data: 1 })).toBe(false);
    expect(isCachedOperationResult({ status: 200 })).toBe(false);
    expect(isCachedOperationResult({ status: 200, data: 1, headers: { etag: 1 } })).toBe(false);
    expect(isCachedOperationResult("nope")).toBe(false);
  });

  it("accepts unique lowercase tag lists only", () => {
    expect(isCacheTagList(["widgets", "widgets:list", "a.b"])).toBe(true);
    expect(isCacheTagList([])).toBe(false);
    expect(isCacheTagList(["widgets", "widgets"])).toBe(false);
    expect(isCacheTagList(["Widgets"])).toBe(false);
    expect(isCacheTagList("widgets")).toBe(false);
  });

  it("requires a tenant resolver exactly for tenant scope", () => {
    expect(isOperationCache({ ttlMs: 1, scope: "public" })).toBe(true);
    expect(isOperationCache({ ttlMs: 1, scope: "tenant" })).toBe(false);
    expect(isOperationCache({ ttlMs: 1, scope: "tenant", tenant: () => undefined })).toBe(true);
    expect(isOperationCache({ ttlMs: 1, scope: "public", tenant: () => undefined })).toBe(false);
    expect(isOperationCache({ ttlMs: 0, scope: "public" })).toBe(false);
    expect(isOperationCache({ ttlMs: 1, scope: "session" })).toBe(false);
    expect(isOperationCache({ ttlMs: 1, scope: "public", vary: "x" })).toBe(false);
    expect(isOperationCache({ ttlMs: 1, scope: "public", tags: ["A"] })).toBe(false);
    expect(isOperationCache([])).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("is independent of object key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("keeps distinguishable shapes distinct", () => {
    expect(canonicalJson(undefined)).not.toBe(canonicalJson(null));
    expect(canonicalJson("1")).not.toBe(canonicalJson(1));
    expect(canonicalJson(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      '["d","2026-01-01T00:00:00.000Z"]',
    );
    expect(canonicalJson(10n)).toBe('["b","10"]');
    expect(canonicalJson([1, [2]])).toBe("[1,[2]]");
    expect(canonicalJson(true)).toBe("true");
  });

  it("refuses values that cannot be canonicalized", () => {
    expect(() => canonicalJson(() => undefined)).toThrow(CacheContractError);
    expect(() => canonicalJson(Number.NaN)).toThrow(/NaN/);
    expect(() => canonicalJson(new Date("nope"))).toThrow(/invalid Date/);
  });
});

describe("deriveCacheKey", () => {
  const base = {
    operationId: "widgets.list",
    version: "v1",
    scopeKey: "tenant:s1",
    input: { query: { limit: 10 } },
  };

  it("is deterministic and namespaced by the operation id", async () => {
    const key = await deriveCacheKey(base);
    expect(key).toBe(await deriveCacheKey({ ...base, input: { query: { limit: 10 } } }));
    expect(key.startsWith("ship.cache.v1:widgets.list:")).toBe(true);
  });

  it("separates scope, version, input and vary", async () => {
    const key = await deriveCacheKey(base);
    expect(await deriveCacheKey({ ...base, scopeKey: "tenant:s2" })).not.toBe(key);
    expect(await deriveCacheKey({ ...base, version: "v2" })).not.toBe(key);
    expect(await deriveCacheKey({ ...base, input: { query: { limit: 11 } } })).not.toBe(key);
    expect(await deriveCacheKey({ ...base, vary: ["en"] })).not.toBe(key);
    expect(await deriveCacheKey({ ...base, vary: ["en"] })).not.toBe(
      await deriveCacheKey({ ...base, vary: ["fr"] }),
    );
  });

  it("gives two actors in different tenants distinct keys for identical input", async () => {
    const left = await deriveCacheKey({ ...base, scopeKey: cacheScopeKey("actor", actorA) });
    const right = await deriveCacheKey({ ...base, scopeKey: cacheScopeKey("actor", actorB) });
    expect(left).not.toBe(right);
  });
});

const actorA = operationActor({ id: "actor-a", permissions: ["portfolio:read", "tenant:alpha"] });
const actorB = operationActor({ id: "actor-b", permissions: ["portfolio:read", "tenant:beta"] });
const tenantAuthority = createTenantScopeAuthority({
  id: "test.tenant-policy",
  authorize: ({ actor, tenantId }) => actor.permissions?.has(`tenant:${tenantId}`) ?? false,
});

describe("cacheScopeKey", () => {
  it("derives public, actor and authentic tenant keys", async () => {
    expect(cacheScopeKey("public", undefined)).toBe("public");
    expect(cacheScopeKey("actor", actorA)).toBe("actor:actor-a");
    const scope = await tenantAuthority.issue({
      tenantId: "alpha",
      requestId: "request-1",
      actor: actorA,
    });
    expect(cacheScopeKey("tenant", scope)).toBe("tenant:salpha");
    const numeric = await tenantAuthority.issue({
      tenantId: 7,
      requestId: "request-1",
      actor: operationActor({ id: "actor-n", permissions: ["tenant:7"] }),
    });
    expect(cacheScopeKey("tenant", numeric)).toBe("tenant:n7");
  });

  it("refuses a forged tenant scope and a missing actor", () => {
    expect(() =>
      cacheScopeKey("tenant", {
        kind: "ship.tenant-scope",
        tenantId: "alpha",
      } as never),
    ).toThrow(/authentic TenantScope/);
    expect(() => cacheScopeKey("actor", undefined)).toThrow(/authenticated actor/);
  });
});

describe("createSingleFlight", () => {
  it("runs one loader for a burst of concurrent callers on one key", async () => {
    const gate = createSingleFlight();
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "value";
    });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => gate("same-key", () => run())),
    );
    expect(results.every((item) => item === "value")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce different keys and releases after settling", async () => {
    const gate = createSingleFlight();
    const run = vi.fn(async () => "value");
    await Promise.all([gate("a", run), gate("b", run)]);
    await gate("a", run);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("releases the key when the loader rejects", async () => {
    const gate = createSingleFlight();
    await expect(
      gate("a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(gate("a", async () => "recovered")).resolves.toBe("recovered");
  });
});

describe("cacheControlHeader", () => {
  it("projects private and public policies", () => {
    expect(cacheControlHeader({ ttlMs: 30_000, scope: "actor" }, publicAccess())).toBe(
      "private, max-age=30",
    );
    expect(cacheControlHeader({ ttlMs: 30_000, scope: "tenant" }, authenticatedAccess())).toBe(
      "private, max-age=30",
    );
    expect(cacheControlHeader({ ttlMs: 1_500, scope: "public" }, publicAccess())).toBe(
      "public, max-age=1",
    );
  });

  it("keeps a shared cache key private unless the operation's access is public", () => {
    expect(cacheControlHeader({ ttlMs: 30_000, scope: "public" }, authenticatedAccess())).toBe(
      "private, max-age=30",
    );
    expect(cacheControlHeader({ ttlMs: 30_000, scope: "public" }, permission("widgets:read"))).toBe(
      "private, max-age=30",
    );
    // No access at all is treated as protected: the safe default is private.
    expect(cacheControlHeader({ ttlMs: 30_000, scope: "public" })).toBe("private, max-age=30");
  });
});

describe("cache invalidation declarations", () => {
  const tenants = createTenantScopeAuthority({ id: "app.tenants", authorize: () => true });
  const tenant = ({ context }: { context: { requestId: string; actor?: unknown } }) =>
    tenants.issue({
      tenantId: "alpha",
      requestId: context.requestId,
      actor: context.actor as never,
    });

  it("accepts plain tags and actor- or tenant-scoped entries with unique tags", () => {
    expect(isCacheInvalidationList(["widgets"])).toBe(true);
    expect(isCacheInvalidationList([{ tag: "widgets", scope: "actor" }])).toBe(true);
    expect(isCacheInvalidationList([{ tag: "widgets", scope: "actor", tenant }])).toBe(false);
    expect(isCacheInvalidationList([{ tag: "widgets", scope: "tenant", tenant }])).toBe(true);
    expect(isCacheInvalidationList(["widgets", { tag: "gadgets", scope: "tenant", tenant }])).toBe(
      true,
    );
    expect(isCacheInvalidationList([])).toBe(false);
    expect(isCacheInvalidationList(["widgets", "widgets"])).toBe(false);
    expect(isCacheInvalidationList(["widgets", { tag: "widgets", scope: "tenant", tenant }])).toBe(
      false,
    );
    expect(isCacheInvalidationList([{ tag: "widgets", scope: "tenant" }])).toBe(false);
    expect(isCacheInvalidationList([{ tag: "widgets", scope: "public" }])).toBe(false);
    // The compiled form re-declares, so an operation can be spread into another.
    expect(isCacheInvalidationList([{ tag: "widgets", scope: "global" }])).toBe(true);
    expect(normalizeCacheInvalidations([{ tag: "widgets", scope: "global" }])).toEqual([
      { tag: "widgets", scope: "global" },
    ]);
    expect(isCacheInvalidationList([{ tag: "Widgets", scope: "tenant", tenant }])).toBe(false);
  });

  it("normalizes every form into { tag, scope, tenant? }", () => {
    expect(
      normalizeCacheInvalidations([
        "widgets",
        { tag: "gizmos", scope: "actor" },
        { tag: "gadgets", scope: "tenant", tenant },
      ]),
    ).toEqual([
      { tag: "widgets", scope: "global" },
      { tag: "gizmos", scope: "actor" },
      { tag: "gadgets", scope: "tenant", tenant },
    ]);
  });

  it("qualifies a tag by the scope key that keyed the entry", () => {
    expect(scopedCacheTag("widgets", "tenant:salpha")).toBe("widgets@tenant:salpha");
    expect(scopedCacheTag("widgets", "actor:actor-a")).toBe("widgets@actor:actor-a");
  });
});

const summarySchema = z.object({ total: z.number().int() });

function createCachedApplication(
  options: {
    readonly cache?: CacheBackend;
    readonly handler?: () => unknown;
    readonly scope?: "actor" | "tenant" | "public";
    readonly vary?: (input: { readonly query: { readonly limit: number } }) => readonly string[];
  } = {},
) {
  const backend = options.cache ?? createFakeCache();
  const handler = options.handler ?? (() => ({ total: 1 }));
  const scope = options.scope ?? "actor";
  const read = defineOperation({
    id: "widgets.list",
    input: { query: z.object({ limit: z.coerce.number().int().positive() }) },
    output: { 200: summarySchema },
    successStatus: 200,
    errors: [],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { cache: cacheToken },
    cache: {
      ttlMs: 60_000,
      scope,
      tags: ["widgets"],
      ...(options.vary ? { vary: options.vary } : {}),
      ...(scope === "tenant"
        ? {
            tenant: ({ context }: { context: { requestId: string; actor?: unknown } }) =>
              tenantAuthority.issue({
                tenantId: (context.actor as { id: string }).id === "actor-a" ? "alpha" : "beta",
                requestId: context.requestId,
                actor: context.actor as never,
              }),
          }
        : {}),
    },
    handler: () => handler() as { total: number },
  });
  const app = defineApp({
    id: "cache-fixture",
    modules: [
      defineModule({
        id: "widgets",
        operations: [read],
        providers: [valueProvider(cacheToken, backend)],
        imports: [],
        exports: [],
      }),
    ],
  });
  return { app, backend, executor: createExecutor(app) };
}

describe("executor read cache", () => {
  it("stores on a miss and replays the stored success on a hit", async () => {
    const handler = vi.fn(() => ({ total: 7 }));
    const { executor, backend } = createCachedApplication({ handler });
    const first = await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA });
    const second = await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA });
    expect(first).toMatchObject({ ok: true, status: 200, data: { total: 7 }, cache: "miss" });
    expect(second).toMatchObject({ ok: true, status: 200, data: { total: 7 }, cache: "hit" });
    expect(handler).toHaveBeenCalledTimes(1);
    // An actor-scoped entry is indexed under the plain tag and the actor-qualified one.
    expect([...backend.entries.values()][0]?.tags).toEqual(["widgets", "widgets@actor:actor-a"]);
  });

  it("keys actor-scoped entries per actor", async () => {
    const handler = vi.fn(() => ({ total: 1 }));
    const { executor, backend } = createCachedApplication({ handler });
    await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA });
    await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorB });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(backend.entries.size).toBe(2);
  });

  it("refuses to serve one tenant's entry to another", async () => {
    let total = 0;
    const { executor, backend } = createCachedApplication({
      scope: "tenant",
      handler: () => {
        total += 1;
        return { total };
      },
    });
    const alpha = await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA });
    const beta = await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorB });
    expect(alpha).toMatchObject({ data: { total: 1 }, cache: "miss" });
    expect(beta).toMatchObject({ data: { total: 2 }, cache: "miss" });
    expect(backend.entries.size).toBe(2);
  });

  it("separates entries declared by vary", async () => {
    const handler = vi.fn(() => ({ total: 1 }));
    const { executor, backend } = createCachedApplication({
      handler,
      vary: (input) => [`limit:${input.query.limit}`],
    });
    await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA });
    await executor.run("widgets.list", { query: { limit: "6" } }, { actor: actorA });
    expect(backend.entries.size).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("re-runs the handler once the entry expires", async () => {
    let now = 1_000;
    const handler = vi.fn(() => ({ total: 1 }));
    const { executor } = createCachedApplication({ cache: createFakeCache(() => now), handler });
    await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA });
    now += 59_000;
    await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA });
    expect(handler).toHaveBeenCalledTimes(1);
    now += 2_000;
    const third = await executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA });
    expect(third).toMatchObject({ cache: "miss" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("never caches a declared failure", async () => {
    const unavailable = operationError({
      code: "WIDGETS_UNAVAILABLE",
      status: 503,
      message: "Widgets are unavailable",
    });
    const read = defineOperation({
      id: "widgets.list",
      input: { query: z.object({ limit: z.coerce.number().int().positive() }) },
      output: { 200: summarySchema },
      successStatus: 200,
      errors: [unavailable],
      access: authenticatedAccess(),
      transaction: "none",
      dependencies: { cache: cacheToken },
      cache: { ttlMs: 60_000, scope: "actor" },
      handler: () => {
        throw operationFailure(unavailable);
      },
    });
    const backend = createFakeCache();
    const app = defineApp({
      id: "cache-fixture",
      modules: [
        defineModule({
          id: "widgets",
          operations: [read],
          providers: [valueProvider(cacheToken, backend)],
          imports: [],
          exports: [],
        }),
      ],
    });
    const result = await createExecutor(app).run(
      "widgets.list",
      { query: { limit: "5" } },
      { actor: actorA },
    );
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(backend.entries.size).toBe(0);
  });

  it("runs the handler once for fifty concurrent misses on one key", async () => {
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { total: 1 };
    });
    const { executor } = createCachedApplication({
      handler: handler as unknown as () => unknown,
    });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA }),
      ),
    );
    expect(results.every((item) => item.ok)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reports an unusable backend with a stable diagnostic", async () => {
    const read = defineOperation({
      id: "widgets.list",
      input: {},
      output: { 200: summarySchema },
      successStatus: 200,
      errors: [],
      access: authenticatedAccess(),
      transaction: "none",
      dependencies: { cache: cacheToken },
      cache: { ttlMs: 60_000, scope: "actor" },
      handler: () => ({ total: 1 }),
    });
    const app = defineApp({
      id: "cache-fixture",
      modules: [
        defineModule({
          id: "widgets",
          operations: [read],
          providers: [valueProvider(cacheToken, { kind: "not-a-cache" } as never)],
          imports: [],
          exports: [],
        }),
      ],
    });
    await expect(createExecutor(app).run("widgets.list", {}, { actor: actorA })).rejects.toThrow(
      /did not create a cache backend/,
    );
  });

  it("rejects a vary function that does not return strings", async () => {
    const { executor } = createCachedApplication({
      vary: (() => [1]) as never,
    });
    await expect(
      executor.run("widgets.list", { query: { limit: "5" } }, { actor: actorA }),
    ).rejects.toThrow(/must return an array of strings/);
  });

  it("fails the run when the tenant resolver denies access", async () => {
    const { executor } = createCachedApplication({ scope: "tenant" });
    await expect(
      executor.run(
        "widgets.list",
        { query: { limit: "5" } },
        { actor: operationActor({ id: "actor-c" }) },
      ),
    ).rejects.toThrow(/authentic cache scope/);
  });
});

function createInvalidatingApplication(
  options: {
    readonly fail?: boolean;
    readonly mountDispatcher?: boolean;
    /** Key the read per tenant and narrow the write's purge to the actor's tenant. */
    readonly tenantScoped?: boolean;
    /** Key the read per actor and narrow the write's purge to the writing actor. */
    readonly actorScoped?: boolean;
  } = {},
) {
  const cache = createFakeCache();
  const outbox = createFakeOutbox();
  const rolledBack: object[] = [];
  const unitOfWork = createUnitOfWork({ onRollback: (scope) => rolledBack.push(scope) });
  const tenantOf = ({ context }: { context: { requestId: string; actor?: unknown } }) =>
    tenantAuthority.issue({
      tenantId: (context.actor as { id: string }).id === "actor-a" ? "alpha" : "beta",
      requestId: context.requestId,
      actor: context.actor as never,
    });
  const write = defineOperation({
    id: "widgets.rename",
    input: { body: z.object({ name: z.string().min(1) }) },
    output: { 200: z.object({ renamed: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: permission("widgets:write"),
    transaction: "write",
    dependencies: { tx: transactionToken },
    invalidates: options.tenantScoped
      ? [{ tag: "widgets", scope: "tenant", tenant: tenantOf }]
      : options.actorScoped
        ? [{ tag: "widgets", scope: "actor" }]
        : ["widgets"],
    handler: () => {
      if (options.fail) throw new Error("handler exploded");
      return { renamed: true as const };
    },
  });
  const read = defineOperation({
    id: "widgets.list",
    input: {},
    output: { 200: summarySchema },
    successStatus: 200,
    errors: [],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { cache: cacheToken },
    cache: options.tenantScoped
      ? { ttlMs: 60_000, scope: "tenant", tags: ["widgets"], tenant: tenantOf }
      : options.actorScoped
        ? { ttlMs: 60_000, scope: "actor", tags: ["widgets"] }
        : { ttlMs: 60_000, scope: "public", tags: ["widgets"] },
    handler: () => ({ total: 1 }),
  });
  const modules = [
    defineModule({
      id: "widgets",
      operations: [read, write],
      providers: [
        valueProvider(cacheToken, cache),
        valueProvider(transactionToken, unitOfWork.controller),
      ],
      imports: ["ship-cache"],
      exports: [],
    }),
    ...(options.mountDispatcher === false
      ? []
      : [defineCacheInvalidationModule({ cache, outbox })]),
  ];
  return {
    cache,
    outbox,
    unitOfWork,
    rolledBack,
    modules,
    get executor() {
      return createExecutor(defineApp({ id: "cache-fixture", modules }));
    },
  };
}

describe("declared invalidation", () => {
  it("records one durable purge intent per tag inside the write transaction", async () => {
    const fixture = createInvalidatingApplication();
    const result = await fixture.executor.run(
      "widgets.rename",
      { body: { name: "new" } },
      { actor: operationActor({ id: "actor-a", permissions: ["widgets:write"] }) },
    );
    expect(result.ok).toBe(true);
    const scope = fixture.unitOfWork.scopes[0] as object;
    expect(fixture.outbox.recordedFor(scope)).toEqual([
      expect.objectContaining({ intentId: "purge-tag", payload: { tag: "widgets" } }),
    ]);
  });

  it("purges nothing directly — the dispatcher performs it after commit", async () => {
    const fixture = createInvalidatingApplication();
    await fixture.cache.set(
      "ship.cache.v1:widgets.list:x",
      { status: 200, data: 1 },
      {
        ttlMs: 60_000,
        tags: ["widgets"],
      },
    );
    await fixture.executor.run(
      "widgets.rename",
      { body: { name: "new" } },
      { actor: operationActor({ id: "actor-a", permissions: ["widgets:write"] }) },
    );
    expect(fixture.cache.entries.size).toBe(1);
    await cacheInvalidationOutbox.intents["purge-tag"]?.perform({
      effect: fixture.cache,
      payload: { tag: "widgets" },
    } as never);
    expect(fixture.cache.entries.size).toBe(0);
  });

  it("stores a tenant-scoped entry under its plain tag and its tenant-qualified tag", async () => {
    const fixture = createInvalidatingApplication({ tenantScoped: true });
    await fixture.executor.run("widgets.list", {}, { actor: actorA });
    expect([...fixture.cache.entries.values()][0]?.tags).toEqual([
      "widgets",
      "widgets@tenant:salpha",
    ]);
  });

  it("narrows the purge intent to the write's authentic tenant", async () => {
    const fixture = createInvalidatingApplication({ tenantScoped: true });
    const executor = fixture.executor;
    await executor.run("widgets.list", {}, { actor: actorA });
    await executor.run("widgets.list", {}, { actor: actorB });
    expect(fixture.cache.entries.size).toBe(2);

    const result = await executor.run(
      "widgets.rename",
      { body: { name: "new" } },
      { actor: operationActor({ id: "actor-a", permissions: ["widgets:write", "tenant:alpha"] }) },
    );
    expect(result.ok).toBe(true);
    const scope = fixture.unitOfWork.scopes[0] as object;
    const recorded = fixture.outbox.recordedFor(scope);
    expect(recorded).toEqual([
      expect.objectContaining({
        intentId: "purge-tag",
        payload: { tag: "widgets", scope: "tenant:salpha" },
      }),
    ]);

    // Performing the intent purges alpha's entry and leaves beta's warm.
    await cacheInvalidationOutbox.intents["purge-tag"]?.perform({
      effect: fixture.cache,
      payload: recorded[0]?.payload,
    } as never);
    expect(fixture.cache.entries.size).toBe(1);
    expect(await executor.run("widgets.list", {}, { actor: actorB })).toMatchObject({
      cache: "hit",
    });
    expect(await executor.run("widgets.list", {}, { actor: actorA })).toMatchObject({
      cache: "miss",
    });
  });

  it("narrows an actor-scoped purge to the writing actor", async () => {
    const fixture = createInvalidatingApplication({ actorScoped: true });
    const executor = fixture.executor;
    await executor.run("widgets.list", {}, { actor: actorA });
    await executor.run("widgets.list", {}, { actor: actorB });
    expect([...fixture.cache.entries.values()][0]?.tags).toEqual([
      "widgets",
      "widgets@actor:actor-a",
    ]);

    await executor.run(
      "widgets.rename",
      { body: { name: "new" } },
      { actor: operationActor({ id: "actor-a", permissions: ["widgets:write"] }) },
    );
    const scope = fixture.unitOfWork.scopes[0] as object;
    const recorded = fixture.outbox.recordedFor(scope);
    expect(recorded).toEqual([
      expect.objectContaining({ payload: { tag: "widgets", scope: "actor:actor-a" } }),
    ]);
    await cacheInvalidationOutbox.intents["purge-tag"]?.perform({
      effect: fixture.cache,
      payload: recorded[0]?.payload,
    } as never);
    expect(await executor.run("widgets.list", {}, { actor: actorB })).toMatchObject({
      cache: "hit",
    });
    expect(await executor.run("widgets.list", {}, { actor: actorA })).toMatchObject({
      cache: "miss",
    });
  });

  it("purges every tenant when the plain tag form is performed", async () => {
    const fixture = createInvalidatingApplication({ tenantScoped: true });
    const executor = fixture.executor;
    await executor.run("widgets.list", {}, { actor: actorA });
    await executor.run("widgets.list", {}, { actor: actorB });
    await cacheInvalidationOutbox.intents["purge-tag"]?.perform({
      effect: fixture.cache,
      payload: { tag: "widgets" },
    } as never);
    expect(fixture.cache.entries.size).toBe(0);
  });

  it("fails the write before recording when the tenant resolver denies the actor", async () => {
    const fixture = createInvalidatingApplication({ tenantScoped: true });
    await expect(
      fixture.executor.run(
        "widgets.rename",
        { body: { name: "new" } },
        { actor: operationActor({ id: "actor-c", permissions: ["widgets:write"] }) },
      ),
    ).rejects.toThrow(/authentic tenant/);
    const scope = fixture.unitOfWork.scopes[0] as object;
    expect(fixture.outbox.recordedFor(scope)).toEqual([]);
  });

  it("leaves no intent when the transaction rolls back", async () => {
    const fixture = createInvalidatingApplication({ fail: true });
    await expect(
      fixture.executor.run(
        "widgets.rename",
        { body: { name: "new" } },
        { actor: operationActor({ id: "actor-a", permissions: ["widgets:write"] }) },
      ),
    ).rejects.toThrow(/handler failed/);
    const scope = fixture.unitOfWork.scopes[0] as object;
    expect(fixture.rolledBack).toContain(scope);
    expect(fixture.outbox.recordedFor(scope)).toEqual([]);
  });
});

describe("cache compilation diagnostics", () => {
  const backendProvider = valueProvider(cacheToken, createFakeCache());

  function compile(operation: ReturnType<typeof defineOperation>, imports: readonly string[] = []) {
    const cache = createFakeCache();
    return compileApp({
      id: "cache-fixture",
      modules: [
        defineModule({
          id: "widgets",
          operations: [operation],
          providers: [
            backendProvider,
            valueProvider(transactionToken, createUnitOfWork().controller),
          ],
          imports: [...imports],
          exports: [],
        }),
        ...(imports.includes("ship-cache")
          ? [defineCacheInvalidationModule({ cache, outbox: createFakeOutbox() })]
          : []),
      ],
    });
  }

  function diagnosticCodes(run: () => unknown): readonly string[] {
    try {
      run();
    } catch (error) {
      if (error instanceof ApplicationCompilationError) {
        return error.diagnostics.map((item) => item.code);
      }
      throw error;
    }
    return [];
  }

  it("rejects a cache declaration on a write operation", () => {
    const codes = diagnosticCodes(() =>
      compile(
        defineOperation({
          id: "widgets.rename",
          input: {},
          output: { 200: summarySchema },
          successStatus: 200,
          errors: [],
          access: authenticatedAccess(),
          transaction: "write",
          dependencies: { cache: cacheToken, tx: transactionToken },
          cache: { ttlMs: 1_000, scope: "actor" },
          handler: () => ({ total: 1 }),
        }),
      ),
    );
    expect(codes).toContain("SHIP_CACHE_TRANSACTION_FORBIDDEN");
  });

  it("rejects a cache declaration with no bound backend", () => {
    const codes = diagnosticCodes(() =>
      compile(
        defineOperation({
          id: "widgets.list",
          input: {},
          output: { 200: summarySchema },
          successStatus: 200,
          errors: [],
          access: authenticatedAccess(),
          transaction: "none",
          dependencies: {},
          cache: { ttlMs: 1_000, scope: "actor" },
          handler: () => ({ total: 1 }),
        }),
      ),
    );
    expect(codes).toContain("SHIP_CACHE_BACKEND_UNBOUND");
  });

  it("rejects actor scope on an operation that needs no actor", () => {
    const codes = diagnosticCodes(() =>
      compile(
        defineOperation({
          id: "widgets.list",
          input: {},
          output: { 200: summarySchema },
          successStatus: 200,
          errors: [],
          access: publicAccess(),
          transaction: "none",
          dependencies: { cache: cacheToken },
          cache: { ttlMs: 1_000, scope: "actor" },
          handler: () => ({ total: 1 }),
        }),
      ),
    );
    expect(codes).toContain("SHIP_CACHE_SCOPE_ACTOR_INVALID");
  });

  it("rejects invalidates on an operation that is not a write", () => {
    const codes = diagnosticCodes(() =>
      compile(
        defineOperation({
          id: "widgets.touch",
          input: {},
          output: { 200: summarySchema },
          successStatus: 200,
          errors: [],
          access: authenticatedAccess(),
          transaction: "none",
          dependencies: {},
          invalidates: ["widgets"],
          handler: () => ({ total: 1 }),
        }),
        ["ship-cache"],
      ),
    );
    expect(codes).toContain("SHIP_CACHE_INVALIDATES_TRANSACTION_INVALID");
  });

  it("requires a mounted cache-invalidation dispatcher", () => {
    const fixture = createInvalidatingApplication({ mountDispatcher: false });
    const codes = diagnosticCodes(() =>
      compileApp({ id: "cache-fixture", modules: fixture.modules }),
    );
    expect(codes).toContain("SHIP_CACHE_INVALIDATION_DISPATCHER_MISSING");
  });

  it("warns without failing when an invalidated tag has no cached reader", () => {
    const fixture = createInvalidatingApplication();
    const write = defineOperation({
      id: "widgets.archive",
      input: {},
      output: { 200: z.object({ renamed: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: authenticatedAccess(),
      transaction: "write",
      dependencies: { tx: transactionToken },
      invalidates: ["gadgets"],
      handler: () => ({ renamed: true as const }),
    });
    const module = fixture.modules[0] as ReturnType<typeof defineModule>;
    const app = compileApp({
      id: "cache-fixture",
      modules: [
        defineModule({
          id: "widgets",
          operations: [...module.operations, write],
          providers: [...module.providers],
          imports: ["ship-cache"],
          exports: [],
        }),
        fixture.modules[1] as ReturnType<typeof defineModule>,
      ],
    });
    expect(app.graph.diagnostics.map((item) => item.code)).toContain("SHIP_CACHE_TAG_UNKNOWN");
    expect(
      app.graph.diagnostics.find((item) => item.code === "SHIP_CACHE_TAG_UNKNOWN"),
    ).toMatchObject({ severity: "warning", operationId: "widgets.archive" });
  });

  it("warns when a shared cache key sits behind protected access and projects it private", () => {
    // The fixture read is authenticated with scope public: every caller allowed
    // in shares one entry, and the HTTP projection must not say `public`.
    const fixture = createInvalidatingApplication();
    const app = compileApp({ id: "cache-fixture", modules: fixture.modules });
    expect(app.graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "SHIP_CACHE_PUBLIC_SCOPE_PROTECTED",
        severity: "warning",
        operationId: "widgets.list",
        path: "cache.scope",
      }),
    ]);
    expect(app.graph.operations.find((node) => node.id === "widgets.list")?.cache).toMatchObject({
      scope: "public",
      cacheControl: "private, max-age=60",
    });
  });

  it("projects public Cache-Control only for a public-access read", () => {
    const app = compile(
      defineOperation({
        id: "widgets.list",
        input: {},
        output: { 200: summarySchema },
        successStatus: 200,
        errors: [],
        access: publicAccess(),
        transaction: "none",
        dependencies: { cache: cacheToken },
        cache: { ttlMs: 60_000, scope: "public" },
        handler: () => ({ total: 1 }),
      }),
    );
    expect(app.diagnostics).toEqual([]);
    expect(app.graph.operations[0]?.cache?.cacheControl).toBe("public, max-age=60");
  });

  it("rejects a shared cache key on an optional-identity read", () => {
    const codes = diagnosticCodes(() =>
      compile(
        defineOperation({
          id: "widgets.list",
          input: {},
          output: { 200: summarySchema },
          successStatus: 200,
          errors: [],
          access: optionalIdentityAccess(),
          transaction: "none",
          dependencies: { cache: cacheToken },
          cache: { ttlMs: 60_000, scope: "public" },
          handler: () => ({ total: 1 }),
        }),
      ),
    );
    expect(codes).toContain("SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN");
    expect(codes).not.toContain("SHIP_CACHE_PUBLIC_SCOPE_PROTECTED");
  });

  it("rejects an actor-scoped purge on a write that requires no actor", () => {
    const codes = diagnosticCodes(() =>
      compile(
        defineOperation({
          id: "widgets.archive",
          input: {},
          output: { 200: summarySchema },
          successStatus: 200,
          errors: [],
          access: publicAccess(),
          transaction: "write",
          dependencies: { tx: transactionToken },
          invalidates: [{ tag: "widgets", scope: "actor" }],
          handler: () => ({ total: 1 }),
        }),
        ["ship-cache"],
      ),
    );
    expect(codes).toContain("SHIP_CACHE_INVALIDATES_ACTOR_INVALID");
  });

  it("warns when a public read's vary reads the subject", () => {
    const app = compile(
      defineOperation({
        id: "widgets.list",
        input: {},
        output: { 200: summarySchema },
        successStatus: 200,
        errors: [],
        access: publicAccess(),
        transaction: "none",
        dependencies: { cache: cacheToken },
        cache: {
          ttlMs: 60_000,
          scope: "public",
          vary: (_input, subject) => [subject.context.requestId],
        },
        handler: () => ({ total: 1 }),
      }),
    );
    expect(app.graph.diagnostics).toEqual([
      expect.objectContaining({ code: "SHIP_CACHE_VARY_SUBJECT_PUBLIC", severity: "warning" }),
    ]);
  });

  it("warns when a tenant-scoped purge names a tag no tenant-scoped read declares", () => {
    const fixture = createInvalidatingApplication();
    const module = fixture.modules[0] as ReturnType<typeof defineModule>;
    const write = defineOperation({
      id: "widgets.archive",
      input: {},
      output: { 200: z.object({ renamed: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: authenticatedAccess(),
      transaction: "write",
      dependencies: { tx: transactionToken },
      invalidates: [
        {
          tag: "widgets",
          scope: "tenant",
          tenant: ({ context }) =>
            tenantAuthority.issue({
              tenantId: "alpha",
              requestId: context.requestId,
              actor: context.actor as never,
            }),
        },
      ],
      handler: () => ({ renamed: true as const }),
    });
    const app = compileApp({
      id: "cache-fixture",
      modules: [
        defineModule({
          id: "widgets",
          operations: [...module.operations, write],
          providers: [...module.providers],
          imports: ["ship-cache"],
          exports: [],
        }),
        fixture.modules[1] as ReturnType<typeof defineModule>,
      ],
    });
    expect(app.graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SHIP_CACHE_TAG_SCOPE_UNMATCHED",
        severity: "warning",
        operationId: "widgets.archive",
      }),
    );
    expect(app.graph.operations.find((node) => node.id === "widgets.archive")).toMatchObject({
      invalidates: ["widgets"],
      invalidatesScoped: [{ tag: "widgets", scope: "tenant" }],
    });
  });

  it("projects the declared policy and tag edges into the graph", () => {
    const fixture = createInvalidatingApplication({ tenantScoped: true });
    const app = compileApp({ id: "cache-fixture", modules: fixture.modules });
    const read = app.graph.operations.find((node) => node.id === "widgets.list");
    const write = app.graph.operations.find((node) => node.id === "widgets.rename");
    expect(app.diagnostics).toEqual([]);
    expect(read?.cache).toEqual({
      ttlMs: 60_000,
      scope: "tenant",
      tags: ["widgets"],
      varies: false,
      backendId: "platform.cache",
      cacheControl: "private, max-age=60",
    });
    expect(write?.invalidates).toEqual(["widgets"]);
    expect(write?.invalidatesScoped).toEqual([{ tag: "widgets", scope: "tenant" }]);
    expect(
      app.graph.operations.find((node) => node.id === "ship-cache.invalidation.dispatch"),
    ).toBeDefined();
  });

  it("binds and exports the cache backend token when the invalidation module owns it", () => {
    const cache = createFakeCache();
    const read = defineOperation({
      id: "widgets.list",
      input: {},
      output: { 200: summarySchema },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { cache: cacheToken },
      cache: { ttlMs: 60_000, scope: "public", tags: ["widgets"] },
      handler: () => ({ total: 1 }),
    });
    const invalidation = defineCacheInvalidationModule({
      cache,
      outbox: createFakeOutbox(),
      backend: cacheToken,
    });
    expect(invalidation.exports).toContain(cacheToken);
    const app = compileApp({
      id: "cache-fixture",
      modules: [
        // The consumer module binds nothing: it imports ship-cache and uses the token.
        defineModule({
          id: "widgets",
          operations: [read],
          providers: [],
          imports: ["ship-cache"],
          exports: [],
        }),
        invalidation,
      ],
    });
    expect(app.graph.providers.find((node) => node.id === "platform.cache")).toMatchObject({
      moduleId: "ship-cache",
      lifetime: "singleton",
      scope: "cache",
    });
  });
});

describe("cacheInvalidationEffect", () => {
  it("is an immediate effect bound to the live cache backend", () => {
    expect(cacheInvalidationEffect).toMatchObject({
      id: "ship-cache.backend",
      scope: "effect",
      delivery: "immediate",
    });
  });
});
