/**
 * `defineEnv` — boot-time environment validation.
 *
 * Accepts any schema with a `safeParse(data) -> { success, data | error }` shape
 * (Zod 3, Zod 4, Valibot adapter, etc.) so the framework stays validator-agnostic
 * at the type level. On failure: prints a structured "missing/invalid: VAR (type)"
 * report and exits with code 1 *before* the app boots.
 *
 * Replaces the v3 pattern of scattered `process.env.FOO || ""` reads with a single
 * typed env object. Eliminates the class of "mystery runtime errors from a typo'd
 * env var" by failing loudly at startup.
 */

export interface EnvSchemaIssue {
  // Zod's ZodIssue.path is `PropertyKey[]` (string | number | symbol).
  // Widen to match so consumers passing a `z.object(...)` directly to
  // defineEnv satisfy this interface structurally without a wrapper.
  // The framework only formats path entries as strings for error
  // reports, so the rare symbol case stringifies harmlessly.
  path: ReadonlyArray<PropertyKey>;
  message: string;
  code?: string;
}

export interface EnvSchemaError {
  issues: ReadonlyArray<EnvSchemaIssue>;
}

export type EnvSafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: EnvSchemaError };

export interface EnvSchema<T> {
  safeParse(data: unknown): EnvSafeParseResult<T>;
}

export interface DefineEnvOptions {
  /** Source of env vars. Defaults to `process.env`. */
  source?: NodeJS.ProcessEnv;
  /**
   * Override the failure handler. Default logs a report and calls `process.exit(1)`.
   * Useful in tests so a bad fixture doesn't kill the test runner.
   */
  onFailure?: (issues: ReadonlyArray<EnvSchemaIssue>) => never;
  /**
   * Logger for the failure report. Defaults to `console.error`.
   * In v4 this will default to the framework's pino logger.
   */
  logger?: Pick<Console, "error">;
}

/**
 * Replace common secret-value shapes with `<redacted>` before logging.
 *
 * Framework-default Zod messages don't include the raw value (e.g.
 * "String must contain at least 32 character(s)"), but consumer
 * schemas using `.refine((v) => …, { message: `got "${v}"` })` or
 * transform-based validators that include the raw value will spill
 * the secret through this `console.error` path — observability
 * stacks (Stackdriver, Datadog, Loki) capture stdout/stderr by
 * default, and the secret then becomes searchable, indexed, and
 * forwarded across systems. A regex scrub here is the last line of
 * defense before that boundary.
 *
 * The patterns are intentionally narrow (named token shapes) plus
 * one generic-high-entropy catch-all. False positives are limited
 * to error messages that happen to contain ≥32 contiguous
 * base64-alphabet characters with no separators — rare in legit
 * Zod messages.
 */
export function scrubSecrets(message: string): string {
  if (typeof message !== "string" || message.length === 0) return message;
  let out = message;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "<redacted>");
  }
  return out;
}

// Ordered most-specific → least-specific so named shapes don't get
// pre-swallowed by the generic high-entropy catch.
const SECRET_PATTERNS: readonly RegExp[] = [
  // JWT-shaped (three base64url segments separated by `.`)
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // OpenAI / Anthropic-style `sk-…` keys
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // Slack tokens (`xoxb-…`, `xoxp-…`, `xoxa-…`)
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Generic high-entropy: contiguous run of 32+ base64-ish characters
  // with no spaces. Last resort for "we don't know the prefix but
  // the value is obviously a token."
  /[A-Za-z0-9+/=_-]{32,}/g,
];

function defaultOnFailure(
  issues: ReadonlyArray<EnvSchemaIssue>,
  logger: Pick<Console, "error">,
): never {
  logger.error("");
  logger.error("✗ Environment validation failed. The app cannot start.");
  logger.error("");
  for (const issue of issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    const safeMessage = scrubSecrets(issue.message);
    logger.error(`  • ${path}: ${safeMessage}${issue.code ? ` [${issue.code}]` : ""}`);
  }
  logger.error("");
  logger.error(`Total: ${issues.length} issue(s). Fix the env vars listed above and restart.`);
  logger.error("");
  process.exit(1);
}

/**
 * Validate process.env against a schema. Returns the typed env on success;
 * exits the process with a structured error report on failure.
 *
 * @example
 *   import { z } from "zod";
 *   const schema = z.object({
 *     PORT: z.coerce.number().int().positive().default(3000),
 *     DATABASE_URL: z.string().url(),
 *     SESSION_SECRET: z.string().min(32),
 *   });
 *   export const env = defineEnv(schema);
 *   // env.PORT is typed as number, env.DATABASE_URL as string, etc.
 */
export function defineEnv<T>(schema: EnvSchema<T>, opts: DefineEnvOptions = {}): T {
  const source = opts.source ?? process.env;
  const logger = opts.logger ?? console;
  const onFailure = opts.onFailure ?? ((issues) => defaultOnFailure(issues, logger));

  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  return onFailure(result.error.issues);
}
