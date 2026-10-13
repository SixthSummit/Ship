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
import type { App } from "firebase-admin/app";
import { type DecodedIdToken, getAuth } from "firebase-admin/auth";

const DEFAULT_MAX_TOKEN_LENGTH = 8_192;
const BEARER_PATTERN = /^Bearer[\t ]+(\S+)[\t ]*$/iu;

export type FirebaseCredentialSource = "authorization" | "x-forwarded-authorization";

export type FirebaseCredential =
  | {
      readonly kind: "firebase.id-token";
      readonly token: string;
      readonly source: FirebaseCredentialSource;
    }
  | {
      readonly kind: "firebase.invalid-credential";
      readonly reason: "malformed" | "too-large";
      readonly source: FirebaseCredentialSource;
    };

export interface FirebaseBearerCredentialOptions {
  /** @deprecated Use `forwardedAuthorization: "fallback"`. */
  readonly allowForwardedAuthorization?: boolean;
  /** Trust only when the named proxy boundary overwrites this header. */
  readonly forwardedAuthorization?: FirebaseForwardedAuthorizationPolicy;
  readonly maxTokenLength?: number;
}

export type FirebaseForwardedAuthorizationPolicy = "disabled" | "fallback" | "prefer";

export interface FirebaseTokenVerifier {
  verifyIdToken(token: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
}

export interface ResolveFirebaseActorRequest {
  readonly uid: string;
  readonly token: DecodedIdToken;
  readonly operation: ActorResolutionRequest<FirebaseCredential>["operation"];
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface FirebaseActorResolverOptions {
  /** Application-owned account, tenant, and permission lookup. */
  readonly resolveActor: (
    request: ResolveFirebaseActorRequest,
  ) => OperationActorInput | null | Promise<OperationActorInput | null>;
  readonly checkRevoked?: boolean;
  readonly firebaseApp?: App;
  /** Explicit verifier injection for tests, emulators, or multi-runtime composition. */
  readonly verifier?: FirebaseTokenVerifier;
}

export interface FirebaseAuthenticationOptions
  extends FirebaseActorResolverOptions,
    FirebaseBearerCredentialOptions {}

/** Extract one strict bearer credential without trusting proxy headers by default. */
export function firebaseBearerCredentials(
  options: FirebaseBearerCredentialOptions = {},
): HonoCredentialAdapter<FirebaseCredential> {
  const forwardedPolicy = readForwardedPolicy(options);
  const maxTokenLength = options.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH;
  if (!Number.isSafeInteger(maxTokenLength) || maxTokenLength <= 0) {
    throw new TypeError("Firebase maxTokenLength must be a positive safe integer");
  }

  return defineHonoCredentialAdapter({
    id: "firebase.bearer",
    extract(request) {
      const direct = request.headers.get("authorization");
      const forwarded = request.headers.get("x-forwarded-authorization");
      if (forwardedPolicy === "prefer" && forwarded !== null) {
        return parseBearer(forwarded, "x-forwarded-authorization", maxTokenLength);
      }
      if (direct !== null) return parseBearer(direct, "authorization", maxTokenLength);
      if (forwardedPolicy === "fallback" && forwarded !== null) {
        return parseBearer(forwarded, "x-forwarded-authorization", maxTokenLength);
      }
      return undefined;
    },
  });
}

function readForwardedPolicy(
  options: FirebaseBearerCredentialOptions,
): FirebaseForwardedAuthorizationPolicy {
  if (
    options.forwardedAuthorization !== undefined &&
    options.allowForwardedAuthorization !== undefined
  ) {
    throw new TypeError(
      "Firebase forwarded authorization accepts the policy or deprecated boolean, not both",
    );
  }
  const policy =
    options.forwardedAuthorization ??
    (options.allowForwardedAuthorization === true ? "fallback" : "disabled");
  if (policy !== "disabled" && policy !== "fallback" && policy !== "prefer") {
    throw new TypeError("Firebase forwarded authorization policy is invalid");
  }
  return policy;
}

/** Verify Firebase ID tokens and delegate domain actor construction to the application. */
export function firebaseActorResolver(
  options: FirebaseActorResolverOptions,
): ActorResolver<FirebaseCredential> {
  assertResolverOptions(options);
  const verifier = options.verifier ?? getAuth(options.firebaseApp);

  return defineActorResolver({
    id: "firebase.actors",
    async resolve(request): Promise<ActorResolution> {
      if (request.credential === undefined) {
        return request.operation.access.kind === "public" ||
          request.operation.access.kind === "optional-identity"
          ? { ok: true }
          : { ok: false, reason: "invalid-credential" };
      }
      if (request.credential.kind === "firebase.invalid-credential") {
        return { ok: false, reason: "invalid-credential" };
      }
      if (request.signal?.aborted) return { ok: false, reason: "unavailable" };

      let decoded: DecodedIdToken;
      try {
        decoded = await verifier.verifyIdToken(
          request.credential.token,
          options.checkRevoked === true,
        );
      } catch (error) {
        return {
          ok: false,
          reason: isInvalidFirebaseCredentialError(error) ? "invalid-credential" : "unavailable",
        };
      }

      let actor: OperationActorInput | null;
      try {
        actor = await options.resolveActor({
          uid: decoded.uid,
          token: decoded,
          operation: request.operation,
          requestId: request.requestId,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch {
        return { ok: false, reason: "unavailable" };
      }

      const identity = operationIdentity({ provider: "firebase", subject: decoded.uid });
      if (actor === null) {
        return request.operation.access.kind === "public" ||
          request.operation.access.kind === "optional-identity"
          ? { ok: true, identity }
          : { ok: false, reason: "forbidden" };
      }
      const normalized = normalizeOperationActor(actor);
      if (!normalized) {
        throw new TypeError("Firebase resolveActor must return an operation actor or null");
      }
      return { ok: true, identity, actor: operationActor(normalized) };
    },
  });
}

/** Compose both adapter halves for `createHonoAdapter({ auth })`. */
export function firebaseAuthentication(
  options: FirebaseAuthenticationOptions,
): HonoAuthenticationOptions<FirebaseCredential> {
  return Object.freeze({
    credentials: firebaseBearerCredentials(options),
    actors: firebaseActorResolver(options),
  });
}

function parseBearer(
  value: string,
  source: FirebaseCredentialSource,
  maxTokenLength: number,
): FirebaseCredential {
  const match = BEARER_PATTERN.exec(value);
  if (!match) {
    return Object.freeze({ kind: "firebase.invalid-credential", reason: "malformed", source });
  }
  const token = match[1]!;
  if (token.length > maxTokenLength) {
    return Object.freeze({ kind: "firebase.invalid-credential", reason: "too-large", source });
  }
  return Object.freeze({ kind: "firebase.id-token", token, source });
}

function assertResolverOptions(options: FirebaseActorResolverOptions): void {
  if (typeof options?.resolveActor !== "function") {
    throw new TypeError("Firebase authentication requires resolveActor(request)");
  }
  if (options.verifier !== undefined && typeof options.verifier.verifyIdToken !== "function") {
    throw new TypeError("Firebase verifier must define verifyIdToken(token, checkRevoked)");
  }
  if (options.verifier !== undefined && options.firebaseApp !== undefined) {
    throw new TypeError("Firebase authentication accepts verifier or firebaseApp, not both");
  }
}

function isInvalidFirebaseCredentialError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
      ? String(Reflect.get(error, "code"))
      : "";
  return [
    "auth/argument-error",
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/invalid-id-token",
    "auth/tenant-id-mismatch",
    "auth/user-disabled",
  ].some((suffix) => code.endsWith(suffix));
}
