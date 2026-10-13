import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors/AppError.js";
import { AuthenticationError } from "../errors/AuthenticationError.js";
import { getMetaTag, PERMISSION_META, type PermissionMeta } from "../utils/metaTags.js";
import { requirePermission } from "./requirePermission.js";

interface FakeUser {
  id: string;
  hasPermission?: (slug: string) => boolean | Promise<boolean>;
}

function makeApp(): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message }, err.statusCode as 401 | 403 | 500);
    }
    return c.json({ message: (err as Error).message ?? "internal" }, 500);
  });
  return app;
}

describe("requirePermission", () => {
  it("throws when no slugs are supplied at construction time", () => {
    expect(() => requirePermission()).toThrow(/at least one slug/);
  });

  it("attaches PERMISSION_META with the supplied slugs", () => {
    const mw = requirePermission("a", "b", "c");
    const tag = getMetaTag<PermissionMeta>(mw, PERMISSION_META);
    expect(tag).toEqual({ permissions: ["a", "b", "c"] });
  });

  it("calls next() when the user has any of the slugs (OR semantics)", async () => {
    const user: FakeUser = { id: "a-1", hasPermission: vi.fn((s) => s === "widgets:read") };
    const app = makeApp();

    app.use("*", async (c, next) => {
      c.set("user" as never, user as never);
      return next();
    });

    app.get("/widgets", requirePermission("widgets:read", "admin:write"), (c) =>
      c.json({ ok: true }),
    );

    const res = await app.request("/widgets");
    expect(res.status).toBe(200);
    // OR short-circuits — both slugs may not have been checked
    expect(user.hasPermission).toHaveBeenCalledWith("widgets:read");
  });

  it("checks all supplied slugs when none match (no false short-circuit)", async () => {
    const hasPermission = vi.fn(async () => false);
    const user: FakeUser = { id: "a-1", hasPermission };
    const app = makeApp();

    app.use("*", async (c, next) => {
      c.set("user" as never, user as never);
      return next();
    });

    app.get("/widgets", requirePermission("a", "b", "c"), (c) => c.json({}));

    const res = await app.request("/widgets");
    expect(res.status).toBe(403);
    expect(hasPermission).toHaveBeenCalledTimes(3);
  });

  it("supports async hasPermission resolvers", async () => {
    const user: FakeUser = {
      id: "a-1",
      hasPermission: async (s) => s === "ok:slug",
    };
    const app = makeApp();
    app.use("*", async (c, next) => {
      c.set("user" as never, user as never);
      return next();
    });
    app.get("/x", requirePermission("ok:slug"), (c) => c.json({}));

    const res = await app.request("/x");
    expect(res.status).toBe(200);
  });

  it("throws 403 AuthorizationError when no slug matches", async () => {
    const user: FakeUser = { id: "a-1", hasPermission: () => false };
    const app = makeApp();
    app.use("*", async (c, next) => {
      c.set("user" as never, user as never);
      return next();
    });
    app.get("/x", requirePermission("admin:write"), (c) => c.json({}));

    const res = await app.request("/x");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string; code: string };
    expect(body.code).toBe("AUTHORIZATION_ERROR");
    expect(body.message).toContain("admin:write");
  });

  it("uses 'one of' phrasing when multiple slugs are required", async () => {
    const user: FakeUser = { id: "a-1", hasPermission: () => false };
    const app = makeApp();
    app.use("*", async (c, next) => {
      c.set("user" as never, user as never);
      return next();
    });
    app.get("/x", requirePermission("a", "b"), (c) => c.json({}));

    const res = await app.request("/x");
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/one of:\s*a, b/);
  });

  it("throws 401 AuthenticationError when no user is set on the context", async () => {
    const app = makeApp();
    app.get("/x", requirePermission("any"), (c) => c.json({}));

    const res = await app.request("/x");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("AUTHENTICATION_ERROR");
  });

  it("throws 500 when the user lacks a hasPermission method (configuration error)", async () => {
    const user: FakeUser = { id: "a-1" };
    const app = makeApp();
    app.use("*", async (c, next) => {
      c.set("user" as never, user as never);
      return next();
    });
    app.get("/x", requirePermission("any"), (c) => c.json({}));

    const res = await app.request("/x");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/hasPermission/);
  });

  it("multiple requirePermission middlewares behave as AND", async () => {
    const user: FakeUser = {
      id: "a-1",
      hasPermission: (s) => s === "widgets:read", // missing the second one
    };
    const app = makeApp();
    app.use("*", async (c, next) => {
      c.set("user" as never, user as never);
      return next();
    });
    app.get("/widgets", requirePermission("widgets:read"), requirePermission("admin:write"), (c) =>
      c.json({}),
    );

    const res = await app.request("/widgets");
    expect(res.status).toBe(403);
  });

  // Sanity import — keeps AuthenticationError visibly used in the test file
  it("AuthenticationError is part of the failure surface", () => {
    expect(AuthenticationError).toBeDefined();
  });
});
