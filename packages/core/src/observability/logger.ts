import pino, { type Logger, type LoggerOptions } from "pino";
import { requestContextStore } from "../app/context/RequestContext.js";

// Re-export the context primitives so the logger module remains a one-stop
// import for code that wants both `logger` and request-context helpers, while
// keeping the canonical store in `app/context/RequestContext.ts`.
export {
  getRequestContext,
  type RequestContext,
  runWithRequestContext,
  setRequestContextField,
} from "../app/context/RequestContext.js";

/**
 * Structured logger built on pino. Replaces the v3 `Logger` console-wrapper.
 *
 * - **ND-JSON** in production; **pino-pretty** in dev / local.
 * - **Redaction** of standard secret-bearing paths (`Authorization`, cookies,
 *   `password`, `token`, `secret`, `apiKey`, Firebase / GCP credentials blobs).
 * - **Request context** propagation via the canonical framework-wide
 *   `AsyncLocalStorage` (see `app/context/RequestContext.ts`). Any code running
 *   inside `runWithRequestContext({ requestId, userId, tenantId }, fn)` gets
 *   those fields auto-attached to every log line via pino's `mixin`, without
 *   callsite changes. The same context flows into `DrizzleEntityService`
 *   lifecycle hooks (audit / CDC / multi-tenancy) — single SoT.
 * - Forward-compatible with `@opentelemetry/instrumentation-pino`, which
 *   auto-injects `trace_id` / `span_id` / `trace_flags` once the OTel SDK is
 *   running. No mixin work required there.
 */

const DEFAULT_REDACT_PATHS: readonly string[] = [
  // Top-level secret-bearing keys (pino's `*.foo` wildcard matches one level
  // of nesting, not top-level — list these separately).
  "password",
  "token",
  "secret",
  "apiKey",
  // Common one-level-nested locations (e.g., `user.password`, `body.token`).
  "*.password",
  "*.token",
  "*.secret",
  "*.apiKey",
  // Auth headers in their usual containers.
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  // App / framework keys with non-generic shapes.
  "firebaseCredentials",
  "gcpCredentialsJson",
  "FIREBASE_CREDENTIALS",
  "GCP_CREDENTIALS_JSON",
  "SESSION_SECRET",
];

function isPrettyEnvByDefault(): boolean {
  const env = process.env.ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "";
  return env === "local" || env === "dev" || env === "development" || env === "";
}

export interface CreateLoggerOptions {
  /** Override log level. Defaults to `LOG_LEVEL` env then `"info"`. */
  level?: pino.Level;
  /**
   * Custom destination (anything pino accepts: a stream, a file path via
   * `pino.destination`, a sonic-boom instance, or any object with a `write`
   * method). Useful for tests.
   */
  destination?: pino.DestinationStream;
  /**
   * Force pino-pretty mode regardless of env. Set `false` to force ND-JSON
   * in dev (e.g., when running under a log-aggregating supervisor).
   */
  pretty?: boolean;
  /**
   * Extra redaction paths to *add* to the framework defaults. Use this for
   * domain-specific secret keys (e.g., third-party webhook signatures).
   */
  extraRedactPaths?: readonly string[];
}

function buildOptions(opts: CreateLoggerOptions): LoggerOptions {
  const redactPaths = opts.extraRedactPaths
    ? [...DEFAULT_REDACT_PATHS, ...opts.extraRedactPaths]
    : DEFAULT_REDACT_PATHS;

  return {
    level: opts.level ?? (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info",
    redact: {
      paths: [...redactPaths],
      censor: "[REDACTED]",
    },
    mixin() {
      const ctx = requestContextStore.getStore();
      if (!ctx) return {};
      const out: Record<string, unknown> = {};
      if (ctx.requestId !== undefined) out.requestId = ctx.requestId;
      if (ctx.userId !== undefined) out.userId = ctx.userId;
      if (ctx.tenantId !== undefined) out.tenantId = ctx.tenantId;
      if (ctx.extra) Object.assign(out, ctx.extra);
      return out;
    },
  };
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const options = buildOptions(opts);

  // Explicit destination wins (test hook).
  if (opts.destination) {
    return pino(options, opts.destination);
  }

  const usePretty = opts.pretty ?? isPrettyEnvByDefault();
  if (usePretty) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
          singleLine: false,
        },
      },
    });
  }

  // Production / staging: ND-JSON to stdout (pino default).
  return pino(options);
}

/**
 * Default framework-wide logger. Most callsites should import this and either
 * use it directly or call `logger.child({ module: "<name>" })` for a scoped
 * sub-logger.
 */
export const logger: Logger = createLogger();
