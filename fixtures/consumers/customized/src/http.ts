import {
  createInMemoryCredentialStore,
  credentialAuthRateLimitPolicies,
} from "@sixthsummit/ship-auth-credentials";
import { createHonoAdapter } from "@sixthsummit/ship-hono";
import { type CustomizedInfrastructure, createCustomizedApplication } from "./application.js";
import {
  customizedActorResolver,
  customizedCredentialAdapter,
  type SessionDirectory,
} from "./auth.js";

/** Browser origins allowed to call the API with session cookies. */
export const DEFAULT_CORS_ORIGINS = ["https://portfolio.golden.test"] as const;

export function createCustomizedHttpApplication(
  infrastructure: CustomizedInfrastructure,
  sessions: SessionDirectory,
  options: {
    readonly publicBaseUrl?: string;
    readonly corsOrigins?: readonly string[];
    /** Sign-in attempts per client ip per minute before `AUTH_RATE_LIMITED`. */
    readonly authAttemptsPerMinute?: number;
  } = {},
) {
  // The in-memory default must be one instance for the module and the resolver.
  const credentialStore = infrastructure.credentialStore ?? createInMemoryCredentialStore();
  const composed = { ...infrastructure, credentialStore };
  const application = createCustomizedApplication(composed);
  return {
    application,
    http: createHonoAdapter(application, {
      auth: {
        credentials: customizedCredentialAdapter(),
        actors: customizedActorResolver({
          directory: sessions,
          store: credentialStore,
          ...(composed.authClients ? { clients: composed.authClients } : {}),
          ...(composed.clock ? { clock: composed.clock } : {}),
        }),
      },
      // Rate limiting is the SAPI-476 pre-validation policy keyed by client ip;
      // the account lockout policy guards the credential itself.
      preValidationPolicies: credentialAuthRateLimitPolicies({
        max: options.authAttemptsPerMinute ?? 20,
        windowMs: 60_000,
        ...(composed.clock ? { clock: composed.clock } : {}),
      }),
      // Providers sign the public URL; verification never trusts the incoming Host.
      webhooks: { publicBaseUrl: options.publicBaseUrl ?? "https://golden.example.test" },
      // One policy covers operation, streaming and webhook routes and their
      // preflights; declared error headers (Retry-After) are exposed automatically.
      cors: { origin: options.corsOrigins ?? DEFAULT_CORS_ORIGINS, credentials: true },
    }),
  };
}
