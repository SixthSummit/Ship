import { createHonoAdapter, type HonoCorsOptions } from "@sixthsummit/ship-hono";
import { app } from "./application.js";

/**
 * Browser origins allowed to call this API, from a comma-separated
 * `CORS_ORIGINS` allowlist (`https://app.example.com,https://admin.example.com`).
 *
 * Unset or empty means no cross-origin policy: a browser on another origin is
 * refused. Credentials (cookies, `Authorization`) are allowed for the listed
 * origins, so `*` is rejected at boot; list every origin explicitly.
 */
export function corsFromEnv(value: string | undefined): HonoCorsOptions | undefined {
  const origins = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (origins.length === 0) return undefined;
  return { origin: origins, credentials: true };
}

/** The HTTP projection of the application graph, with CORS from the environment. */
export function createHttp(env: { readonly CORS_ORIGINS?: string } = process.env) {
  const cors = corsFromEnv(env.CORS_ORIGINS);
  return createHonoAdapter(app, cors ? { cors } : {});
}
