import type { Context, MiddlewareHandler } from "hono";
import type { RateLimitBackend } from "../../app/services/rateLimit/RateLimitBackend.js";
import { logger as defaultLogger } from "../../observability/logger.js";
import { RateLimitError } from "../errors/RateLimitError.js";
import { compileTrustProxy, type ParsedCidr, resolveClientIp } from "../utils/clientIp.js";
import { RATE_LIMIT_META, type RateLimitMeta, setMetaTag } from "../utils/metaTags.js";

/**
 * `rateLimit({ windowMs, max, ... })` — Hono middleware factory.
 *
 * Replaces v3's in-memory `RateLimitMiddleware`. Production-default backend
 * is `RedisSlidingWindowBackend` (atomic Lua sliding-window log); v4.0 also
 * ships `InMemorySlidingWindowBackend` for tests + dev fallback.
 *
 * Headers (RFC-draft `RateLimit-*`):
 *   - `RateLimit-Limit: <max>`
 *   - `RateLimit-Remaining: <max - used>`
 *   - `RateLimit-Policy: <max>;w=<window-seconds>`
 * Optional legacy headers (`X-RateLimit-Limit/Remaining/Reset`) emitted when
 * `legacyHeaders: true` for clients that haven't moved to the draft yet.
 *
 * On rejection: throws `RateLimitError` (mapped to 429 by registerErrorHandlers)
 * after setting `Retry-After: <seconds>`. The middleware sets headers on the
 * outgoing response *before* throwing so the 429 response carries them.
 *
 * Redis-unavailable behavior is configurable, NOT a silent fallback:
 *   - `'deny'` (default, fail-closed) — returns RateLimitError as if the
 *     ceiling were exceeded. Safer default; the user gets a real 429
 *     instead of unintentional unlimited access.
 *   - `'allow'` (fail-open) — calls next() without enforcement. Logs a
 *     warning so operators can detect Redis flapping.
 *
 * Tagged `RATE_LIMIT_META` so `createApp` populates the route registry.
 */

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per key per window. */
  max: number;
  /** Backend implementation. Default: a shared in-memory backend; production
   *  consumers pass a `RedisSlidingWindowBackend`. */
  backend: RateLimitBackend;
  /**
   * Compose the bucket key from the request. Default: authenticated user
   * ID (from `c.get('user').id`) when set, else the client IP. The request
   * path is *not* included by default — for per-route limits, instantiate
   * a separate `rateLimit({...})` per route.
   */
  keyGenerator?: (c: Context) => string;
  /**
   * Namespace appended to the bucket key (e.g., `"login"` for a tighter
   * limiter on `POST /accounts/login`). Default: empty.
   */
  scope?: string;
  /**
   * Behavior when the backend throws (e.g., Redis unreachable):
   *   - `'deny'` (default): treat as over-limit, throw RateLimitError.
   *   - `'allow'`: log a warning, call next() without enforcement.
   *
   * **F28 — security note on `'allow'`.** `onBackendError: 'allow'`
   * **removes rate limiting entirely** during any window where the
   * backend is unavailable — login / signup / password-reset
   * endpoints become unbounded for the duration of the outage. Don't
   * pick `'allow'` as a workaround for flaky Redis: fix Redis first
   * (HA failover, connection pool tuning, a separate Redis tier
   * for rate-limit state). Choose `'allow'` only with a deliberate
   * threat-model decision that the availability cost of brief
   * unlimited access during outages outweighs the security cost.
   * Common deployments where `'allow'` is defensible: internal-only
   * APIs behind VPN auth where rate limiting is UX-shaping rather
   * than security; public APIs with WAF-layer rate limiting
   * upstream. Public-facing SaaS authentication endpoints are
   * exactly where `'allow'` is wrong.
   */
  onBackendError?: "allow" | "deny";
  /** Emit `X-RateLimit-*` headers in addition to the RFC draft `RateLimit-*` set. */
  legacyHeaders?: boolean;
  /** Override the framework default pino logger. */
  logger?: typeof defaultLogger;
  /**
   * CIDR allowlist for upstream proxies. The default key generator
   * trusts `X-Forwarded-For` **only** when the immediate peer's IP
   * falls inside one of these ranges; otherwise XFF is ignored and
   * the peer IP wins. The framework default is the empty list — the
   * secure, fail-closed posture for adopters who haven't declared
   * their topology.
   *
   * In production, set this to the public CIDR ranges of your CDN /
   * load balancer (Cloudflare, AWS ALB, Fastly, Google Cloud Armor,
   * etc.). The rightmost-untrusted-IP walker then returns the real
   * client IP from XFF, skipping each known proxy hop.
   *
   * Example (Cloudflare, abbreviated):
   *   `trustProxy: ["173.245.48.0/20", "103.21.244.0/22", "2400:cb00::/32", ...]`
   *
   * `["0.0.0.0/0", "::/0"]` trusts every peer — useful in unit tests
   * where the peer IP cannot be observed, **never** in production.
   */
  trustProxy?: readonly string[];
  /**
   * Resolve the immediate peer IP from the Hono `Context`. Default:
   * read `c.env.incoming.socket.remoteAddress` (Node adapter). Tests
   * and non-Node runtimes (Cloudflare, Deno, Bun) override this with
   * an env-specific reader.
   */
  resolvePeerIp?: (c: Context) => string | undefined;
}

