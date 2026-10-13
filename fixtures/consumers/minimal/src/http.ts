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

export function createNotesHttpApplication(unitOfWork: UnitOfWork<NotesCapabilities>) {
  const application = createNotesApplication(unitOfWork);
  return {
    application,
    http: createHonoAdapter(application, {
      auth: { credentials: requestHeadersCredential(), actors },
    }),
  };
}
