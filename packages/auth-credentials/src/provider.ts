import {
  type ActorResolution,
  type ActorResolutionRequest,
  type ActorResolver,
  defineActorResolver,
  normalizeOperationActor,
  type OperationActorInput,
  operationActor,
  operationIdentity,
} from "@sixthsummit/ship-core";
import {
  defineHonoCredentialAdapter,
  type HonoAuthenticationOptions,
  type HonoCredentialAdapter,
} from "@sixthsummit/ship-hono";
import { type RequestClient, type RequestClientRegistry, readRequestClient } from "./client.js";
import {
  type CredentialSessionCookiePolicy,
  type CredentialSessionPolicy,
  type CredentialSessionTransport,
  credentialSessionCsrfRequirement,
  readSessionCookie,
} from "./cookie.js";
import { hashToken, isTokenShaped, SESSION_TOKEN_PREFIX } from "./crypto/tokens.js";
import { CREDENTIAL_IDENTITY_PROVIDER } from "./runtime.js";
import type { AuthAccount, AuthSession, CredentialStore } from "./store.js";

const BEARER_PATTERN = /^Bearer[\t ]+(\S+)[\t ]*$/iu;

/**
 * What the credential adapter hands the resolver. `anonymous` still carries
 * the client facts so public operations (sign-in, register) can audit them.
 * `transport` says whether the token arrived in the bearer header or the
 * session cookie; a bearer header always wins over a cookie.
 */
export type CredentialSessionCredential =
  | {
      readonly kind: "ship-credentials.session";
      readonly token: string;
      readonly client: RequestClient;
      readonly transport: CredentialSessionTransport;
    }
  | {
      readonly kind: "ship-credentials.invalid";
      readonly client: RequestClient;
      readonly transport: CredentialSessionTransport;
    }
  | { readonly kind: "ship-credentials.anonymous"; readonly client: RequestClient };

export interface CredentialSessionCredentialOptions {
  /** Header that carries `Bearer <token>`. Defaults to `authorization`. */
  readonly header?: string;
  /**
   * The module's resolved `sessions` policy. When it includes the cookie
   * transport the adapter reads the session cookie whenever no bearer header
   * is present. Omit it (or pass a bearer-only policy) to ignore cookies.
   */
  readonly sessions?: CredentialSessionPolicy;
}

/**
 * Extracts `Authorization: Bearer ship_s_…`, or the session cookie when the
 * module enables it and no bearer header is present, plus the client facts,
 * without trusting anything else. With a cookie transport the adapter
 * requires `credentialSessionCsrfPolicy()` under the adapter's `"*"` key, so
 * `createHonoAdapter` fails at construction rather than serving cookie
 * sessions without CSRF protection.
 */
export function credentialSessionCredentials(
  options: CredentialSessionCredentialOptions = {},
): HonoCredentialAdapter<CredentialSessionCredential> {
  const header = (options.header ?? "authorization").toLowerCase();
  const cookie: CredentialSessionCookiePolicy | undefined = options.sessions?.transports.includes(
    "cookie",
  )
    ? options.sessions.cookie
    : undefined;
  const requires = credentialSessionCsrfRequirement(options.sessions);
  return defineHonoCredentialAdapter({
    id: "ship-credentials.bearer",
    ...(requires.length > 0 ? { requires } : {}),
    extract(request): CredentialSessionCredential {
      const client = readRequestClient(request);
      const value = request.headers.get(header);
      if (value !== null) {
        const match = BEARER_PATTERN.exec(value);
        const token = match?.[1];
        if (!isTokenShaped(token, SESSION_TOKEN_PREFIX)) {
          return Object.freeze({ kind: "ship-credentials.invalid", client, transport: "bearer" });
        }
        return Object.freeze({
          kind: "ship-credentials.session",
          token,
          client,
          transport: "bearer",
        });
      }
      const fromCookie = cookie ? readSessionCookie(request, cookie) : undefined;
      if (fromCookie === undefined) {
        return Object.freeze({ kind: "ship-credentials.anonymous", client });
      }
      if (!isTokenShaped(fromCookie, SESSION_TOKEN_PREFIX)) {
        return Object.freeze({ kind: "ship-credentials.invalid", client, transport: "cookie" });
      }
      return Object.freeze({
        kind: "ship-credentials.session",
        token: fromCookie,
        client,
        transport: "cookie",
      });
    },
  });
}

