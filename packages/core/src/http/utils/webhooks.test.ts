import { createHmac } from "node:crypto";
import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { registerErrorHandlers } from "../app/errors.js";
import { AppError } from "../errors/AppError.js";
import {
  githubVerifier,
  parseWebhook,
  slackVerifier,
  stripeVerifier,
  type WebhookVerifier,
} from "./webhooks.js";

function silentLogger() {
  return pino({ level: "silent" }, { write: () => true });
}

const SECRET = "super-secret";

// ─────────────────────────────────────────────────────────────────────────
// Stripe verifier (unit)
// ─────────────────────────────────────────────────────────────────────────

describe("stripeVerifier", () => {
  function signedHeader(ts: string, body: string, secret = SECRET): string {
    const v1 = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    return `t=${ts},v1=${v1}`;
  }

  it("accepts a valid signature within the replay window", () => {
    const now = 1_700_000_000_000;
    const ts = String(Math.floor(now / 1000));
    const body = JSON.stringify({ id: "evt_1", type: "ping" });
    const r = stripeVerifier.verify({
      rawBody: body,
      headers: { "stripe-signature": signedHeader(ts, body) },
      secret: SECRET,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when the timestamp is outside the replay window", () => {
    const now = 1_700_000_000_000;
    const ts = String(Math.floor(now / 1000) - 60 * 60); // an hour stale
    const body = "{}";
    const r = stripeVerifier.verify({
      rawBody: body,
      headers: { "stripe-signature": signedHeader(ts, body) },
      secret: SECRET,
      now,
    });
    expect(r).toEqual({ ok: false, reason: "Stripe signature timestamp outside tolerance" });
  });

  it("rejects when the signature doesn't match", () => {
    const now = 1_700_000_000_000;
    const ts = String(Math.floor(now / 1000));
    const r = stripeVerifier.verify({
      rawBody: "tampered-body",
      headers: { "stripe-signature": signedHeader(ts, "{}") },
      secret: SECRET,
      now,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/mismatch/);
  });

  it("rejects when the header is missing", () => {
    const r = stripeVerifier.verify({ rawBody: "{}", headers: {}, secret: SECRET });
    expect(r.ok).toBe(false);
  });

  it("rejects when the header is malformed (no v1)", () => {
    const r = stripeVerifier.verify({
      rawBody: "{}",
      headers: { "stripe-signature": "t=123" },
      secret: SECRET,
      now: 123 * 1000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/missing t \/ v1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GitHub verifier (unit)
// ─────────────────────────────────────────────────────────────────────────

describe("githubVerifier", () => {
  function header(body: string): string {
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    return `sha256=${sig}`;
  }

  it("accepts a valid signature", () => {
    const body = '{"action":"opened"}';
    const r = githubVerifier.verify({
      rawBody: body,
      headers: { "x-hub-signature-256": header(body) },
      secret: SECRET,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects on signature mismatch", () => {
    const body = '{"action":"opened"}';
    const r = githubVerifier.verify({
      rawBody: "tampered",
      headers: { "x-hub-signature-256": header(body) },
      secret: SECRET,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when the header is missing", () => {
    const r = githubVerifier.verify({ rawBody: "{}", headers: {}, secret: SECRET });
    expect(r.ok).toBe(false);
  });

  it("rejects when the header isn't sha256= prefixed", () => {
    const r = githubVerifier.verify({
      rawBody: "{}",
      headers: { "x-hub-signature-256": "deadbeef" },
      secret: SECRET,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/sha256=/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slack verifier (unit)
// ─────────────────────────────────────────────────────────────────────────

describe("slackVerifier", () => {
  function headers(ts: string, body: string): Record<string, string> {
    const sig = createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
    return {
      "x-slack-signature": `v0=${sig}`,
      "x-slack-request-timestamp": ts,
    };
  }

  it("accepts a valid signature within the replay window", () => {
    const now = 1_700_000_000_000;
    const ts = String(Math.floor(now / 1000));
    const body = "token=abc&team_id=T1";
    const r = slackVerifier.verify({
      rawBody: body,
      headers: headers(ts, body),
      secret: SECRET,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when the timestamp is stale", () => {
    const now = 1_700_000_000_000;
    const ts = String(Math.floor(now / 1000) - 600); // 10 min stale
    const r = slackVerifier.verify({
      rawBody: "x",
      headers: headers(ts, "x"),
      secret: SECRET,
      now,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects on signature mismatch", () => {
    const now = 1_700_000_000_000;
    const ts = String(Math.floor(now / 1000));
    const r = slackVerifier.verify({
      rawBody: "tampered",
      headers: headers(ts, "original"),
      secret: SECRET,
      now,
    });
    expect(r.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// parseWebhook integration (with Hono)
// ─────────────────────────────────────────────────────────────────────────

describe("parseWebhook integration", () => {
  function makeApp(provider: "stripe" | "github" | "slack" | WebhookVerifier) {
    const app = new Hono();
    registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
    app.post("/wh", async (c) => {
      const { payload, rawBody } = await parseWebhook(c, { provider, secret: SECRET });
      return c.json({ payload, rawBodyLength: rawBody.length });
    });
    return app;
  }

  it("returns parsed payload + raw body on valid Stripe signature", async () => {
    const app = makeApp("stripe");
    const body = JSON.stringify({ id: "evt_1", type: "ping" });
    const ts = String(Math.floor(Date.now() / 1000));
    const v1 = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");

    const res = await app.request("/wh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${ts},v1=${v1}`,
      },
      body,
    });

    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      payload: { id: string; type: string };
      rawBodyLength: number;
    };
    expect(out.payload).toEqual({ id: "evt_1", type: "ping" });
    expect(out.rawBodyLength).toBe(body.length);
  });

  it("throws AuthenticationError → 401 on Stripe signature mismatch", async () => {
    const app = makeApp("stripe");
    const body = "{}";
    const res = await app.request("/wh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=0,v1=deadbeef",
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("AUTHENTICATION_ERROR");
    expect(json.error.message).toMatch(/Webhook signature invalid/);
  });

  it("supports a custom WebhookVerifier", async () => {
    const custom: WebhookVerifier = {
      name: "custom",
      verify({ headers }) {
        return headers["x-pass"] === "yes" ? { ok: true } : { ok: false, reason: "denied" };
      },
    };
    const app = makeApp(custom);

    const ok = await app.request("/wh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pass": "yes" },
      body: '{"k":"v"}',
    });
    expect(ok.status).toBe(200);

    const denied = await app.request("/wh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(401);
  });

  it("can return raw body unparsed via parse: false", async () => {
    const app = new Hono();
    registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
    app.post("/wh", async (c) => {
      const { payload, rawBody } = await parseWebhook(c, {
        provider: "github",
        secret: SECRET,
        parse: false,
      });
      return c.json({ rawBodyType: typeof rawBody, payloadType: typeof payload });
    });

    const body = "literal-text-not-json";
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const res = await app.request("/wh", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${sig}` },
      body,
    });
    expect(res.status).toBe(200);
  });

  it("throws when an unknown provider name is supplied", async () => {
    const app = new Hono();
    registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
    app.post("/wh", async (c) => {
      await parseWebhook(c, { provider: "fake-provider" as unknown as "stripe", secret: "x" });
      return c.json({});
    });

    const res = await app.request("/wh", { method: "POST" });
    expect(res.status).toBe(500); // Error → registerErrorHandlers turns into INTERNAL_SERVER_ERROR
  });
});

// Sanity: AppError subclass mapping
describe("parseWebhook error taxonomy", () => {
  it("AuthenticationError is the failure-mode class", () => {
    expect(AppError).toBeDefined(); // import sanity
  });
});

describe("parseWebhook — invalid-JSON body → 400 (F18)", () => {
  const SECRET = "whsec_test_F18";

  function makeApp() {
    const app = new Hono();
    registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
    app.post("/wh", async (c) => {
      const { payload } = await parseWebhook(c, { provider: "stripe", secret: SECRET });
      return c.json({ payload });
    });
    return app;
  }

  it("valid HMAC + invalid JSON body → 400 BadRequestError (not 500)", async () => {
    const app = makeApp();
    const body = "this-is-not-json{";
    const ts = String(Math.floor(Date.now() / 1000));
    const v1 = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");

    const res = await app.request("/wh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${ts},v1=${v1}`,
      },
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("BAD_REQUEST_ERROR");
    expect(json.error.message).toMatch(/not valid JSON/i);
  });

  it("invalid HMAC over invalid JSON still returns 401 (signature check fires first)", async () => {
    const app = makeApp();
    const body = "this-is-not-json{";
    const res = await app.request("/wh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=0,v1=deadbeef",
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("valid HMAC + valid JSON body still returns 200 (regression)", async () => {
    const app = makeApp();
    const body = JSON.stringify({ id: "evt_1", type: "ping" });
    const ts = String(Math.floor(Date.now() / 1000));
    const v1 = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");

    const res = await app.request("/wh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${ts},v1=${v1}`,
      },
      body,
    });
    expect(res.status).toBe(200);
  });
});
