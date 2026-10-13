import { defineEnv } from "@sixthsummit/ship-api";
import { z } from "zod";

/**
 * Runtime configuration boundary. `defineEnv` validates
 * `process.env` against the Zod schema below at boot — fail-fast
 * with a structured "missing/invalid: KEY" error instead of letting
 * bad config produce silent runtime failures.
 *
 * Convention enforced by the project's eslint config: this file is the only
 * application-config boundary for `process.env`. The dependency-free
 * `instrumentation.ts` bootstrap is the intentional early exception. Module
 * and handler code route through the typed `env` object exported below.
 */
export const env = defineEnv(
  z.object({
    // ─── Server ────────────────────────────────────────────────────
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /**
     * Comma-separated CORS allowlist. The framework wires `hono/cors`
     * with `credentials: true` against this list at `createApp()`.
     * Browsers reject `origin: '*'` + `credentials: true`; the
     * framework refuses to construct an app under that combination.
     *
     * Example: `CORS_ORIGINS=https://app.example.com,https://admin.example.com`
     */
    CORS_ORIGINS: z
      .string()
      .optional()
      .transform((value) =>
        value
          ? value
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : undefined,
      ),

    // ─── Database ──────────────────────────────────────────────────
    DATABASE_URL: z.string().url(),

    // ─── Auth ──────────────────────────────────────────────────────
    OAUTH_STATE_SECRET: z.string().min(32),
    JWT_SIGNING_KEY: z.string().optional(),
    JWT_VERIFICATION_KEYS: z.string().optional(),

    // ─── Redis (optional in dev, required for rate-limit + jobs) ───
    REDIS_URL: z.string().url().optional(),

    // ─── Admin (Bull-Board dashboard etc.) ─────────────────────────
    // Required when mounting the Bull-Board admin UI via
    // `createBullBoardApp({ apiKey: env.ADMIN_API_KEY })`. ≥32 random
    // bytes; rotate independently of JWT keys. The dashboard is
    // dev/staging-only — don't expose it on a public hostname even
    // with the key set.
    ADMIN_API_KEY: z.string().min(32).optional(),

    // ─── Observability ─────────────────────────────────────────────
    OTEL_SDK_DISABLED: z.string().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().default("ship-api-app"),
    ENVIRONMENT_NAME: z.string().default("development"),
    METRICS_ENABLED: z.string().optional(),
    METRICS_PORT: z.coerce.number().int().positive().default(9464),

    // ─── Firebase (default AuthProvider; swap for Better-Auth/etc.) ─
    FIREBASE_CREDENTIALS: z.string().optional(),

    // ─── OAuth providers (declare only what you support) ───────────
    OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
    OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
    OAUTH_GOOGLE_REDIRECT_URI: z.string().url().optional(),
    OAUTH_MICROSOFT_CLIENT_ID: z.string().optional(),
    OAUTH_MICROSOFT_CLIENT_SECRET: z.string().optional(),
    OAUTH_MICROSOFT_REDIRECT_URI: z.string().url().optional(),
  }),
);

export type Env = typeof env;
