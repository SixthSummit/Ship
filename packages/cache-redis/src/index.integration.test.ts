import { setTimeout as delay } from "node:timers/promises";
import {
  authenticatedAccess,
  type CacheBackend,
  cacheBackendDependency,
  cacheInvalidationOutbox,
  createExecutor,
  createTenantScopeAuthority,
  defineApp,
  defineCacheInvalidationModule,
  defineModule,
  defineOperation,
  operationActor,
  systemActor,
  type UnitOfWork,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { cacheBackendConformance } from "@sixthsummit/ship-testing/cache";
import { createInMemoryOutbox } from "@sixthsummit/ship-testing/outbox";
import Redis from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRedisCacheBackend } from "./index.js";

/**
 * The adapter against a real Redis. The unit suite proves the call shapes; this
 * proves the semantics we depend on — PX expiry, SADD/SMEMBERS tag sets, and
 * tag purges — behave as the declared contract assumes.
 */
describe("redis cache backend (real Redis)", () => {
  let container: StartedTestContainer;
  let client: Redis;
  let namespace = 0;

  beforeAll(async () => {
    container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) });
  }, 120_000);

  afterAll(async () => {
    await client?.quit().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

  for (const check of cacheBackendConformance(() => {
    namespace += 1;
    return createRedisCacheBackend({ client, keyPrefix: `conformance:${namespace}:` });
  })) {
    it(`conformance: ${check.name}`, async () => {
      await check.run();
    });
  }

  it("expires an entry on the server after its ttl", async () => {
    const backend = createRedisCacheBackend({ client, keyPrefix: "expiry:" });
    await backend.set("entry", { status: 200, data: 1 }, { ttlMs: 150 });
    expect(await backend.get("entry")).toEqual({ status: 200, data: 1 });
    expect(await client.pttl("expiry:entry")).toBeGreaterThan(0);
    await delay(300);
    expect(await backend.get("entry")).toBeUndefined();
    expect(await client.exists("expiry:entry")).toBe(0);
  });

  it("purges every member of a tag set and drops the set", async () => {
    const backend = createRedisCacheBackend({ client, keyPrefix: "tags:" });
    await backend.set("a", { status: 200, data: 1 }, { ttlMs: 60_000, tags: ["widgets"] });
    await backend.set("b", { status: 200, data: 2 }, { ttlMs: 60_000, tags: ["widgets"] });
    await backend.set("c", { status: 200, data: 3 }, { ttlMs: 60_000, tags: ["gadgets"] });
    expect(await client.smembers("tags:tag:widgets")).toHaveLength(2);

    await backend.delByTag("widgets");
    expect(await backend.get("a")).toBeUndefined();
    expect(await backend.get("b")).toBeUndefined();
    expect(await backend.get("c")).toEqual({ status: 200, data: 3 });
    expect(await client.exists("tags:tag:widgets")).toBe(0);
  });

  it("gives the tag set the entry ttl so bookkeeping never outlives the data", async () => {
    const backend = createRedisCacheBackend({ client, keyPrefix: "ttl:" });
    await backend.set("a", { status: 200, data: 1 }, { ttlMs: 5_000, tags: ["widgets"] });
    const ttl = await client.pttl("ttl:tag:widgets");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  it("reports a healthy server", async () => {
    const backend = createRedisCacheBackend({ client });
    expect(await backend.health()).toMatchObject({ available: true });
  });

  /**
   * Scoped invalidation end to end against Redis: a tenant's write records a
   * purge intent narrowed to its own scope key, the dispatcher performs it, and
   * the other tenant's entry (and every actor-scoped entry) stays warm.
   */
  it("purges only the writing tenant's entries when the write is tenant-scoped", async () => {
    const backend = createRedisCacheBackend({ client, keyPrefix: "scoped:tenant:" });
    const { executor, system } = scopedApplication(backend, "tenant");
    const alpha = actor("actor-a", "alpha");
    const beta = actor("actor-b", "beta");

    expect(await executor.run("widgets.list", {}, { actor: alpha })).toMatchObject({
      cache: "miss",
    });
    expect(await executor.run("widgets.list", {}, { actor: beta })).toMatchObject({
      cache: "miss",
    });
    expect(await client.smembers("scoped:tenant:tag:widgets")).toHaveLength(2);
    expect(await client.smembers("scoped:tenant:tag:widgets@tenant:salpha")).toHaveLength(1);

    expect(await executor.run("widgets.rename", {}, { actor: alpha })).toMatchObject({ ok: true });
    expect(await executor.run("ship-cache.invalidation.dispatch", {}, system)).toMatchObject({
      data: { claimed: 1, completed: 1 },
    });

    expect(await executor.run("widgets.list", {}, { actor: beta })).toMatchObject({ cache: "hit" });
    expect(await executor.run("widgets.list", {}, { actor: alpha })).toMatchObject({
      cache: "miss",
    });
    expect(await client.exists("scoped:tenant:tag:widgets@tenant:salpha")).toBe(1);
  });

  it("purges only the writing actor's entries when the write is actor-scoped", async () => {
    const backend = createRedisCacheBackend({ client, keyPrefix: "scoped:actor:" });
    const { executor, system } = scopedApplication(backend, "actor");
    const alpha = actor("actor-a", "alpha");
    const beta = actor("actor-b", "beta");

    await executor.run("widgets.list", {}, { actor: alpha });
    await executor.run("widgets.list", {}, { actor: beta });
    await executor.run("widgets.rename", {}, { actor: alpha });
    expect(await executor.run("ship-cache.invalidation.dispatch", {}, system)).toMatchObject({
      data: { claimed: 1, completed: 1 },
    });

    expect(await executor.run("widgets.list", {}, { actor: beta })).toMatchObject({ cache: "hit" });
    expect(await executor.run("widgets.list", {}, { actor: alpha })).toMatchObject({
      cache: "miss",
    });
  });
});

const cacheToken = cacheBackendDependency("platform.cache");
const transactionToken = unitOfWorkDependency<{ readonly scope: true }>("database.primary");
const tenants = createTenantScopeAuthority({
  id: "test.tenants",
  authorize: ({ actor, tenantId }) => actor.permissions?.has(`tenant:${tenantId}`) ?? false,
});

function actor(id: string, tenantId: string) {
  return operationActor({ id, permissions: [`tenant:${tenantId}`] });
}

/** A read and a write sharing one tag, both keyed by the same scope. */
function scopedApplication(backend: CacheBackend, scope: "actor" | "tenant") {
  const tenantOf = ({ context }: { context: { requestId: string; actor?: unknown } }) =>
    tenants.issue({
      tenantId: (context.actor as { id: string }).id === "actor-a" ? "alpha" : "beta",
      requestId: context.requestId,
      actor: context.actor as never,
    });
  const unitOfWork: UnitOfWork<{ readonly scope: true }> = {
    kind: "ship.unit-of-work",
    id: transactionToken.id,
    run: (_mode, work) => work({ scope: true }),
  };
  const read = defineOperation({
    id: "widgets.list",
    input: {},
    output: { 200: z.object({ total: z.number() }) },
    successStatus: 200,
    errors: [],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { cache: cacheToken },
    cache:
      scope === "tenant"
        ? { ttlMs: 60_000, scope: "tenant", tags: ["widgets"], tenant: tenantOf }
        : { ttlMs: 60_000, scope: "actor", tags: ["widgets"] },
    handler: () => ({ total: 1 }),
  });
  const write = defineOperation({
    id: "widgets.rename",
    input: {},
    output: { 200: z.object({ renamed: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: authenticatedAccess(),
    transaction: "write",
    dependencies: { tx: transactionToken },
    invalidates:
      scope === "tenant"
        ? [{ tag: "widgets", scope: "tenant", tenant: tenantOf }]
        : [{ tag: "widgets", scope: "actor" }],
    handler: () => ({ renamed: true as const }),
  });
  const widgets = defineModule({
    id: "widgets",
    operations: [read, write],
    providers: [valueProvider(transactionToken, unitOfWork)],
    imports: ["ship-cache"],
    exports: [],
  });
  const invalidation = defineCacheInvalidationModule({
    cache: backend,
    outbox: createInMemoryOutbox(cacheInvalidationOutbox),
    backend: cacheToken,
  });
  return {
    executor: createExecutor(defineApp({ id: "scoped-cache", modules: [widgets, invalidation] })),
    system: { actor: systemActor({ id: "dispatcher" }) },
  };
}
