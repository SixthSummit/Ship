/**
 * Structural type for the slice of a Zod schema `defineEnv` reads. Keeps the
 * primitive compatible across Zod 3.x and 4.x — both expose `safeParse` with
 * this shape, while the nominal generics changed between majors
 * (`ZodTypeDef` no longer exists in Zod 4). Mirrors the `ZodFieldLike`
 * approach in `forms/createSchemaForm.ts`: a non-discriminated result with
 * optional `data` / `error` read via optional chaining.
 */
interface EnvSchemaLike<TOutput> {
  safeParse(value: unknown): {
    success: boolean;
    data?: TOutput;
    error?: { issues: readonly EnvSchemaIssue[] };
  };
}

interface EnvSchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Defines a type-safe, runtime-validated environment configuration object.
 *
 * Pass a Zod schema describing your environment shape; receive a parsed object
 * whose static type matches the schema. Validation happens at module load —
 * if the environment is missing or malformed, the build fails fast with a
 * clear error rather than silently shipping a broken app.
 *
 * @example
 * ```ts
 * // src/environments/env.ts
 * import { z } from 'zod';
 * import { defineEnv } from '@sixthsummit/ship-angular';
 *
 * const schema = z.object({
 *   firebase: z.object({
 *     apiKey: z.string().min(1),
 *     authDomain: z.string().min(1),
 *     projectId: z.string().min(1),
 *   }),
 *   apiBase: z.string().url(),
 *   production: z.boolean(),
 * });
 *
 * export const env = defineEnv(schema, {
 *   firebase: {
 *     apiKey: import.meta.env['VITE_FIREBASE_API_KEY'],
 *     authDomain: import.meta.env['VITE_FIREBASE_AUTH_DOMAIN'],
 *     projectId: import.meta.env['VITE_FIREBASE_PROJECT_ID'],
 *   },
 *   apiBase: import.meta.env['VITE_API_BASE'],
 *   production: import.meta.env['PROD'],
 * });
 * ```
 *
 * The returned object is frozen; mutations throw at runtime.
 *
 * @param schema A Zod schema (3.x or 4.x) describing the expected env shape.
 * @param raw The raw input — typically read from `import.meta.env` or
 *   `process.env`. Intentionally `unknown`: env input is untyped by nature,
 *   and the schema is the single source of truth for its shape.
 * @returns A frozen object whose type matches the schema's output.
 * @throws If validation fails. The error message includes the path and reason.
 */
export function defineEnv<TOutput>(
  schema: EnvSchemaLike<TOutput>,
  raw: unknown
): Readonly<TOutput> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = (result.error?.issues ?? [])
      .map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `[ShipAngular] Environment validation failed:\n${issues}\n\n` +
        `Check your .env files and the Zod schema passed to defineEnv().`
    );
  }
  return Object.freeze(result.data as TOutput) as Readonly<TOutput>;
}
