import { createHonoAdapter } from "@sixthsummit/ship-hono";
import { type CustomizedInfrastructure, createCustomizedApplication } from "./application.js";
import { type SessionDirectory, sessionActorResolver, sessionCredentialAdapter } from "./auth.js";

export function createCustomizedHttpApplication(
  infrastructure: CustomizedInfrastructure,
  sessions: SessionDirectory,
  options: { readonly publicBaseUrl?: string } = {},
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
    }),
  };
}
