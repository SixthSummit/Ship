import {
  type ActorResolver,
  defineActorResolver,
  operationActor,
  WEBHOOK_REPLAY_PERMISSION,
} from "@sixthsummit/ship-core";
import { defineHonoCredentialAdapter, type HonoCredentialAdapter } from "@sixthsummit/ship-hono";

export type SessionCredential =
  | { readonly kind: "session"; readonly token: string }
  | { readonly kind: "malformed" };

interface SessionIdentity {
  readonly actorId: string;
  readonly role: "analyst" | "publisher" | "operator";
  readonly tenants: readonly string[];
}

export interface SessionDirectory {
  find(token: string): SessionIdentity | undefined | Promise<SessionIdentity | undefined>;
}

const rolePermissions = {
  analyst: ["portfolio:read"],
  publisher: ["portfolio:read", "reports:notify"],
  /** Operations staff: may re-enqueue a stored webhook event through the mounted replay. */
  operator: ["portfolio:read", WEBHOOK_REPLAY_PERMISSION],
} as const;

export function sessionCredentialAdapter(): HonoCredentialAdapter<SessionCredential> {
  return defineHonoCredentialAdapter({
    id: "http.ship-session",
    extract: (request) => {
      const authorization = request.headers.get("authorization");
      if (authorization === null) return undefined;
      const match = /^ShipSession ([a-z0-9-]+)$/u.exec(authorization);
      return match?.[1]
        ? Object.freeze({ kind: "session" as const, token: match[1] })
        : Object.freeze({ kind: "malformed" as const });
    },
  });
}

export function sessionActorResolver(
  directory: SessionDirectory,
): ActorResolver<SessionCredential> {
  return defineActorResolver({
    id: "auth.ship-session",
    resolve: async ({ credential }) => {
      if (credential === undefined) return { ok: true };
      if (credential.kind === "malformed") return { ok: false, reason: "invalid-credential" };
      const identity = await directory.find(credential.token);
      if (!identity) return { ok: false, reason: "invalid-credential" };
      return {
        ok: true,
        actor: operationActor({
          id: identity.actorId,
          permissions: [
            ...rolePermissions[identity.role],
            ...identity.tenants.map((tenantId) => `tenant:${tenantId}`),
          ],
        }),
      };
    },
  });
}
