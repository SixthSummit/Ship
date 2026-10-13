import type { Env, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger as defaultLogger } from "../../observability/logger.js";
import { AppError } from "../errors/AppError.js";
import { NotFoundError } from "../errors/NotFoundError.js";
import { ValidationError } from "../errors/ValidationError.js";

/**
 * `registerErrorHandlers(app, opts?)` — wires `app.onError` and `app.notFound`
 * so AppError throws from anywhere in the request chain produce a consistent
 * JSON shape. Replaces v3's `ErrorHandlerMiddleware`.
 *
 * Response shape (matches v3 for transition compat):
 *   {
 *     success: false,
 *     error: { code, message, details? },
 *     stack?: string, // development only
 *     name?: string,  // development only
 *   }
 *
 * - `AppError` subclasses → status from `error.statusCode`, `code` from
 *   `error.code`. `ValidationError.details` flows through.
 * - `HTTPException` (Hono native) → its status + a generic "HTTP_<status>"
 *   code; lets framework code throw `HTTPException` without having to
 *   wrap in AppError.
 * - Anything else → 500 with `INTERNAL_SERVER_ERROR`. The original message
 *   is logged but NOT exposed (avoid leaking internals to clients).
 *
 * 404s are routed through `app.notFound`, which throws a `NotFoundError`
 * so the same handler shape applies.
 */

export interface ErrorResponseShape {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  stack?: string;
  name?: string;
}

export interface RegisterErrorHandlersOptions {
  /** Override the framework default pino logger. */
  logger?: typeof defaultLogger;
  /** Force dev-mode debug fields (`stack`, `name`) in responses. Default
   *  is `process.env.NODE_ENV === "development"`. */
  exposeStack?: boolean;
}

function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

function buildResponse(err: AppError, exposeStack: boolean): ErrorResponseShape {
  const body: ErrorResponseShape = {
    success: false,
    error: {
      code: err.code,
      message: err.message,
    },
  };
  if (err instanceof ValidationError && err.details !== undefined) {
    body.error.details = err.details;
  }
  if (exposeStack) {
    body.stack = err.stack;
    body.name = err.name;
  }
  return body;
}

// Generic over the `Hono<E>` Env so consumers can pass a typed app
// (e.g. `Hono<AppEnv>`) without a cast. The error-handler logic only
// reads from `c.req` and `c.error` — nothing that depends on a
// specific Env shape — so widening the parameter is safe.
export function registerErrorHandlers<E extends Env>(
  app: Hono<E>,
  opts: RegisterErrorHandlersOptions = {},
): void {
  const log = opts.logger ?? defaultLogger;
  const exposeStack = opts.exposeStack ?? isDevelopment();

  app.notFound((c) => {
    const path = c.req.path;
    const method = c.req.method;
    const err = new NotFoundError(`Route ${method} ${path} not found`);
    const body = buildResponse(err, exposeStack);
    return c.json(body, err.statusCode as ContentfulStatusCode);
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      // Operational errors are expected — log at warn (4xx) or error (5xx).
      const fields = {
        method: c.req.method,
        path: c.req.path,
        status: err.statusCode,
        code: err.code,
        err,
      };
      if (err.statusCode >= 500) log.error(fields, "http.error");
      else log.warn(fields, "http.error");

      const body = buildResponse(err, exposeStack);
      return c.json(body, err.statusCode as ContentfulStatusCode);
    }

    if (err instanceof HTTPException) {
      // Hono native — thrown by router (e.g., `c.throw(403)`).
      const body: ErrorResponseShape = {
        success: false,
        error: {
          code: `HTTP_${err.status}`,
          message: err.message || `HTTP ${err.status}`,
        },
      };
      if (exposeStack) {
        body.stack = err.stack;
        body.name = err.name;
      }
      log.warn({ method: c.req.method, path: c.req.path, status: err.status }, "http.error");
      return c.json(body, err.status);
    }

    // Unknown error — log full details, return safe 500 to client.
    log.error(
      {
        method: c.req.method,
        path: c.req.path,
        err,
      },
      "http.error.unhandled",
    );

    const body: ErrorResponseShape = {
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    };
    if (exposeStack && err instanceof Error) {
      body.stack = err.stack;
      body.name = err.name;
    }
    return c.json(body, 500);
  });
}
