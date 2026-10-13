import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors/AppError.js";
import { csrf } from "./csrf.js";

// 32-char base64url tokens, matching the framework's `generateToken()`
// output shape. F25 rejects wrong-length values before the
// constant-time compare.
const TOKEN_A = "abcdefghijklmnopqrstuvwxyz012345"; // 32 chars
const TOKEN_B = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; // 32 chars

function makeApp(mw: ReturnType<typeof csrf>): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message }, err.statusCode as 401 | 403);
    }
    return c.json({ message: (err as Error).message }, 500);
  });
  app.use("*", mw);
  app.get("/r", (c) => c.json({ ok: true }));
  app.post("/r", (c) => c.json({ ok: true }));
  app.delete("/r", (c) => c.json({ ok: true }));
  return app;
}

describe("csrf — construction guards", () => {
  it("throws when allowedOrigins is empty", () => {
    expect(() => csrf({ allowedOrigins: [] })).toThrow(/non-empty/);
  });
});

describe("csrf — default (Origin-check) mode", () => {
  it("lets safe-method requests through without an Origin header", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"] }));
    const res = await app.request("/r");
    expect(res.status).toBe(200);
  });

  it("rejects POST without an Origin / Referer header", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"] }));
    const res = await app.request("/r", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/missing Origin/);
  });

  it("rejects POST with a disallowed Origin", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"] }));
    const res = await app.request("/r", {
      method: "POST",
      headers: { origin: "https://attacker.example.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("attacker.example.com");
  });

  it("accepts POST with an allowed Origin", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"] }));
    const res = await app.request("/r", {
      method: "POST",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
  });

  it("derives the origin from Referer when Origin is absent", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"] }));
    const res = await app.request("/r", {
      method: "POST",
      headers: { referer: "https://app.example.com/some/path" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects POST with Sec-Fetch-Site: cross-site even when Origin is allowed", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"] }));
    const res = await app.request("/r", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(res.status).toBe(403);
  });

  it("treats a malformed Referer URL as 'no origin'", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"] }));
    const res = await app.request("/r", {
      method: "POST",
      headers: { referer: "not-a-valid-url" },
    });
    expect(res.status).toBe(403);
  });
});

describe("csrf — double-submit mode", () => {
  it("issues a csrf token cookie on a safe request when none exists", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"], doubleSubmit: true }));
    const res = await app.request("/r");
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ship_csrf=");
  });

  it("does NOT reissue the token when one is already present", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"], doubleSubmit: true }));
    const res = await app.request("/r", { headers: { cookie: "ship_csrf=existing-token" } });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain("ship_csrf=");
  });

  it("rejects POST when the cookie is missing", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"], doubleSubmit: true }));
    const res = await app.request("/r", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        "x-csrf-token": "some-token",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/cookie/);
  });

  it("rejects POST when the X-CSRF-Token header is missing", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"], doubleSubmit: true }));
    const res = await app.request("/r", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        cookie: "ship_csrf=abc",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/header/);
  });

  it("rejects POST when the cookie and header values mismatch", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"], doubleSubmit: true }));
    const res = await app.request("/r", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        cookie: `ship_csrf=${TOKEN_A}`,
        "x-csrf-token": TOKEN_B,
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/mismatch/);
  });

  it("accepts POST when cookie === header (double-submit succeeds)", async () => {
    const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"], doubleSubmit: true }));
    const res = await app.request("/r", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        cookie: `ship_csrf=${TOKEN_A}`,
        "x-csrf-token": TOKEN_A,
      },
    });
    expect(res.status).toBe(200);
  });

  it("supports a custom cookie name + header name", async () => {
    const app = makeApp(
      csrf({
        allowedOrigins: ["https://app.example.com"],
        doubleSubmit: true,
        cookieName: "x_token",
        headerName: "x-token",
      }),
    );

    const safeRes = await app.request("/r");
    expect(safeRes.headers.get("set-cookie") ?? "").toContain("x_token=");

    const mutateRes = await app.request("/r", {
      method: "DELETE",
      headers: {
        origin: "https://app.example.com",
        cookie: `x_token=${TOKEN_A}`,
        "x-token": TOKEN_A,
      },
    });
    expect(mutateRes.status).toBe(200);
  });

  describe("F25 length validation + F24 origin well-formedness", () => {
    it("rejects POST when cookie length isn't 32 chars (truncated by buggy proxy)", async () => {
      const app = makeApp(
        csrf({ allowedOrigins: ["https://app.example.com"], doubleSubmit: true }),
      );
      const res = await app.request("/r", {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          cookie: "ship_csrf=short",
          "x-csrf-token": "short",
        },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/wrong length/);
    });

    it("rejects POST when both cookie + header are empty (short-circuit attempt)", async () => {
      const app = makeApp(
        csrf({ allowedOrigins: ["https://app.example.com"], doubleSubmit: true }),
      );
      const res = await app.request("/r", {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          cookie: "ship_csrf=",
          "x-csrf-token": "",
        },
      });
      // Hono's getCookie returns undefined for an empty value, which
      // trips the "missing cookie" path before the length check —
      // either rejection is acceptable. The point is: not 200.
      expect(res.status).toBe(403);
    });

    it("F24: malformed `Origin` header is rejected (no origin parsed)", async () => {
      const app = makeApp(csrf({ allowedOrigins: ["https://app.example.com"] }));
      const res = await app.request("/r", {
        method: "POST",
        headers: { origin: "javascript:alert(1)" },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/missing Origin/);
    });

    it("F24: origin comparison is case-insensitive (RFC 6454)", async () => {
      const app = makeApp(
        csrf({ allowedOrigins: ["https://App.Example.COM"], doubleSubmit: false }),
      );
      const res = await app.request("/r", {
        method: "POST",
        headers: { origin: "https://app.example.com" },
      });
      expect(res.status).toBe(200);
    });

    it("F24: non-http(s) scheme rejected even if listed verbatim", async () => {
      // An attacker can't get a `data:` origin past the URL parse
      // even if some bizarre operator config added it.
      const app = makeApp(csrf({ allowedOrigins: ["data://something"] }));
      const res = await app.request("/r", {
        method: "POST",
        headers: { origin: "data://something" },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("F27 — header-only mode", () => {
    it("does NOT issue a cookie on safe requests under headerOnly", async () => {
      const app = makeApp(
        csrf({
          allowedOrigins: ["https://app.example.com"],
          doubleSubmit: true,
          headerOnly: true,
        }),
      );
      const res = await app.request("/r");
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).not.toContain("ship_csrf=");
    });

    it("still verifies double-submit on mutating requests (consumer must supply both)", async () => {
      const app = makeApp(
        csrf({
          allowedOrigins: ["https://app.example.com"],
          doubleSubmit: true,
          headerOnly: true,
        }),
      );
      const res = await app.request("/r", {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          cookie: `ship_csrf=${TOKEN_A}`,
          "x-csrf-token": TOKEN_A,
        },
      });
      expect(res.status).toBe(200);
    });
  });
});
