import { defineActorResolver, operationActor, type UnitOfWork } from "@sixthsummit/ship-core";
import {
  createHonoAdapter,
  type HeaderCredential,
  requestHeadersCredential,
} from "@sixthsummit/ship-hono";
import { createNotesApplication } from "./application.js";
import type { NotesCapabilities } from "./repository.js";

const actors = defineActorResolver<HeaderCredential>({
  id: "auth.api-key",
  resolve: ({ credential }) => {
    const apiKey = credential?.["x-api-key"];
    if (apiKey === undefined) return { ok: true };
    if (apiKey !== "golden-test-key") return { ok: false, reason: "invalid-credential" };
    return {
      ok: true,
      actor: operationActor({
        id: "golden-user",
        permissions: ["notes:read", "notes:write"],
      }),
    };
  },
});

/** Browser origins allowed to call the API with credentials; a wildcard is refused at construction. */
export const DEFAULT_CORS_ORIGINS = ["https://app.golden.test"] as const;

export function createNotesHttpApplication(
  unitOfWork: UnitOfWork<NotesCapabilities>,
  options: { readonly corsOrigins?: readonly string[] } = {},
) {
  const application = createNotesApplication(unitOfWork);
  return {
    application,
    http: createHonoAdapter(application, {
      auth: { credentials: requestHeadersCredential(), actors },
      // The adapter answers preflights for every route and exposes X-Request-Id.
      cors: { origin: options.corsOrigins ?? DEFAULT_CORS_ORIGINS, credentials: true },
    }),
  };
}
