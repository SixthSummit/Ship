import type { MiddlewareHandler } from "hono";
import { runWithRequestContext } from "../../app/context/RequestContext.js";
import { logger as defaultLogger, type RequestContext } from "../../observability/logger.js";

/**
 * `httpLogger()` — request-scoped logging + RequestContext binding.
 *
 * On each request:
 * 1. Resolves a request ID (incoming `X-Request-Id` header, else a fresh
 *    UUID). Mirrors the value back on the response as `X-Request-Id`.
 * 2. Wraps `next()` inside `runWithRequestContext({ requestId, ... })` so
 *    the framework-wide pino logger auto-attaches `requestId` to every
 *    log line emitted by downstream middleware / handlers / services /
 *    DrizzleEntityService lifecycle hooks. No callsite changes.
 * 3. Logs one structured line per request at completion:
 *    `info` for 2xx/3xx/4xx, `error` for 5xx, with `{method, path, status,
 *    durationMs}` plus the bound `requestId`.
 *
 * Replaces v3's `RequestIdMiddleware` + ad-hoc console logging. Designed
 * to run *first* in the middleware chain (before auth, validation, etc.)
 * so every log line generated downstream gets the request ID.
 */

export interface HttpLoggerOptions {
  /** Override the framework default pino logger. */
  logger?: typeof defaultLogger;
  /** Header name to read for the incoming request ID. Default `"x-request-id"`. */
  headerName?: string;
  /**
   * Override request-ID generation. Default is `crypto.randomUUID()`.
   * Useful for tests that want deterministic IDs.
   */
  generateId?: () => string;
  /**
   * Log a "request received" line at debug level on entry. Default `false`
   * because it doubles log volume; enable when you need to see timing of
   * slow upstream middleware (auth, body parsing).
   */
  logStart?: boolean;
}

const DEFAULT_HEADER = "x-request-id";

/**
 * Query-string keys whose VALUES are redacted in log emission. Case-
 * insensitive match — `Token`, `TOKEN`, `token` all redact.
 *
 * The pino redactor (`packages/core/src/observability/logger.ts`)
 * covers structured fields like `headers.authorization` and
 * `body.password`, but URL query parameters arrive as a single
 * string that the redactor can't see into. This list closes that
 * gap defensively — consumers SHOULDN'T put secrets in query strings,
 * but recovery / reset / signed-URL / share / OAuth flows commonly
 * do anyway. Anything that lands here also leaks to observability
 * stacks (Stackdriver, Datadog, Loki) by default.
 *
 * Documented in `.cursor/rules/security.mdc`. Keep in sync with the
 * pino redactor's body-side list.
 */
const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  "token",
  "signature",
  "sig",
  "key",
  "secret",
  "code",
  "state",
  "password",
  "passwd",
  "pwd",
  "apikey",
  "api_key",
  "auth",
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "session",
  "sessionid",
  "session_id",
]);

const REDACTED = "<redacted>";

/**
 * Parse the URL's query string into a redacted key→value map. Returns
 * `undefined` when there's no query, so the caller can omit the field
 * entirely (cleaner log lines than `query: {}` everywhere).
 */
function parseQueryRedacted(rawUrl: string): Record<string, string> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "http://localhost.invalid");
  } catch {
    return undefined;
  }
  if (parsed.search.length <= 1) return undefined; // "" or "?"

  const out: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) {
    out[k] = SENSITIVE_QUERY_KEYS.has(k.toLowerCase()) ? REDACTED : v;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

export function httpLogger(opts: HttpLoggerOptions = {}): MiddlewareHandler {
  const log = opts.logger ?? defaultLogger;
  const headerName = (opts.headerName ?? DEFAULT_HEADER).toLowerCase();
  const generateId = opts.generateId ?? (() => globalThis.crypto.randomUUID());

  const middleware: MiddlewareHandler = async (c, next) => {
    const requestId = c.req.header(headerName) ?? generateId();
    c.header("X-Request-Id", requestId);
    c.set("requestId" as never, requestId as never);

    const ctx: RequestContext = { requestId };
    const start = performance.now();

    if (opts.logStart) {
      runWithRequestContext(ctx, () => {
        log.debug({ method: c.req.method, path: c.req.path }, "http.request.start");
      });
    }

    let thrown: unknown;
    try {
      await runWithRequestContext(ctx, async () => {
        await next();
      });
    } catch (err) {
      thrown = err;
    }

    const durationMs = Math.round(performance.now() - start);
    const status = c.res?.status ?? (thrown ? 500 : 200);
    const query = parseQueryRedacted(c.req.url);
    const fields = {
      method: c.req.method,
      path: c.req.path,
      ...(query ? { query } : {}),
      status,
      durationMs,
      requestId,
    };

    runWithRequestContext(ctx, () => {
      if (thrown !== undefined) {
        log.error({ ...fields, err: thrown }, "http.request.error");
      } else if (status >= 500) {
        log.error(fields, "http.request");
      } else {
        log.info(fields, "http.request");
      }
    });

    if (thrown !== undefined) throw thrown;
  };

  return middleware;
}
