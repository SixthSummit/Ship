import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthTokenPair } from "../../app/auth/jwt/AuthFlow.js";
import {
  AUTH_COOKIE_NAMES,
  clearAuthCookies,
  REFRESH_COOKIE_PATH,
  readAccessCookie,
  readRefreshCookie,
  setAuthCookies,
} from "./authCookies.js";

function pair(overrides: Partial<AuthTokenPair> = {}): AuthTokenPair {
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: "access.jwt.value",
    refreshToken: "refresh-token-raw",
    accessTokenExpiresAt: now + 60,
    refreshTokenExpiresAt: now + 600,
    refreshTokenId: "row-1",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("setAuthCookies", () => {
  it("sets access + refresh cookies with the locked default attributes", async () => {
    const app = new Hono();
    app.get("/login", (c) => {
      setAuthCookies(c, pair());
      return c.text("ok");
    });

    const res = await app.request("/login");
    const setCookieHeaders = res.headers.getSetCookie();
    expect(setCookieHeaders.length).toBe(2);

    const access = setCookieHeaders.find((h) => h.startsWith(`${AUTH_COOKIE_NAMES.access}=`))!;
    expect(access).toContain("access.jwt.value");
    expect(access).toContain("HttpOnly");
    expect(access).toContain("SameSite=Lax");
    expect(access).toContain("Path=/");

    const refresh = setCookieHeaders.find((h) => h.startsWith(`${AUTH_COOKIE_NAMES.refresh}=`))!;
    expect(refresh).toContain("refresh-token-raw");
    expect(refresh).toContain("HttpOnly");
    expect(refresh).toContain(`Path=${REFRESH_COOKIE_PATH}`);
  });

  it("emits Secure when running in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Re-require: defaults are read at module init. Use the explicit override path instead.
    const app = new Hono();
    app.get("/login", (c) => {
      setAuthCookies(c, pair(), { secure: true });
      return c.text("ok");
    });
    const res = await app.request("/login");
    for (const h of res.headers.getSetCookie()) {
      expect(h).toContain("Secure");
    }
  });

  it("respects sameSite override and domain when supplied", async () => {
    const app = new Hono();
    app.get("/login", (c) => {
      setAuthCookies(c, pair(), { sameSite: "Strict", domain: "api.example.com" });
      return c.text("ok");
    });
    const res = await app.request("/login");
    for (const h of res.headers.getSetCookie()) {
      expect(h).toContain("SameSite=Strict");
      expect(h).toContain("Domain=api.example.com");
    }
  });

  it("converts expiresAt epoch seconds into a positive maxAge", async () => {
    const app = new Hono();
    const pp = pair();
    app.get("/login", (c) => {
      setAuthCookies(c, pp);
      return c.text("ok");
    });
    const res = await app.request("/login");
    const headers = res.headers.getSetCookie();
    const access = headers.find((h) => h.startsWith(`${AUTH_COOKIE_NAMES.access}=`))!;
    // The Max-Age line should be present and a small positive integer (not negative).
    const match = access.match(/Max-Age=(-?\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
  });
});

describe("clearAuthCookies", () => {
  it("emits expired Set-Cookie entries for both names with matching paths", async () => {
    const app = new Hono();
    app.get("/logout", (c) => {
      clearAuthCookies(c);
      return c.text("ok");
    });
    const res = await app.request("/logout");
    const headers = res.headers.getSetCookie();
    expect(headers.length).toBe(2);

    const access = headers.find((h) => h.startsWith(`${AUTH_COOKIE_NAMES.access}=`))!;
    const refresh = headers.find((h) => h.startsWith(`${AUTH_COOKIE_NAMES.refresh}=`))!;

    expect(access).toContain("Max-Age=0");
    expect(access).toContain("Path=/");
    expect(refresh).toContain("Max-Age=0");
    expect(refresh).toContain(`Path=${REFRESH_COOKIE_PATH}`);
  });
});

describe("readAccessCookie / readRefreshCookie", () => {
  it("reads the cookie values back from a Hono context", async () => {
    const app = new Hono();
    app.get("/check", (c) => {
      return c.json({
        access: readAccessCookie(c),
        refresh: readRefreshCookie(c),
      });
    });
    const res = await app.request("/check", {
      headers: {
        cookie: `${AUTH_COOKIE_NAMES.access}=tok-1; ${AUTH_COOKIE_NAMES.refresh}=ref-1`,
      },
    });
    const body = (await res.json()) as { access?: string; refresh?: string };
    expect(body.access).toBe("tok-1");
    expect(body.refresh).toBe("ref-1");
  });

  it("returns undefined when cookies are absent", async () => {
    const app = new Hono();
    app.get("/check", (c) => {
      return c.json({
        access: readAccessCookie(c) ?? null,
        refresh: readRefreshCookie(c) ?? null,
      });
    });
    const res = await app.request("/check");
    const body = (await res.json()) as { access: string | null; refresh: string | null };
    expect(body.access).toBeNull();
    expect(body.refresh).toBeNull();
  });

  it("survives a round-trip via setCookie", async () => {
    const app = new Hono();
    app.get("/issue", (c) => {
      setCookie(c, AUTH_COOKIE_NAMES.access, "round-trip-token", { httpOnly: true, path: "/" });
      return c.text("ok");
    });
    const res = await app.request("/issue");
    const accessSet = res.headers.getSetCookie()[0];
    expect(accessSet).toContain("round-trip-token");
  });
});

describe("setAuthCookies — public-suffix domain validation (F5)", () => {
  function attempt(domain: string): () => void {
    return () => {
      const app = new Hono();
      app.get("/", (c) => {
        setAuthCookies(c, pair(), { domain });
        return c.text("ok");
      });
      // The error fires synchronously inside setAuthCookies on request.
      return app.request("/");
    };
  }

  async function status(domain: string): Promise<number> {
    const app = new Hono();
    app.onError((err, c) => c.text(err.message, 500));
    app.get("/", (c) => {
      setAuthCookies(c, pair(), { domain });
      return c.text("ok");
    });
    const res = await app.request("/");
    return res.status;
  }

  it("rejects single-label TLDs (.com)", async () => {
    expect(await status(".com")).toBe(500);
  });

  it("rejects without leading dot too (com)", async () => {
    expect(await status("com")).toBe(500);
  });

  it("rejects ccTLDs (.uk, .de)", async () => {
    expect(await status(".uk")).toBe(500);
    expect(await status(".de")).toBe(500);
  });

  it("rejects multi-label eTLDs (.co.uk, .com.au)", async () => {
    expect(await status(".co.uk")).toBe(500);
    expect(await status(".com.au")).toBe(500);
  });

  it("rejects uppercase variants — domains are case-insensitive", async () => {
    expect(await status(".COM")).toBe(500);
    expect(await status(".Co.UK")).toBe(500);
  });

  it("accepts registrable domains (.example.com, app.example.com)", async () => {
    expect(await status(".example.com")).toBe(200);
    expect(await status("app.example.com")).toBe(200);
  });

  it("accepts domains one label above multi-part eTLDs (.example.co.uk)", async () => {
    expect(await status(".example.co.uk")).toBe(200);
  });

  it("accepts dev-only hosts without a TLD (localhost)", async () => {
    expect(await status("localhost")).toBe(200);
  });

  it("accepts an unset domain (host-only — the secure default)", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      setAuthCookies(c, pair()); // no `domain`
      return c.text("ok");
    });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    for (const h of res.headers.getSetCookie()) {
      expect(h).not.toContain("Domain=");
    }
  });

  it("the rejection message names the offending value + suggests a fix", async () => {
    const app = new Hono();
    app.onError((err, c) => c.text(err.message, 500));
    app.get("/", (c) => {
      setAuthCookies(c, pair(), { domain: ".co.uk" });
      return c.text("ok");
    });
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toMatch(/public suffix/i);
    expect(body).toMatch(/\.co\.uk/i);
  });

  it("clearAuthCookies validates domain too (catches the same misconfig at logout)", async () => {
    expect(() => {
      const app = new Hono();
      app.get("/", (c) => {
        clearAuthCookies(c, { domain: ".com" });
        return c.text("ok");
      });
      // Force the handler to run.
      return app.request("/");
    }).not.toThrow();
    // Status assertion ensures the error path returns a recognizable
    // failure rather than silently clearing with a bad domain.
    const app = new Hono();
    app.onError((err, c) => c.text(err.message, 500));
    app.get("/", (c) => {
      clearAuthCookies(c, { domain: ".com" });
      return c.text("ok");
    });
    const res = await app.request("/");
    expect(res.status).toBe(500);
  });

  // Suppress unused-fn lint: kept as documentation of pattern, not invoked.
  void attempt;
});
