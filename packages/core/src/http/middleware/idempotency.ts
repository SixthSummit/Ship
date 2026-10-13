import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { Cache } from "../../app/services/cache/Cache.js";
import { logger as defaultLogger } from "../../observability/logger.js";
import { AppError } from "../errors/AppError.js";
import { ConflictError } from "../errors/ConflictError.js";
import { IDEMPOTENCY_META, type IdempotencyMeta, setMetaTag } from "../utils/metaTags.js";

/**
 * `idempotency({ cache, ttlSec, scope?, keyGenerator? })` — Stripe-style
 * `Idempotency-Key` header dedup.
 *
 * Usage: clients send `Idempotency-Key: <uuid>` on a mutating request. If the
 * server has already processed a request with that key (in the last `ttlSec`
 * seconds), the previously-recorded response is replayed verbatim — same
 * status, same headers, same body. Safely retryable network failures, in
 * other words.
 *
 * Pipeline (per request bearing an Idempotency-Key):
 *
 *   1. Compose cache key: `idempotency:<scope>:<actor>:<idempotency-key>`.
 *   2. Hash the canonical request: sha256(method + path + sortedQuery + body).
 *   3. Look up the cache:
 *      - If a finalized entry exists for the same hash → replay it.
 *      - If a finalized entry exists for a *different* hash → 422
 *        (key reused with different payload — Stripe behavior).
 *      - If a "pending" sentinel exists → 409 (concurrent in-flight). The
 *        client should retry; the typical SDK auto-retries.
 *      - If absent → claim the key with a pending sentinel via
 *        `cache.setIfAbsent`, then run the handler.
 *   4. After the handler completes (success or AppError), capture the
 *      response (status, headers, body) and replace the pending sentinel
 *      with the finalized entry.
 *
 * Requests without an Idempotency-Key header pass through unchanged. Apply
 * this middleware to mutating routes that should be idempotent (POST that
 * creates resources, payment flows, anything not safely retried otherwise).
 *
 * Tagged `IDEMPOTENCY_META` so `createApp` populates the route registry.
 *
 * Limitations (documented for adopters):
 * - Response body is captured as text. Streamed / very-large bodies will
 *   bloat the cache; consider `maxBodyBytes` (TODO future). Default rejects
 *   bodies > 256 KB silently (the request runs once but isn't replayable).
 * - The pending-sentinel concurrency policy returns 409 immediately
 *   instead of blocking. Stripe blocks; we don't, to keep the dependency
 *   surface narrow. Most SDKs handle 409 with retry/backoff.
 */

const HEADER = "idempotency-key";
const SENTINEL_PENDING = "__pending__";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export interface StoredIdempotencyEntry {
  /** Hash of the canonical request — used to detect "key reused with different payload". */
  requestHash: string;
  status: number;
  headers: Record<string, string>;
  /** Response body as text. `null` if the body was too large to cache. */
  body: string | null;
  bodyTooLarge?: boolean;
  /** Wall-clock ms when this entry was recorded. Surfaced in replay headers. */
  recordedAt: number;
}

export interface IdempotencyOptions {
  /** Cache backend. Production: RedisCache. Tests: InMemoryCache. */
  cache: Cache;
  /** Window for replay. Stripe defaults to 24 h. */
  ttlSec?: number;
  /**
   * Bucket namespace appended after `idempotency:`. Default `"global"`.
   */
  scope?: string;
  /**
   * Compose the actor portion of the cache key. Defaults to
   * `c.get('user').id` or `'anon'`. Override for API-key-based clients.
   */
  keyGenerator?: (c: Context) => string;
  /**
   * Cap on the request/response body size that will be cached + replayed.
   * Defaults to 256 KB. Larger bodies still execute the request once but
   * the response isn't stored for replay (a flag is recorded so the second
   * request gets a 200 with a `X-Idempotency-Replay-Lost: true` header).
   */
  maxBodyBytes?: number;
  /** Override the framework default pino logger. */
  logger?: typeof defaultLogger;
}

function defaultKeyGenerator(c: Context): string {
  const user = c.get("user" as never) as { id?: string } | undefined;
  return user?.id ? `user:${user.id}` : "anon";
}

function hashRequest(method: string, path: string, query: string, body: string): string {
  const h = createHash("sha256");
  h.update(method);
  h.update("|");
  h.update(path);
  h.update("|");
  h.update(query);
  h.update("|");
  h.update(body);
  return h.digest("hex");
}

function sortedQuery(c: Context): string {
  const url = new URL(c.req.url);
  const entries = [...url.searchParams.entries()];
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

async function readRequestBody(
  c: Context,
  max: number,
): Promise<{ text: string; tooLarge: boolean }> {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return { text: "", tooLarge: false };
  }
  // Hono caches the body — calling text() multiple times is safe.
  const text = await c.req.text();
  return { text, tooLarge: text.length > max };
}

