import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors/AppError.js";
import { AUTH_META, type AuthMeta, getMetaTag } from "../utils/metaTags.js";
import { apiKey } from "./apiKey.js";

function makeApp(): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message }, err.statusCode as 401 | 500);
    }
    return c.json({ message: (err as Error).message }, 500);
  });
  return app;
}

describe("apiKey()", () => {
  it("throws at construction time when secret is missing", () => {
    expect(() => apiKey({ secret: "" })).toThrow(/`secret` is required/);
  });

  it("attaches AUTH_META with providerName=api-key and required=true", () => {
    const mw = apiKey({ secret: "s" });
    const tag = getMetaTag<AuthMeta>(mw, AUTH_META);
    expect(tag).toEqual({ required: true, providerName: "api-key" });
  });

  it("calls next() when the request supplies a matching key in the default header", async () => {
    const app = makeApp();
    app.get("/wh", apiKey({ secret: "shh" }), (c) => c.json({ ok: true }));

    const res = await app.request("/wh", { headers: { "x-api-key": "shh" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("supports a custom header name (case-insensitive)", async () => {
    const app = makeApp();
    app.get("/wh", apiKey({ secret: "shh", headerName: "X-Custom-Token" }), (c) => c.json({}));

    const res = await app.request("/wh", { headers: { "x-custom-token": "shh" } });
    expect(res.status).toBe(200);
  });

  it("returns 401 when the header is missing", async () => {
    const app = makeApp();
    app.get("/wh", apiKey({ secret: "shh" }), (c) => c.json({}));

    const res = await app.request("/wh");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("AUTHENTICATION_ERROR");
    expect(body.message).toMatch(/x-api-key/);
  });

  it("returns 401 when the header value doesn't match", async () => {
    const app = makeApp();
    app.get("/wh", apiKey({ secret: "shh" }), (c) => c.json({}));

    const res = await app.request("/wh", { headers: { "x-api-key": "wrong" } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("AUTHENTICATION_ERROR");
    expect(body.message).toBe("Invalid API key");
  });

  it("returns 401 when keys differ in length (no length-leak via timing)", async () => {
    const app = makeApp();
    app.get("/wh", apiKey({ secret: "shh-long-secret" }), (c) => c.json({}));

    const res = await app.request("/wh", { headers: { "x-api-key": "x" } });
    expect(res.status).toBe(401);
  });
});
