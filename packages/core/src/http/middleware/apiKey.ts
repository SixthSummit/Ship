import type { MiddlewareHandler } from "hono";
import { AuthenticationError } from "../errors/AuthenticationError.js";
import { AUTH_META, type AuthMeta, setMetaTag } from "../utils/metaTags.js";

/**
 * `apiKey({ secret, headerName? })` — minimal API-key gate for webhook /
 * machine-to-machine endpoints where Firebase token auth doesn't apply.
 *
 * Replaces v3's `ApiKeyMiddleware`. Differences:
 *
 * 1. Secret is passed in by the consumer (typically `env.WEBHOOKS_API_KEY`
 *    via `defineEnv`) rather than read directly from `process.env` —
 *    cleaner test stories, better stack tracing of misconfig.
 * 2. Throws `AuthenticationError` (mapped by `app.onError`) instead of
 *    returning a JSON response inline — keeps the response shape consistent
 *    with the rest of the framework.
 * 3. Tagged with `AUTH_META` (`providerName: "api-key"`) so the route
 *    registry shows the route is authenticated even though no AuthProvider
 *    is involved.
 *
 * Constant-time comparison via `crypto.timingSafeEqual` to avoid leaking
 * the secret length / first-mismatch position via timing side-channel.
 */

import { timingSafeEqual } from "node:crypto";

export interface ApiKeyOptions {
  /** The expected secret. Required. */
  secret: string;
  /** Header name to read. Default `"x-api-key"`. */
  headerName?: string;
}

/**
 * Constant-time-ish compare. F22: the mismatch-path dummy compares
 * the EXPECTED buffer against itself rather than the presented
 * buffer — so wall-clock execution time doesn't leak the *presented*
 * value's length (which an attacker controls). The secret's length is
 * fixed across requests and is not itself sensitive (length alone
 * doesn't reveal the secret), but biasing the timing channel toward
 * the controlled side is unambiguously better.
 *
 * `expected` MUST be the trusted side (the server-side secret).
 */
function safeCompare(expected: string, presented: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const presentedBuf = Buffer.from(presented);
  if (expectedBuf.length !== presentedBuf.length) {
    // Fixed-cost comparison over the *expected* buffer so the
    // attacker's input length can't bias the timing observation.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, presentedBuf);
}

export function apiKey(opts: ApiKeyOptions): MiddlewareHandler {
  if (!opts.secret) {
    throw new Error("apiKey(): `secret` is required");
  }

  const headerName = (opts.headerName ?? "x-api-key").toLowerCase();
  const expected = opts.secret;

  const middleware: MiddlewareHandler = async (c, next) => {
    const presented = c.req.header(headerName);
    if (!presented) {
      throw new AuthenticationError(`Missing ${headerName} header`);
    }
    // F22: pass expected as the first arg so the timing dummy on
    // mismatch operates over the trusted secret's length, not the
    // attacker-controlled presented value's length.
    if (!safeCompare(expected, presented)) {
      throw new AuthenticationError("Invalid API key");
    }
    return next();
  };

  const tag: AuthMeta = {
    required: true,
    providerName: "api-key",
  };
  setMetaTag(middleware, AUTH_META, tag);

  return middleware;
}
