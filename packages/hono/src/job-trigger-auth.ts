import type { ActorResolution, ActorResolver } from "@sixthsummit/ship-core";
import { defineActorResolver, operationIdentity, systemActor } from "@sixthsummit/ship-core";
import { defineHonoCredentialAdapter, type HonoCredentialAdapter } from "./auth.js";

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

export type BearerCredential =
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "malformed" };

/** Extracts `Authorization: Bearer <token>`; any other Authorization value is `malformed`. */
export function bearerTokenCredentials(): HonoCredentialAdapter<BearerCredential> {
  return defineHonoCredentialAdapter({
    id: "http.bearer",
    extract: (request) => {
      const authorization = request.headers.get("authorization");
      if (authorization === null) return undefined;
      const match = /^Bearer\s+(\S+)$/iu.exec(authorization.trim());
      return match?.[1]
        ? Object.freeze({ kind: "bearer" as const, token: match[1] })
        : Object.freeze({ kind: "malformed" as const });
    },
  });
}

/** The permission a scheduler needs to start `jobId` through its HTTP trigger. */
export function jobTriggerPermission(jobId: string): string {
  return `ship.jobs:trigger:${jobId}`;
}

export interface VerifiedIdentityToken {
  /** Stable subject from the token (for example a service-account email). */
  readonly subject: string;
  /** Permissions granted to the scheduler identity; typically `jobTriggerPermission(jobId)` values. */
  readonly permissions?: Iterable<string>;
  /** Overrides the system actor id; defaults to the subject. */
  readonly actorId?: string;
}

/**
 * Verifies a scheduler-issued identity token (for example a Google Cloud
 * Scheduler OIDC token). Implementations must check signature, issuer,
 * audience and expiry and return undefined for anything that fails.
 */
export interface IdentityTokenVerifier {
  verify(
    token: string,
  ): VerifiedIdentityToken | undefined | Promise<VerifiedIdentityToken | undefined>;
}

export interface BearerSecret {
  readonly secret: string;
  readonly actorId: string;
  /** Scope the secret to the jobs it may trigger. */
  readonly permissions: Iterable<string>;
}

export interface JobTriggerActorResolverOptions {
  /** Defaults to `auth.job-trigger`. */
  readonly id?: string;
  /** Identity provider recorded on the verified identity; defaults to `oidc`. */
  readonly identityProvider?: string;
  /** Preferred: scheduler identity tokens verified by the application. */
  readonly identityTokens?: IdentityTokenVerifier;
  /** Compatibility: scoped bearer secrets compared in constant time. */
  readonly bearerSecrets?: readonly BearerSecret[];
  /** Resolves requests without a bearer credential (for example human sessions). */
  readonly fallback?: ActorResolver<BearerCredential>;
}

/**
 * Resolves HTTP job-trigger callers into `system` actors that carry only the
 * permissions the scheduler was granted. Identity tokens are preferred; scoped
 * bearer secrets remain supported. No per-job signing protocol is introduced.
 */
export function jobTriggerActorResolver(
  options: JobTriggerActorResolverOptions,
): ActorResolver<BearerCredential> {
  assertOptions(options);
  const provider = options.identityProvider ?? "oidc";
  const secrets = options.bearerSecrets ?? [];
  const verifier = options.identityTokens;
  const fallback = options.fallback;

  return defineActorResolver<BearerCredential>({
    id: options.id ?? "auth.job-trigger",
    resolve: async (request): Promise<ActorResolution> => {
      const credential = request.credential;
      if (credential === undefined) return fallback ? fallback.resolve(request) : { ok: true };
      if (credential.kind === "malformed") return { ok: false, reason: "invalid-credential" };

      if (verifier && JWT_PATTERN.test(credential.token)) {
        let verified: VerifiedIdentityToken | undefined;
        try {
          verified = await verifier.verify(credential.token);
        } catch {
          return { ok: false, reason: "unavailable" };
        }
        if (!verified) return { ok: false, reason: "invalid-credential" };
        return {
          ok: true,
          identity: operationIdentity({ provider, subject: verified.subject }),
          actor: systemActor({
            id: verified.actorId ?? verified.subject,
            permissions: verified.permissions ?? [],
          }),
        };
      }

      const matched = secrets.find((secret) => constantTimeEqual(secret.secret, credential.token));
      if (matched) {
        return {
          ok: true,
          actor: systemActor({ id: matched.actorId, permissions: matched.permissions }),
        };
      }
      return fallback ? fallback.resolve(request) : { ok: false, reason: "invalid-credential" };
    },
  });
}

/** Compares two strings without short-circuiting on the first differing byte. */
export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function assertOptions(options: unknown): asserts options is JobTriggerActorResolverOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("job trigger actor resolver options must be an object");
  }
  const verifier = Reflect.get(options, "identityTokens");
  if (verifier !== undefined && typeof Reflect.get(verifier as object, "verify") !== "function") {
    throw new TypeError("identityTokens must provide verify(token)");
  }
  const secrets = Reflect.get(options, "bearerSecrets");
  if (
    secrets !== undefined &&
    (!Array.isArray(secrets) ||
      !secrets.every(
        (secret) =>
          typeof secret === "object" &&
          secret !== null &&
          typeof Reflect.get(secret, "secret") === "string" &&
          Reflect.get(secret, "secret").length >= 16 &&
          typeof Reflect.get(secret, "actorId") === "string" &&
          Reflect.get(secret, "actorId").length > 0 &&
          Reflect.get(secret, "permissions") !== undefined,
      ))
  ) {
    throw new TypeError(
      "bearerSecrets must be an array of { secret (at least 16 characters), actorId, permissions }",
    );
  }
  if (verifier === undefined && (secrets === undefined || (secrets as unknown[]).length === 0)) {
    throw new TypeError(
      "job trigger actor resolver needs identityTokens or at least one bearer secret",
    );
  }
  const provider = Reflect.get(options, "identityProvider");
  if (
    provider !== undefined &&
    (typeof provider !== "string" || !PROVIDER_PATTERN.test(provider))
  ) {
    throw new TypeError("identityProvider must be a lowercase dot-separated identifier");
  }
}
