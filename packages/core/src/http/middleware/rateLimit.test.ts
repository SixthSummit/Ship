import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { InMemorySlidingWindowBackend } from "../../app/services/rateLimit/InMemorySlidingWindowBackend.js";
import type { RateLimitBackend } from "../../app/services/rateLimit/RateLimitBackend.js";
import { registerErrorHandlers } from "../app/errors.js";
import { AppError } from "../errors/AppError.js";
import { RateLimitError } from "../errors/RateLimitError.js";
import { getMetaTag, RATE_LIMIT_META, type RateLimitMeta } from "../utils/metaTags.js";
import { rateLimit } from "./rateLimit.js";

function silentLogger() {
  return pino({ level: "silent" }, { write: () => true });
}

function makeApp(mw: ReturnType<typeof rateLimit>): Hono {
  const app = new Hono();
  registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
  app.use("*", mw);
  app.get("/r", (c) => c.json({ ok: true }));
  app.post("/r", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimit — construction guards", () => {
  it("throws when windowMs <= 0", () => {
    const backend = new InMemorySlidingWindowBackend();
    expect(() => rateLimit({ windowMs: 0, max: 1, backend })).toThrow(/positive/);
  });

  it("throws when max <= 0", () => {
    const backend = new InMemorySlidingWindowBackend();
    expect(() => rateLimit({ windowMs: 1, max: 0, backend })).toThrow(/positive/);
  });
});

describe("rateLimit — metadata tag", () => {
  it("attaches RATE_LIMIT_META with windowMs / max / scope", () => {
    const backend = new InMemorySlidingWindowBackend();
    const mw = rateLimit({ windowMs: 60_000, max: 5, scope: "login", backend });
    const tag = getMetaTag<RateLimitMeta>(mw, RATE_LIMIT_META);
    expect(tag).toEqual({ windowMs: 60_000, max: 5, scope: "login" });
  });
});

