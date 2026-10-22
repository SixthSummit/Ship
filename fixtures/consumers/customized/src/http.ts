import { createHonoAdapter } from "@sixthsummit/ship-hono";
import { type CustomizedInfrastructure, createCustomizedApplication } from "./application.js";
import { type SessionDirectory, sessionActorResolver, sessionCredentialAdapter } from "./auth.js";

/** Browser origins allowed to call the API with session cookies. */
export const DEFAULT_CORS_ORIGINS = ["https://portfolio.golden.test"] as const;

export function createCustomizedHttpApplication(
  infrastructure: CustomizedInfrastructure,
  sessions: SessionDirectory,
  options: { readonly publicBaseUrl?: string; readonly corsOrigins?: readonly string[] } = {},
) {
  const application = createCustomizedApplication(infrastructure);
  return {
    application,
    http: createHonoAdapter(application, {
      auth: {
        credentials: sessionCredentialAdapter(),
        actors: sessionActorResolver(sessions),
      },
      // Providers sign the public URL; verification never trusts the incoming Host.
      webhooks: { publicBaseUrl: options.publicBaseUrl ?? "https://golden.example.test" },
      // One policy covers operation, streaming and webhook routes and their
      // preflights; declared error headers (Retry-After) are exposed automatically.
      cors: { origin: options.corsOrigins ?? DEFAULT_CORS_ORIGINS, credentials: true },
    }),
  };
}
