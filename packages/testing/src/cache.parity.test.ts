import { cached, InMemoryCache } from "@sixthsummit/ship-api";
import {
  cacheBackendDependency,
  createExecutor,
  createTenantScopeAuthority,
  defineApp,
  defineModule,
  defineOperation,
  operationActor,
  permission,
  valueProvider,
} from "@sixthsummit/ship-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInMemoryCacheBackend } from "./cache.js";

/**
 * Compatibility `cached()` versus the declared read cache, on one read.
 *
 * The value a caller observes must be identical. The difference is who owns
 * the key: `cached()` takes a consumer-supplied string, so a consumer that
 * forgets the tenant in that string leaks one tenant's read to another. The
 * declared cache derives the key from the authentic TenantScope, so the same
 * mistake is not expressible.
 */
describe("compatibility cached() and declared cache parity", () => {
  const tenants = createTenantScopeAuthority({
    id: "parity.tenant-policy",
    authorize: ({ actor, tenantId }) => actor.permissions?.has(`tenant:${tenantId}`) ?? false,
  });
  const alpha = operationActor({
    id: "actor-alpha",
    permissions: ["portfolio:read", "tenant:alpha"],
  });
  const beta = operationActor({
    id: "actor-beta",
    permissions: ["portfolio:read", "tenant:beta"],
  });
  const totals: Record<string, number> = { alpha: 11, beta: 22 };
  const cacheToken = cacheBackendDependency("platform.cache");

  function declaredApplication(load: (tenantId: string) => { total: number }) {
    const summary = defineOperation({
      id: "portfolio.summary",
      input: { params: z.object({ tenantId: z.string().min(1) }) },
      output: { 200: z.object({ total: z.number().int() }) },
      successStatus: 200,
      errors: [],
      access: permission("portfolio:read"),
      transaction: "none",
      dependencies: { cache: cacheToken },
      cache: {
        ttlMs: 60_000,
        scope: "tenant",
        tags: ["portfolio"],
        tenant: ({ input, context }) =>
          tenants.issue({
            tenantId: input.params.tenantId,
            requestId: context.requestId,
            actor: context.actor ?? alpha,
          }),
      },
      handler: ({ input }) => load(input.params.tenantId),
    });
    return createExecutor(
      defineApp({
        id: "parity-fixture",
        modules: [
          defineModule({
            id: "portfolio",
            operations: [summary],
            providers: [valueProvider(cacheToken, createInMemoryCacheBackend())],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );
  }

  it("returns the same value as the compatibility helper on hit and miss", async () => {
    const load = vi.fn((tenantId: string) => ({ total: totals[tenantId] ?? 0 }));
    const compat = new InMemoryCache();
    const executor = declaredApplication(load);

    const compatMiss = await cached(compat, "portfolio:alpha", 60, () => load("alpha"), {
      tags: ["portfolio"],
    });
    const compatHit = await cached(compat, "portfolio:alpha", 60, () => load("alpha"), {
      tags: ["portfolio"],
    });
    const declaredMiss = await executor.run(
      "portfolio.summary",
      { params: { tenantId: "alpha" } },
      { actor: alpha },
    );
    const declaredHit = await executor.run(
      "portfolio.summary",
      { params: { tenantId: "alpha" } },
      { actor: alpha },
    );

    expect(compatMiss).toEqual({ total: 11 });
    expect(compatHit).toEqual(compatMiss);
    expect(declaredMiss).toMatchObject({ ok: true, data: { total: 11 }, cache: "miss" });
    expect(declaredHit).toMatchObject({ ok: true, data: { total: 11 }, cache: "hit" });
    expect(declaredHit.ok && declaredHit.data).toEqual(compatHit);
  });

  it("declared keys refuse a cross-tenant hit that a hand-written key allows", async () => {
    const load = vi.fn((tenantId: string) => ({ total: totals[tenantId] ?? 0 }));
    const compat = new InMemoryCache();
    const executor = declaredApplication(load);

    // The compatibility key omits the tenant, which is the whole failure mode:
    // beta observes alpha's value.
    await cached(compat, "portfolio:summary", 60, () => load("alpha"));
    const leaked = await cached(compat, "portfolio:summary", 60, () => load("beta"));
    expect(leaked).toEqual({ total: 11 });

    await executor.run("portfolio.summary", { params: { tenantId: "alpha" } }, { actor: alpha });
    const isolated = await executor.run(
      "portfolio.summary",
      { params: { tenantId: "beta" } },
      { actor: beta },
    );
    expect(isolated).toMatchObject({ ok: true, data: { total: 22 }, cache: "miss" });
  });

  it("refuses to derive a key for an actor the tenant authority denies", async () => {
    const executor = declaredApplication(() => ({ total: 0 }));
    await expect(
      executor.run("portfolio.summary", { params: { tenantId: "alpha" } }, { actor: beta }),
    ).rejects.toThrow(/authentic cache scope/);
  });
});
