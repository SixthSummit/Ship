import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { getRequestContext, runWithRequestContext } from "../../app/context/RequestContext.js";
import { AUTH_CONTEXT_KEYS } from "./requireAuth.js";
import { resolveTenant } from "./resolveTenant.js";

/**
 * Mirror `httpLogger`: establish a `RequestContext` so `setRequestContextField`
 * has a store to mutate (it returns `false` outside an active context).
 */
function withContext(): MiddlewareHandler {
  return async (_c, next) => runWithRequestContext({}, () => next());
}

function setUser(account: Record<string, unknown>): MiddlewareHandler {
  return async (c, next) => {
    c.set(AUTH_CONTEXT_KEYS.user as never, account as never);
    return next();
  };
}

describe("resolveTenant", () => {
  it("publishes the account's tenantId to RequestContext (Model A default)", async () => {
    const app = new Hono();
    app.use("*", withContext());
    app.use("*", setUser({ id: "a-1", tenantId: "11111111-1111-4111-8111-111111111111" }));
    app.use("*", resolveTenant());
    let seen: string | undefined;
    app.get("/x", (c) => {
      seen = getRequestContext()?.tenantId;
      return c.json({ ok: true });
    });

    const res = await app.request("/x");
    expect(res.status).toBe(200);
    expect(seen).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("uses a custom resolver when provided (e.g. a tenant header)", async () => {
    const app = new Hono();
    app.use("*", withContext());
    app.use("*", resolveTenant({ resolve: (c) => c.req.header("x-tenant-id") }));
    let seen: string | undefined;
    app.get("/x", (c) => {
      seen = getRequestContext()?.tenantId;
      return c.json({ ok: true });
    });

    await app.request("/x", { headers: { "x-tenant-id": "tenant-from-header" } });
    expect(seen).toBe("tenant-from-header");
  });

  it("a custom resolver returning null leaves tenantId unset", async () => {
    const app = new Hono();
    app.use("*", withContext());
    app.use("*", resolveTenant({ resolve: () => null }));
    let seen: string | undefined = "untouched";
    app.get("/x", (c) => {
      seen = getRequestContext()?.tenantId;
      return c.json({ ok: true });
    });

    await app.request("/x");
    expect(seen).toBeUndefined();
  });

  it("leaves tenantId unset when nothing resolves (single-tenant / no account)", async () => {
    const app = new Hono();
    app.use("*", withContext());
    app.use("*", resolveTenant());
    let seen: string | undefined = "untouched";
    app.get("/x", (c) => {
      seen = getRequestContext()?.tenantId;
      return c.json({ ok: true });
    });

    await app.request("/x");
    expect(seen).toBeUndefined();
  });
});
