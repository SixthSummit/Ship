import {
  type CredentialSessionCredential,
  type CredentialStore,
  credentialActorResolver,
  credentialSessionCredentials,
  type RequestClientRegistry,
} from "@sixthsummit/ship-auth-credentials";
import { CONSOLE_OPERATE_PERMISSION } from "@sixthsummit/ship-console";
import {
  type ActorResolution,
  type ActorResolver,
  defineActorResolver,
  operationActor,
  WEBHOOK_REPLAY_PERMISSION,
} from "@sixthsummit/ship-core";
import { defineHonoCredentialAdapter, type HonoCredentialAdapter } from "@sixthsummit/ship-hono";
import {
  type CredentialRole,
  credentialAuthPolicies,
  credentialRoles,
  credentialSessionPolicy,
} from "./credential-auth.js";

export type SessionCredential =
  | { readonly kind: "session"; readonly token: string }
  | { readonly kind: "malformed" };

/** Either a directory session (`ShipSession <token>`), a credential-auth bearer (`Bearer ship_s_…`) or the session cookie. */
export type CustomizedCredential = SessionCredential | CredentialSessionCredential;

interface SessionIdentity {
  readonly actorId: string;
  readonly role: "analyst" | "publisher" | "operator" | "sre";
  readonly tenants: readonly string[];
}

export interface SessionDirectory {
  find(token: string): SessionIdentity | undefined | Promise<SessionIdentity | undefined>;
}

const rolePermissions = {
  analyst: ["portfolio:read"],
  publisher: ["portfolio:read", "portfolio:write", "reports:notify"],
  /** Operations staff: may re-enqueue a stored webhook event through the mounted replay. */
  operator: ["portfolio:read", WEBHOOK_REPLAY_PERMISSION],
  /**
   * Site reliability: the only role that holds the console slug. It is granted
   * on its own, never implied by `operator` or any other management permission.
   */
  sre: ["portfolio:read", CONSOLE_OPERATE_PERMISSION],
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

/**
 * The two providers side by side (ADR-0004 keeps credential extraction and
 * actor resolution separate, so composing them is a dispatch on the
 * credential kind): the directory session for the fleet's existing tokens
 * and the credential-auth bearer or session cookie for first-party accounts.
 * All produce the same actor contract, so every operation's access policy is
 * unchanged.
 */
export function customizedCredentialAdapter(): HonoCredentialAdapter<CustomizedCredential> {
  const sessions = sessionCredentialAdapter();
  const credentials = credentialSessionCredentials({ sessions: credentialSessionPolicy });
  return defineHonoCredentialAdapter({
    id: "http.customized",
    // The cookie-reading adapter cannot be mounted without the CSRF guard;
    // forwarding its requirement keeps that a construction-time failure here.
    ...(credentials.requires ? { requires: credentials.requires } : {}),
    extract: async (request) => {
      const authorization = request.headers.get("authorization");
      if (authorization?.startsWith("ShipSession ")) return sessions.extract(request);
      return credentials.extract(request);
    },
  });
}

export function customizedActorResolver(definition: {
  readonly directory: SessionDirectory;
  readonly store: CredentialStore;
  readonly clients?: RequestClientRegistry;
  readonly clock?: () => Date;
}): ActorResolver<CustomizedCredential> {
  const sessions = sessionActorResolver(definition.directory);
  const credentials = credentialActorResolver({
    store: definition.store,
    session: credentialAuthPolicies.session,
    ...(definition.clients ? { clients: definition.clients } : {}),
    ...(definition.clock ? { clock: definition.clock } : {}),
    // Roles map to the same slugs as directory sessions. The console slug (the
    // "admin surface") is granted only to an MFA-verified session, which is how
    // a per-surface MFA requirement is expressed without a second policy engine.
    resolveActor: ({ account, session }) =>
      operationActor({
        id: account.id,
        permissions: [
          ...account.roles
            .filter((role): role is CredentialRole =>
              credentialRoles.includes(role as CredentialRole),
            )
            .flatMap((role) => [...rolePermissions[role]])
            .filter(
              (slug) => slug !== CONSOLE_OPERATE_PERMISSION || session.mfaState === "verified",
            ),
          "tenant:acme",
        ],
      }),
  });
  return defineActorResolver({
    id: "auth.customized",
    resolve: (request): Promise<ActorResolution> | ActorResolution => {
      const credential = request.credential;
      if (credential === undefined) return { ok: true };
      if (credential.kind === "session" || credential.kind === "malformed") {
        return sessions.resolve({ ...request, credential });
      }
      return credentials.resolve({ ...request, credential });
    },
  });
}