export interface ResolveCredentialActorRequest {
  readonly account: AuthAccount;
  readonly session: AuthSession;
  readonly operation: ActorResolutionRequest<CredentialSessionCredential>["operation"];
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface CredentialActorResolverOptions {
  readonly store: CredentialStore;
  /**
   * Builds the actor from the account and session: map roles to permissions
   * here, and drop sensitive permissions when `session.mfaState` is not
   * `verified` to require MFA per surface. Return `null` to refuse. Defaults
   * to a human actor with the account id and no permissions.
   */
  readonly resolveActor?: (
    request: ResolveCredentialActorRequest,
  ) => OperationActorInput | null | Promise<OperationActorInput | null>;
  /**
   * Operation ids a `pending-enrolment` session may still reach (the
   * enrolment flow itself). Defaults to the auth module's enrol, confirm,
   * sign-out and me operations under the given module id.
   */
  readonly enrolmentOperations?: readonly string[];
  /** The auth module id, used for the default `enrolmentOperations`. Defaults to `auth`. */
  readonly moduleId?: string;
  /** Idle timeout and touch interval come from the module policies; pass the same values. */
  readonly session?: { readonly idleTimeoutMs?: number; readonly touchIntervalMs?: number };
  readonly clients?: RequestClientRegistry;
  readonly clock?: () => Date;
}

/**
 * Resolves a session bearer to an actor: the session must be live and not
 * revoked, created after the account's `sessionsInvalidBefore` cutoff, and
 * the account active. The identity is the session
 * (`ship-credentials.session` / session id); the actor is the account.
 *
 * A session that arrived in the cookie and cannot be resolved (unknown,
 * revoked, expired, idle, cut off, malformed) counts as absent on a public
 * operation and is refused on an authenticated one. The cookie is ambient:
 * the browser keeps sending it after a revoke-all, and sign-in must still be
 * reachable to replace it. A bearer is presented deliberately and keeps the
 * ADR-0004 rule that a present invalid credential is refused everywhere.
 */
export function credentialActorResolver(
  options: CredentialActorResolverOptions,
): ActorResolver<CredentialSessionCredential> {
  assertResolverOptions(options);
  const clock = options.clock ?? (() => new Date());
  const moduleId = options.moduleId ?? "auth";
  const enrolment = new Set(
    options.enrolmentOperations ?? [
      `${moduleId}.totp.enrol`,
      `${moduleId}.totp.confirm`,
      `${moduleId}.sign-out`,
      `${moduleId}.me`,
    ],
  );
  const idleTimeoutMs = options.session?.idleTimeoutMs ?? 0;
  const touchIntervalMs = options.session?.touchIntervalMs ?? 60_000;

  return defineActorResolver({
    id: "ship-credentials.actors",
    async resolve(request): Promise<ActorResolution> {
      const credential = request.credential;
      if (credential !== undefined) {
        options.clients?.record(request.requestId, {
          ...credential.client,
          ...(credential.kind === "ship-credentials.anonymous"
            ? {}
            : { sessionTransport: credential.transport }),
        });
      }
      const anonymousAllowed =
        request.operation.access.kind === "public" ||
        request.operation.access.kind === "optional-identity";
      if (credential === undefined || credential.kind === "ship-credentials.anonymous") {
        return anonymousAllowed ? { ok: true } : { ok: false, reason: "invalid-credential" };
      }
      const stale = (): ActorResolution =>
        credential.transport === "cookie" && anonymousAllowed
          ? { ok: true }
          : { ok: false, reason: "invalid-credential" };
      if (credential.kind === "ship-credentials.invalid") return stale();
      if (request.signal?.aborted) return { ok: false, reason: "unavailable" };

      let session: AuthSession | undefined;
      let account: AuthAccount | undefined;
      const now = clock();
      try {
        session = await options.store.findSessionByTokenHash(hashToken(credential.token));
        account = session ? await options.store.findAccount(session.accountId) : undefined;
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (!session || !account) return stale();
      if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) return stale();
      if (idleTimeoutMs > 0 && now.getTime() - session.lastSeenAt.getTime() > idleTimeoutMs) {
        return stale();
      }
      if (
        account.sessionsInvalidBefore !== undefined &&
        session.createdAt.getTime() < account.sessionsInvalidBefore.getTime()
      ) {
        return stale();
      }
      if (account.status !== "active") return { ok: false, reason: "forbidden" };
      if (session.mfaState === "pending-enrolment" && !enrolment.has(request.operation.id)) {
        return { ok: false, reason: "forbidden" };
      }
      if (now.getTime() - session.lastSeenAt.getTime() >= touchIntervalMs) {
        try {
          await options.store.touchSession(session.id, now);
        } catch {
          // Presence bookkeeping must never fail a request.
        }
      }

      const identity = operationIdentity({
        provider: CREDENTIAL_IDENTITY_PROVIDER,
        subject: session.id,
      });
      let actor: OperationActorInput | null;
      try {
        actor = options.resolveActor
          ? await options.resolveActor({
              account,
              session,
              operation: request.operation,
              requestId: request.requestId,
              ...(request.signal ? { signal: request.signal } : {}),
            })
          : operationActor({ id: account.id });
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (actor === null) {
        return anonymousAllowed ? { ok: true, identity } : { ok: false, reason: "forbidden" };
      }
      const normalized = normalizeOperationActor(actor);
      if (!normalized) {
        throw new TypeError("credential resolveActor must return an operation actor or null");
      }
      if (normalized.id !== account.id) {
        throw new TypeError("credential resolveActor must keep the account id as the actor id");
      }
      return { ok: true, identity, actor: normalized };
    },
  });
}

export interface CredentialAuthenticationOptions
  extends CredentialActorResolverOptions,
    CredentialSessionCredentialOptions {}

/** Both halves for `createHonoAdapter({ auth })`. */
export function credentialAuthentication(
  options: CredentialAuthenticationOptions,
): HonoAuthenticationOptions<CredentialSessionCredential> {
  return Object.freeze({
    credentials: credentialSessionCredentials(options),
    actors: credentialActorResolver(options),
  });
}

function assertResolverOptions(options: CredentialActorResolverOptions): void {
  if (typeof options?.store !== "object" || options.store === null) {
    throw new TypeError("credential authentication requires a store");
  }
  if (options.resolveActor !== undefined && typeof options.resolveActor !== "function") {
    throw new TypeError("credential resolveActor must be a function");
  }
}
