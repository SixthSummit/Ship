# Errors

> **Compatibility guide:** this page documents monolithic `AppError` and Hono
> handlers. New applications declare operation errors and receive the shared
> result/wire contract described in [Operations, HTTP, and validation](routes-and-validation.md).

The `AppError` taxonomy, why handlers should throw and never shape responses, the JSON shape `registerErrorHandlers` produces, and how validation errors carry their detail through to the client.

## Throw, don't shape

The contract:

> **Don't shape error responses inside handlers.** Throw an `AppError` subclass; let `registerErrorHandlers(app)` format the response.

A handler that does this:

```ts
// DON'T
async (c) => {
  const post = await postService.get(c.req.param("id"));
  if (!post) {
    return c.json({ success: false, error: { code: "NOT_FOUND", message: "..." } }, 404);
  }
  // ...
}
```

…spreads error-shaping logic across every handler, drifts inconsistently when the response shape evolves, and bypasses the framework's error logging. Instead:

```ts
// DO
async (c) => {
  const post = await postService.get(c.req.param("id"));
  if (!post) throw new NotFoundError("Post not found");
  // ...
}
```

The thrown error propagates to `registerErrorHandlers`, which maps it to a status code, formats the JSON body, and logs the failure with request-id + trace-id correlation. Handlers stay focused on the success path.

## The taxonomy

```ts
// packages/core/src/http/errors/
export class AppError extends Error { /* base — never throw directly */ }
```

| Class | Status | Code | Use case |
| --- | ---: | --- | --- |
| `NotFoundError` | 404 | `NOT_FOUND_ERROR` | Resource not found |
| `BadRequestError` | 400 | `BAD_REQUEST_ERROR` | Generic bad request |
| `ValidationError` | 400 | `VALIDATION_ERROR` | Input validation failed; carries `details` (Zod issues) |
| `AuthenticationError` | 401 | `AUTHENTICATION_ERROR` | Missing or invalid credential |
| `AuthorizationError` | 403 | `AUTHORIZATION_ERROR` | Authenticated but not allowed |
| `ConflictError` | 409 | `CONFLICT_ERROR` | Duplicate key, version conflict, etc. |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` | Carries `retryAfterSec` |
| `AppError` | 500 | `INTERNAL_SERVER_ERROR` | Base — only thrown by the framework when nothing else fits |

Each subclass takes a message and (where relevant) extra context as the second argument:

```ts
throw new NotFoundError("Post not found");
throw new BadRequestError("Invalid date range");
throw new ConflictError("Email already in use");
throw new AuthorizationError("Not the post author");
throw new RateLimitError("Too many login attempts", { retryAfterSec: 60 });

// ValidationError is normally thrown by validate() with Zod issues attached.
// You rarely throw it directly — but if you do:
throw new ValidationError("Custom validation failed", { details: { field: "..." } });
```

Don't throw `AppError` directly. The base class exists for `instanceof AppError` checks (the global error handler does one) and as a parent for the subclasses; throwing it without a specific subclass loses information.

## `registerErrorHandlers`

```ts
import { createApp, registerErrorHandlers } from "@sixthsummit/ship-api";

const app = createApp();
registerErrorHandlers(app);
```

This registers two Hono handlers: an `app.notFound()` for unmatched routes (returns a 404 with `NOT_FOUND_ERROR`), and an `app.onError()` for everything thrown.

The signature:

```ts
export function registerErrorHandlers(
  app: Hono<never>,
  opts?: RegisterErrorHandlersOptions,
): void;

