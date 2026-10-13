import { zValidator as honoZodValidator } from "@hono/zod-validator";
import type { MiddlewareHandler } from "hono";
import type { ZodError, ZodType } from "zod";
import { ValidationError } from "../errors/ValidationError.js";
import { SCHEMA_META, type SchemaMeta, setMetaTag } from "./metaTags.js";

type ValidatorResult = { success: true; data: unknown } | { success: false; error: ZodError };

/**
 * Drop-in replacement for `@hono/zod-validator`'s `zValidator(...)` that
 * additionally tags the returned middleware so `createApp`'s route-method
 * interceptors can capture the schema in the route registry.
 *
 * Same call shape as `zValidator`:
 *
 * ```ts
 * import { validate } from "@sixthsummit/ship-api/http/utils/validate";
 *
 * app.post(
 *   '/accounts',
 *   requireAuth(),
 *   requirePermission('accounts:create'),
 *   validate('json', createAccountSchema),
 *   async (c) => {
 *     const body = c.req.valid('json');   // typed via z.infer
 *     ...
 *   },
 * );
 * ```
 *
 * The function is generic over the validation target and the Zod schema so
 * the typed middleware return flows through Hono's chain and `c.req.valid()`
 * is fully typed downstream — matching `zValidator`'s native behavior.
 *
 * Validation errors throw `ValidationError` (preserving the framework's
 * AppError taxonomy) so `app.onError(...)` produces the same response shape
 * the v3 stack used. The first issue's `path` joins to a dotted name to
 * match v3's `ValidationMiddleware` error message format.
 */
export function validate<Target extends "json" | "query" | "param" | "header", T extends ZodType>(
  target: Target,
  schema: T,
  meta?: { description?: string; example?: unknown },
) {
  const middleware = honoZodValidator(target, schema, ((result: ValidatorResult) => {
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first?.path?.length ? first.path.join(".") : target;
      const message = first?.message ?? "Invalid request";
      throw new ValidationError(`${path}: ${message}`);
    }
  }) as never);

  const tag: SchemaMeta = {
    target,
    schema,
    description: meta?.description,
    example: meta?.example,
  };
  // Cast for the side effect — setMetaTag accepts the bare MiddlewareHandler
  // shape; the typed return below keeps zValidator's full generics.
  setMetaTag(middleware as MiddlewareHandler, SCHEMA_META, tag);

  return middleware;
}