describe("rateLimit — happy path", () => {
  it("allows requests up to max, then 429s", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const app = makeApp(rateLimit({ windowMs: 60_000, max: 3, backend, logger: silentLogger() }));

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/r", { headers: { "x-forwarded-for": "1.2.3.4" } });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request("/r", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("emits RFC-draft RateLimit-* headers on every response", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const app = makeApp(rateLimit({ windowMs: 60_000, max: 5, backend, logger: silentLogger() }));
    const res = await app.request("/r", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res.headers.get("ratelimit-limit")).toBe("5");
    expect(res.headers.get("ratelimit-remaining")).toBe("4");
    expect(res.headers.get("ratelimit-policy")).toBe("5;w=60");
  });

  it("emits legacy X-RateLimit-* headers when legacyHeaders: true", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const app = makeApp(
      rateLimit({ windowMs: 60_000, max: 5, backend, legacyHeaders: true, logger: silentLogger() }),
    );
    const res = await app.request("/r", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res.headers.get("x-ratelimit-limit")).toBe("5");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(res.headers.get("x-ratelimit-reset")).toBeTruthy();
  });

  it("sets Retry-After on 429 responses", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const app = makeApp(rateLimit({ windowMs: 60_000, max: 1, backend, logger: silentLogger() }));

    await app.request("/r", { headers: { "x-forwarded-for": "1.2.3.4" } });
    const blocked = await app.request("/r", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const retryAfter = Number.parseInt(blocked.headers.get("retry-after") ?? "0", 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("rateLimit — key generation", () => {
  it("isolates buckets per IP (with trustProxy + simulated peer)", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const app = makeApp(
      rateLimit({
        windowMs: 60_000,
        max: 1,
        backend,
        // Simulate a trusted upstream proxy so XFF is honored — the
        // post-F2 default ignores XFF entirely unless `trustProxy` is set.
        trustProxy: ["127.0.0.0/8"],
        resolvePeerIp: () => "127.0.0.1",
        logger: silentLogger(),
      }),
    );

    // First IP exhausts its quota
    await app.request("/r", { headers: { "x-forwarded-for": "1.1.1.1" } });
    const blockedFirst = await app.request("/r", { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(blockedFirst.status).toBe(429);

    // Second IP is fresh
    const otherIp = await app.request("/r", { headers: { "x-forwarded-for": "2.2.2.2" } });
    expect(otherIp.status).toBe(200);
  });

  it("prefers user ID over IP when c.get('user') is set", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const app = new Hono();
    registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });

    app.use("*", async (c, next) => {
      const uid = c.req.header("x-stub-user");
      if (uid) c.set("user" as never, { id: uid } as never);
      return next();
    });
    app.use("*", rateLimit({ windowMs: 60_000, max: 1, backend, logger: silentLogger() }));
    app.get("/r", (c) => c.json({}));

    // Exhaust user-1 from any IP
    await app.request("/r", { headers: { "x-stub-user": "u-1", "x-forwarded-for": "1.1.1.1" } });
    const blocked = await app.request("/r", {
      headers: { "x-stub-user": "u-1", "x-forwarded-for": "9.9.9.9" }, // different IP, same user
    });
    expect(blocked.status).toBe(429);

    // user-2 is fresh
    const otherUser = await app.request("/r", { headers: { "x-stub-user": "u-2" } });
    expect(otherUser.status).toBe(200);
  });

  it("respects a custom keyGenerator", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const mw = rateLimit({
      windowMs: 60_000,
      max: 1,
      backend,
      keyGenerator: (c) => `apikey:${c.req.header("x-api-key") ?? "anon"}`,
      logger: silentLogger(),
    });
    const app = makeApp(mw);

    await app.request("/r", { headers: { "x-api-key": "abc" } });
    const blocked = await app.request("/r", { headers: { "x-api-key": "abc" } });
    expect(blocked.status).toBe(429);

    const otherKey = await app.request("/r", { headers: { "x-api-key": "xyz" } });
    expect(otherKey.status).toBe(200);
  });

  it("scope namespaces buckets so two limiters on different scopes don't share", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const loginLimiter = rateLimit({
      windowMs: 60_000,
      max: 1,
      scope: "login",
      backend,
      logger: silentLogger(),
    });
    const generalLimiter = rateLimit({
      windowMs: 60_000,
      max: 1,
      backend,
      logger: silentLogger(),
    });

    const app = new Hono();
    registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
    app.post("/login", loginLimiter, (c) => c.json({ ok: true }));
    app.post("/other", generalLimiter, (c) => c.json({ ok: true }));

    // Exhaust /login
    await app.request("/login", { method: "POST", headers: { "x-forwarded-for": "1.1.1.1" } });
    const blockedLogin = await app.request("/login", {
      method: "POST",
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    expect(blockedLogin.status).toBe(429);

    // /other (different scope, same IP) is independent
    const other = await app.request("/other", {
      method: "POST",
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    expect(other.status).toBe(200);
  });
});

describe("rateLimit — backend failure policy", () => {
  function failingBackend(): RateLimitBackend {
    return {
      check: async () => {
        throw new Error("redis down");
      },
    };
  }

  it("default 'deny' fails closed with 429 when backend errors", async () => {
    const app = makeApp(
      rateLimit({ windowMs: 60_000, max: 5, backend: failingBackend(), logger: silentLogger() }),
    );
    const res = await app.request("/r", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(body.error.message).toMatch(/unavailable/i);
  });

  it("'allow' fails open: passes through with no enforcement", async () => {
    const app = makeApp(
      rateLimit({
        windowMs: 60_000,
        max: 5,
        backend: failingBackend(),
        onBackendError: "allow",
        logger: silentLogger(),
      }),
    );
    const res = await app.request("/r", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res.status).toBe(200);
  });
});

describe("rateLimit — XFF spoofing defense (F2)", () => {
  /**
   * `assertSameBucket` and `assertDifferentBuckets` test bucket
   * collisions by attacking the underlying counter. `max: 1` means
   * the second hit to the same bucket gets 429; a different bucket
   * gets 200. The XFF / peer combinations explore the algorithm.
   */
  async function probe(
    opts: {
      trustProxy?: readonly string[];
      peerIp?: string;
    } = {},
    requests: Array<{ xff?: string }>,
  ) {
    const backend = new InMemorySlidingWindowBackend();
    const mw = rateLimit({
      windowMs: 60_000,
      max: 1,
      backend,
      trustProxy: opts.trustProxy,
      resolvePeerIp: () => opts.peerIp,
      logger: silentLogger(),
    });
    const app = makeApp(mw);
    const statuses: number[] = [];
    for (const req of requests) {
      const headers: Record<string, string> = {};
      if (req.xff != null) headers["x-forwarded-for"] = req.xff;
      const res = await app.request("/r", { headers });
      statuses.push(res.status);
    }
    return statuses;
  }

  it("default (no trustProxy): XFF is ignored, peer wins — different XFFs collide on the same peer", async () => {
    const statuses = await probe(
      { peerIp: "203.0.113.1" }, // same peer for both
      [{ xff: "1.1.1.1" }, { xff: "2.2.2.2" }],
    );
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(429); // same bucket via peer
  });

  it("default (no trustProxy): no peer means everyone shares ip:unknown", async () => {
    const statuses = await probe(
      {}, // no peer, no trust list
      [{ xff: "1.1.1.1" }, { xff: "2.2.2.2" }],
    );
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(429);
  });

  it("trusted peer: XFF wins — different XFFs get separate buckets", async () => {
    const statuses = await probe({ trustProxy: ["10.0.0.0/8"], peerIp: "10.0.0.5" }, [
      { xff: "1.1.1.1" },
      { xff: "2.2.2.2" },
    ]);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(200); // different buckets
  });

  it("trusted peer: same XFF collides", async () => {
    const statuses = await probe({ trustProxy: ["10.0.0.0/8"], peerIp: "10.0.0.5" }, [
      { xff: "1.1.1.1" },
      { xff: "1.1.1.1" },
    ]);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(429);
  });

  it("untrusted peer: XFF is rejected — peer-bucket collisions ignore XFF", async () => {
    // Peer 8.8.8.8 is NOT in 10.0.0.0/8 — attacker contacting the
    // server directly cannot inject XFF to dodge the rate limit.
    const statuses = await probe({ trustProxy: ["10.0.0.0/8"], peerIp: "8.8.8.8" }, [
      { xff: "1.1.1.1" },
      { xff: "2.2.2.2" },
    ]);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(429); // both bucket on peer 8.8.8.8
  });

  it("rightmost-untrusted-IP walk skips trusted hops in XFF", async () => {
    // Chain: client(1.1.1.1) → trusted(10.0.0.6) → trusted-peer(10.0.0.5).
    // Walker should pick 1.1.1.1.
    const statuses = await probe({ trustProxy: ["10.0.0.0/8"], peerIp: "10.0.0.5" }, [
      { xff: "1.1.1.1, 10.0.0.6" },
      { xff: "1.1.1.1, 10.0.0.7" },
    ]);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(429); // same real client 1.1.1.1
  });

  it("IPv6 trust list: peer ::1 trusted, XFF wins", async () => {
    const statuses = await probe({ trustProxy: ["::1/128"], peerIp: "::1" }, [
      { xff: "2001:db8::1" },
      { xff: "2001:db8::2" },
    ]);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(200);
  });

  it("IPv4-mapped IPv6 peer is normalized for trust matching", async () => {
    // Node's IncomingMessage frequently surfaces ::ffff:127.0.0.1 for
    // a v4 socket. A v4 trust list MUST cover this.
    const statuses = await probe({ trustProxy: ["127.0.0.0/8"], peerIp: "::ffff:127.0.0.1" }, [
      { xff: "1.1.1.1" },
      { xff: "2.2.2.2" },
    ]);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(200); // peer trusted, XFF wins
  });

  it("malformed XFF entries are skipped; remaining hops still apply", async () => {
    const statuses = await probe({ trustProxy: ["10.0.0.0/8"], peerIp: "10.0.0.5" }, [
      { xff: "garbage, 1.1.1.1" },
      { xff: "junk, 1.1.1.1" },
    ]);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(429); // both bucket on 1.1.1.1
  });

  it("zero-bit CIDR (0.0.0.0/0) trusts every peer — testing-only escape hatch", async () => {
    const statuses = await probe({ trustProxy: ["0.0.0.0/0"], peerIp: "8.8.8.8" }, [
      { xff: "1.1.1.1" },
      { xff: "2.2.2.2" },
    ]);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(200); // XFF honored
  });

  it("malformed trustProxy entries are silently dropped (no crash)", () => {
    const backend = new InMemorySlidingWindowBackend();
    expect(() =>
      rateLimit({
        windowMs: 60_000,
        max: 1,
        backend,
        trustProxy: ["10.0.0.0/8", "not-a-cidr", "999.999.999.999/8"],
        logger: silentLogger(),
      }),
    ).not.toThrow();
  });
});

describe("RateLimitError taxonomy", () => {
  it("is an AppError subclass with statusCode 429 and code RATE_LIMIT_EXCEEDED", () => {
    const err = new RateLimitError(60);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(err.retryAfterSec).toBe(60);
  });
});