export interface RegisterErrorHandlersOptions {
  logger?: Logger;
  exposeStack?: boolean; // default: NODE_ENV === "development"
}
```

The handler logic:

1. **`AppError` subclass** → respond with the class's status code and structured body.
2. **`HTTPException` from Hono** → respond with the exception's status and message.
3. **Anything else** → log at `error` level with stack trace, respond with 500 + `INTERNAL_SERVER_ERROR`. The original error message is **not** included in the response (avoids leaking internals); in development mode (`exposeStack: true`), the stack is included.

## The response shape

Every error response has this shape:

```ts
export interface ErrorResponseShape {
  success: false;
  error: {
    code: string;          // e.g., "NOT_FOUND_ERROR"
    message: string;
    details?: unknown;     // ValidationError uses this for Zod issues
  };
  stack?: string;          // development only
  name?: string;           // development only
}
```

Examples:

**404 from `NotFoundError("Post not found")`:**

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND_ERROR",
    "message": "Post not found"
  }
}
```

**400 from `validate("json", schema)`:**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      { "path": ["title"], "message": "String must contain at least 1 character(s)" },
      { "path": ["body"], "message": "Required" }
    ]
  }
}
```

**429 from `RateLimitError`:**

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many login attempts",
    "details": { "retryAfterSec": 60 }
  }
}
```

The shape is stable — consumers (ShipAngular's `createResource`, RN's TanStack Query queries, agents using `execute_route`) all key off `error.code` to distinguish failure modes. Adding a new error class means adding a new code, not changing the envelope.

## Validation errors

`validate(target, schema)` throws `ValidationError` with the Zod issues attached. The framework formats those issues into the `details` array — each issue keeps its `path` (so the client can highlight the right field) and its `message`.

```ts
// Server
const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
}).strict();

app.post("/posts", validate("json", createPostSchema), handler);

// Client request: POST /posts {"title": "", "extra": "field"}
// Response: 400 with details:
// [
//   { path: ["title"], message: "String must contain at least 1 character(s)" },
//   { path: ["extra"], message: "Unrecognized key(s) in object: 'extra'" }
// ]
```

Two practical points:

- **Use `.strict()`** on object schemas to surface unknown-key typos. The cost is real (clients sending extra fields fail) but the alternative — silently accepting and ignoring — masks bugs that don't surface until production.
- **`details` is unstructured by design**. Zod's issue shape is well-known; trying to enforce a tighter contract here would block apps that throw `ValidationError` with custom-shape details.

## Errors and modules

Every module's `permissions.ts`, `validation/schemas.ts`, and routes import error classes from the framework — there's no per-module taxonomy. If you find yourself wanting a `PostNotFoundError`, that's a smell. Use `NotFoundError("Post not found")` and let the message carry the specifics; the response shape stays uniform.

When you do need a domain-specific error class (rare — usually only for state-machine errors that don't fit the standard taxonomy), extend `AppError` directly:

```ts
import { AppError } from "@sixthsummit/ship-api";

export class PostAlreadyPublishedError extends AppError {
  constructor(postId: string) {
    super(`Post ${postId} is already published`);
    this.name = "PostAlreadyPublishedError";
  }

  // override these:
  get statusCode(): number { return 409; }
  get code(): string { return "POST_ALREADY_PUBLISHED"; }
}
```

The base class's serialization picks up `statusCode` and `code` getters. Use this sparingly — most cases want `ConflictError("Post already published")` instead.

## Logging

The error handler logs through the request-scoped pino child (set by `httpLogger` middleware), so every error log has `requestId` and `traceId` correlated. Unhandled errors log at `error` level with full stack; handled `AppError` subclasses log at `warn` level with code + message but without stack (they're expected).

If you want to log additional context when throwing — for instance, the post id and user id when a `NotFoundError` fires — log explicitly first:

```ts
const post = await postService.get(id);
if (!post) {
  c.var.logger.warn({ postId: id, userId: c.var.user.id }, "post.not-found");
  throw new NotFoundError("Post not found");
}
```

The framework doesn't try to extract context from thrown errors automatically — explicit logging is clearer and lets you attach whatever fields the case warrants.

## Source

- [`packages/core/src/http/app/errors.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/app/errors.ts) — `registerErrorHandlers` + the response shape
- [`packages/core/src/http/errors/`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/errors) — every concrete error class
- [`.cursor/rules/api.mdc`](https://github.com/sixthsummit/ship-api/blob/main/.cursor/rules/api.mdc) — the throw-don't-shape rule
