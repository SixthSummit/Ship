import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "../errors/ValidationError.js";
import { getMetaTag, SCHEMA_META, type SchemaMeta } from "./metaTags.js";
import { validate } from "./validate.js";

describe("validate()", () => {
  it("returns a Hono middleware tagged with SCHEMA_META", () => {
    const schema = z.object({ name: z.string() });
    const mw = validate("json", schema, { description: "Create account body" });

    const tag = getMetaTag<SchemaMeta>(mw, SCHEMA_META);
    expect(tag).toBeDefined();
    expect(tag!.target).toBe("json");
    expect(tag!.schema).toBe(schema);
    expect(tag!.description).toBe("Create account body");
  });

  it("succeeds for a valid body and exposes typed valid() data", async () => {
    const app = new Hono();
    const schema = z.object({ name: z.string(), age: z.number() });

    app.post("/widgets", validate("json", schema), (c) => {
      const body = c.req.valid("json" as never) as { name: string; age: number };
      return c.json({ ok: true, body });
    });

    const res = await app.request("/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice", age: 30 }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, body: { name: "alice", age: 30 } });
  });

  it("throws ValidationError on a bad body so app.onError can format the response", async () => {
    const app = new Hono();
    const schema = z.object({ name: z.string(), age: z.number() });

    let captured: unknown;
    app.onError((err, c) => {
      captured = err;
      if (err instanceof ValidationError) return c.json({ message: err.message }, 400);
      return c.json({ message: "internal" }, 500);
    });

    app.post("/widgets", validate("json", schema), (c) => c.text("never"));

    const res = await app.request("/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice", age: "not-a-number" }),
    });

    expect(res.status).toBe(400);
    expect(captured).toBeInstanceOf(ValidationError);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/^age:/);
  });

  it("validates query strings with a query schema", async () => {
    const app = new Hono();
    const schema = z.object({ page: z.string().regex(/^\d+$/), limit: z.string().regex(/^\d+$/) });

    app.get("/widgets", validate("query", schema), (c) => {
      const q = c.req.valid("query" as never) as { page: string; limit: string };
      return c.json(q);
    });

    const ok = await app.request("/widgets?page=2&limit=10");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ page: "2", limit: "10" });

    const bad = await app.request("/widgets?page=abc&limit=10");
    expect(bad.status).toBe(500); // ValidationError isn't caught here (no onError)
  });

  it("the SCHEMA_META tag survives chaining into Hono routes (still readable)", () => {
    const schema = z.object({ q: z.string() });
    const mw = validate("query", schema);

    // The middleware itself is a function — tags live on the function object.
    expect(typeof mw).toBe("function");
    expect(getMetaTag<SchemaMeta>(mw, SCHEMA_META)?.target).toBe("query");
  });
});