function defaultResolvePeerIp(c: Context): string | undefined {
  // Node adapter exposes the underlying IncomingMessage via `c.env.incoming`.
  // Cloudflare / Deno / Bun runtimes pass `resolvePeerIp` explicitly.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function makeDefaultKeyGenerator(
  trustList: readonly ParsedCidr[],
  resolvePeerIp: (c: Context) => string | undefined,
): (c: Context) => string {
  return (c: Context) => {
    // Prefer authenticated user when present — auth-bound limits are
    // never affected by IP trust, since the key is identity-based.
    const user = c.get("user" as never) as { id?: string } | undefined;
    if (user?.id) return `user:${user.id}`;

    const peerIp = resolvePeerIp(c);
    const xff = c.req.header("x-forwarded-for");
    return `ip:${resolveClientIp({ peerIp, xff, trustProxy: trustList })}`;
  };
}

function setHeaders(
  c: Context,
  used: number,
  limit: number,
  windowMs: number,
  resetAtMs: number,
  legacy: boolean,
): void {
  const remaining = Math.max(0, limit - used);
  const windowSec = Math.ceil(windowMs / 1000);
  const resetEpochSec = Math.ceil(resetAtMs / 1000);

  // RFC-draft headers (draft-ietf-httpapi-ratelimit-headers-10).
  c.header("RateLimit-Limit", String(limit));
  c.header("RateLimit-Remaining", String(remaining));
  c.header("RateLimit-Policy", `${limit};w=${windowSec}`);

  if (legacy) {
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetEpochSec));
  }
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  if (opts.windowMs <= 0 || opts.max <= 0) {
    throw new Error("rateLimit(): windowMs and max must be positive");
  }

  const trustList = compileTrustProxy(opts.trustProxy);
  const resolvePeerIp = opts.resolvePeerIp ?? defaultResolvePeerIp;
  const keyGen = opts.keyGenerator ?? makeDefaultKeyGenerator(trustList, resolvePeerIp);
  const onBackendError = opts.onBackendError ?? "deny";
  const log = opts.logger ?? defaultLogger;
  const scopePrefix = opts.scope ? `${opts.scope}:` : "";

  const middleware: MiddlewareHandler = async (c, next) => {
    const key = scopePrefix + keyGen(c);
    const now = Date.now();

    let result;
    try {
      result = await opts.backend.check({
        key,
        windowMs: opts.windowMs,
        max: opts.max,
        now,
      });
    } catch (err) {
      // Backend failure (e.g., Redis down). Apply the configured policy.
      log.warn({ err, key, policy: onBackendError }, "ratelimit.backend_error");
      if (onBackendError === "allow") return next();
      // 'deny' — fail closed
      const retryAfterSec = Math.max(1, Math.ceil(opts.windowMs / 1000));
      throw new RateLimitError(retryAfterSec, "Rate limiter unavailable");
    }

    setHeaders(
      c,
      result.used,
      result.limit,
      opts.windowMs,
      result.resetAtMs,
      opts.legacyHeaders ?? false,
    );

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.resetAtMs - now) / 1000));
      c.header("Retry-After", String(retryAfterSec));
      throw new RateLimitError(retryAfterSec);
    }

    return next();
  };

  const tag: RateLimitMeta = {
    windowMs: opts.windowMs,
    max: opts.max,
    scope: opts.scope,
  };
  setMetaTag(middleware, RATE_LIMIT_META, tag);

  return middleware;
}
