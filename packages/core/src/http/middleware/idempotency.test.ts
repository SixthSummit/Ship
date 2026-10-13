import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { InMemoryCache } from "../../app/services/cache/InMemoryCache.js";
import { registerErrorHandlers } from "../app/errors.js";
import { AppError } from "../errors/AppError.js";
import { getMetaTag, IDEMPOTENCY_META, type IdempotencyMeta } from "../utils/metaTags.js";
import { IdempotencyKeyReusedError, idempotency } from "./idempotency.js";

function silentLogger() {
  return pino({ level: "silent" }, { write: () => true });
}

function buildApp() {
  const cache = new InMemoryCache();
  const app = new Hono();
  registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
  app.use("*", idempotency({ cache, ttlSec: 60, logger: silentLogger() }));

  let creates = 0;
  app.post("/orders", async (c) => {
    creates += 1;
    const body = (await c.req.json().catch(() => ({}))) as { sku?: string };
    return c.json({ id: `order-${creates}`, sku: body.sku ?? "default" }, 201);
  });

  app.post("/fail", async () => {
    throw new AppError("custom failure", 502, "UPSTREAM_DOWN");
  });

  app.post("/explode", async () => {
    throw new Error("uncaught");
  });

  return {
    app,
    cache,
    get creates() {
      return creates;
    },
  };
}

describe("idempotency — metadata tag", () => {
  it("attaches IDEMPOTENCY_META with ttlSec + scope", () => {
    const cache = new InMemoryCache();
    const mw = idempotency({ cache, ttlSec: 3600, scope: "payments" });
    const tag = getMetaTag<IdempotencyMeta>(mw, IDEMPOTENCY_META);
    expect(tag).toEqual({ ttlSec: 3600, scope: "payments" });
  });
});

describe("idempotency — pass-through when no header is present", () => {
  it("requests without Idempotency-Key are not deduped", async () => {
    const ctx = buildApp();
    await ctx.app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "A" }),
    });
    await ctx.app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "A" }),
    });
    expect(ctx.creates).toBe(2);
  });
});

describe("idempotency — replay", () => {
  it("replays the stored response for a repeated key + same body", async () => {
    const ctx = buildApp();
    const first = await ctx.app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "ik-1",
      },
      body: JSON.stringify({ sku: "A" }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.text();

    const second = await ctx.app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "ik-1",
      },
      body: JSON.stringify({ sku: "A" }),
    });
    expect(second.status).toBe(201);
    expect(await second.text()).toBe(firstBody);
    // Handler ran exactly once
    expect(ctx.creates).toBe(1);
    // Replay marker on the second response
    expect(second.headers.get("x-idempotency-replay")).toBe("true");
    expect(second.headers.get("x-idempotency-recorded-at")).toBeTruthy();
  });

  it("isolates keys across actors (default keyGenerator)", async () => {
    // Two requests with the same Idempotency-Key but different IPs/users
    // must NOT replay each other. Default keyGenerator uses `c.get('user')`
    // and falls back to "anon" — to test isolation we set different users.
    const cache = new InMemoryCache();
    const app = new Hono();
    registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
    app.use("*", async (c, next) => {
      const u = c.req.header("x-stub-user");
      if (u) c.set("user" as never, { id: u } as never);
      return next();
    });
    app.use("*", idempotency({ cache, ttlSec: 60, logger: silentLogger() }));

    let creates = 0;
    app.post("/orders", (c) => {
      creates += 1;
      return c.json({ id: creates }, 201);
    });

    await app.request("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": "shared", "x-stub-user": "u-1" },
    });
    await app.request("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": "shared", "x-stub-user": "u-2" },
    });
    expect(creates).toBe(2);
  });
});

describe("idempotency — key reuse with different payload", () => {
  it("rejects with 422 IdempotencyKeyReusedError", async () => {
    const ctx = buildApp();
    await ctx.app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "ik-2" },
      body: JSON.stringify({ sku: "A" }),
    });
    const reused = await ctx.app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "ik-2" },
      body: JSON.stringify({ sku: "DIFFERENT" }),
    });
    expect(reused.status).toBe(422);
    const body = (await reused.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("idempotency — concurrent requests with same key", () => {
  it("returns 409 when a pending sentinel exists", async () => {
    // Manually plant a pending sentinel to simulate an in-flight request.
    const cache = new InMemoryCache();
    await cache.set("idempotency:global:anon:ik-3", "__pending__", { ttlSec: 60 });

    const app = new Hono();
    registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
    app.use("*", idempotency({ cache, ttlSec: 60, logger: silentLogger() }));
    app.post("/orders", (c) => c.json({ id: "x" }, 201));

    const res = await app.request("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": "ik-3" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT_ERROR");
  });
});

describe("idempotency — error propagation", () => {
  it("AppError responses are also cached + replayed (failures can be idempotent)", async () => {
    const ctx = buildApp();
    const first = await ctx.app.request("/fail", {
      method: "POST",
      headers: { "Idempotency-Key": "ik-fail" },
    });
    expect(first.status).toBe(502);

    // Replay should also be a 502 with the same body. The handler should
    // NOT run twice (we'd be double-burning a flaky upstream).
    const second = await ctx.app.request("/fail", {
      method: "POST",
      headers: { "Idempotency-Key": "ik-fail" },
    });
    expect(second.status).toBe(502);
    expect(second.headers.get("x-idempotency-replay")).toBe("true");
  });

  it("unknown errors drop the pending sentinel so a retry can run again", async () => {
    const ctx = buildApp();
    // First request: handler throws Error (non-AppError). Sentinel released.
    const first = await ctx.app.request("/explode", {
      method: "POST",
      headers: { "Idempotency-Key": "ik-explode" },
    });
    // registerErrorHandlers turns it into a 500 with INTERNAL_SERVER_ERROR
    expect(first.status).toBe(500);

    // Second request with the same key should NOT see a pending sentinel
    // (we cleaned up). It should run again and again hit the same error.
    const second = await ctx.app.request("/explode", {
      method: "POST",
      headers: { "Idempotency-Key": "ik-explode" },
    });
    expect(second.status).toBe(500);
    // No replay header — the second call ran fresh
    expect(second.headers.get("x-idempotency-replay")).toBeNull();
  });
});

describe("IdempotencyKeyReusedError taxonomy", () => {
  it("is an AppError subclass with statusCode 422 and code IDEMPOTENCY_KEY_REUSED", () => {
    const err = new IdempotencyKeyReusedError();
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});