export function idempotency(opts: IdempotencyOptions): MiddlewareHandler {
  const ttlSec = opts.ttlSec ?? 24 * 60 * 60;
  const scope = opts.scope ?? "global";
  const keyGen = opts.keyGenerator ?? defaultKeyGenerator;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = opts.logger ?? defaultLogger;

  const middleware: MiddlewareHandler = async (c, next) => {
    const idemKey = c.req.header(HEADER);
    if (!idemKey) return next();

    const actor = keyGen(c);
    const cacheKey = `idempotency:${scope}:${actor}:${idemKey}`;

    const { text: bodyText, tooLarge: requestTooLarge } = await readRequestBody(c, maxBodyBytes);
    const requestHash = hashRequest(c.req.method, c.req.path, sortedQuery(c), bodyText);

    // 1. Look up existing entry
    const existing = await opts.cache.get<StoredIdempotencyEntry | typeof SENTINEL_PENDING>(
      cacheKey,
    );

    if (existing === SENTINEL_PENDING) {
      // Concurrent request with same key still in flight
      throw new ConflictError(
        "Idempotent request already in flight for this Idempotency-Key. Retry after a short delay.",
      );
    }

    if (existing) {
      const entry = existing as StoredIdempotencyEntry;
      if (entry.requestHash !== requestHash) {
        // Different payload under the same key — Stripe returns 422
        throw new IdempotencyKeyReusedError(
          "Idempotency-Key was reused with a different request payload",
        );
      }
      // Replay
      log.debug({ idemKey: idemKey.slice(0, 8) }, "idempotency.replay");
      const headers = new Headers(entry.headers);
      headers.set("X-Idempotency-Replay", "true");
      headers.set("X-Idempotency-Recorded-At", new Date(entry.recordedAt).toISOString());
      if (entry.bodyTooLarge) headers.set("X-Idempotency-Replay-Lost", "true");
      return new Response(entry.body ?? "", {
        status: entry.status,
        headers,
      });
    }

    // 2. Try to claim with a pending sentinel. Use a short TTL on the
    //    sentinel so a crashed handler doesn't permanently block retries.
    const claimed = await opts.cache.setIfAbsent(cacheKey, SENTINEL_PENDING, { ttlSec: 60 });
    if (!claimed) {
      // Lost the race — another request just landed. Treat as concurrent.
      throw new ConflictError(
        "Idempotent request already in flight for this Idempotency-Key. Retry after a short delay.",
      );
    }

    // 3. Execute the handler. Hono's compose intercepts thrown errors and
    //    routes them through `app.onError`, so by the time `await next()`
    //    returns, c.res is the (possibly error-) response and c.error is
    //    the original throw if any.
    try {
      await next();
    } catch (err) {
      // Only reached if NO error handler is registered (vanilla Hono throw).
      // Drop the sentinel so a retry can run again.
      await opts.cache.del(cacheKey);
      throw err;
    }

    const downstreamErr = (c as unknown as { error?: unknown }).error;

    // Non-AppError downstream failure: this was an unexpected exception
    // (probably a code defect). Don't replay it — drop the sentinel so a
    // retry can run fresh, and let Hono surface the error response normally.
    if (downstreamErr !== undefined && !(downstreamErr instanceof AppError)) {
      await opts.cache.del(cacheKey);
      return;
    }

    // Capture c.res for storage. AppErrors that flowed through
    // `registerErrorHandlers` produce a real Response in c.res, so this
    // works for both success and AppError paths — failures can be idempotent.
    const responseClone = c.res.clone();
    const bodyBuf = Buffer.from(await responseClone.arrayBuffer());
    const responseTooLarge = bodyBuf.length > maxBodyBytes;

    const headers: Record<string, string> = {};
    c.res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    const entry: StoredIdempotencyEntry = {
      requestHash,
      status: c.res.status,
      headers,
      body: responseTooLarge || requestTooLarge ? null : bodyBuf.toString("utf8"),
      bodyTooLarge: responseTooLarge || requestTooLarge,
      recordedAt: Date.now(),
    };

    // Replace the pending sentinel with the finalized entry.
    await opts.cache.set(cacheKey, entry, { ttlSec });

    // c.res already holds the handler's response.
    return undefined;
  };

  const tag: IdempotencyMeta = { ttlSec, scope };
  setMetaTag(middleware, IDEMPOTENCY_META, tag);

  return middleware;
}

/**
 * Thrown when an Idempotency-Key is reused with a different request payload.
 * Stripe returns 422 here; we match.
 */
export class IdempotencyKeyReusedError extends AppError {
  constructor(message = "Idempotency-Key was reused with a different request payload") {
    super(message, 422, "IDEMPOTENCY_KEY_REUSED");
  }
}
