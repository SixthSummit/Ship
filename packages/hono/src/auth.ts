import type { ActorResolver } from "@sixthsummit/ship-core";

const CREDENTIAL_ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const POLICY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

/**
 * A pre-validation policy a credential adapter cannot be used without. The
 * adapter that reads an ambient credential (a session cookie) names the
 * transport guard (a CSRF policy) that must run on every operation; without
 * it the credential would be accepted with no cross-site protection.
 * `createHonoAdapter` checks each requirement at construction: the policy
 * registered under `key` (alone or in a list) must carry `policyId` (see
 * `definePreValidationPolicy`), or construction fails with
 * `SHIP_HONO_OPTIONS_INVALID` and `message`.
 */
export interface HonoPolicyRequirement {
  /** The `preValidationPolicies` key the policy must be registered under: `"*"` or an operation id. */
  readonly key: string;
  /** The id the registered policy must carry. */
  readonly policyId: string;
  /** The construction-time diagnostic when the policy is missing: what to register and why. */
  readonly message: string;
}

export interface HonoCredentialAdapter<TCredential = unknown> {
  readonly id: string;
  extract(request: Request): TCredential | undefined | Promise<TCredential | undefined>;
  /** Policies this adapter cannot safely be used without; checked by `createHonoAdapter`. */
  readonly requires?: readonly HonoPolicyRequirement[];
}

export interface HonoAuthenticationOptions<TCredential = unknown> {
  readonly credentials: HonoCredentialAdapter<TCredential>;
  readonly actors: ActorResolver<TCredential>;
}

export type HeaderCredential = Readonly<Record<string, string>>;

export function defineHonoCredentialAdapter<TCredential>(
  adapter: HonoCredentialAdapter<TCredential>,
): HonoCredentialAdapter<TCredential> {
  if (typeof adapter?.id !== "string" || !CREDENTIAL_ADAPTER_ID_PATTERN.test(adapter.id)) {
    throw new TypeError(
      `credential adapter id must be a lowercase dot-separated identifier; received ${JSON.stringify(adapter.id)}`,
    );
  }
  if (typeof adapter.extract !== "function") {
    throw new TypeError("credential adapter must define extract(request)");
  }
  if (adapter.requires !== undefined) {
    if (!Array.isArray(adapter.requires) || !adapter.requires.every(isPolicyRequirement)) {
      throw new TypeError(
        "credential adapter requires must be an array of { key, policyId, message } entries",
      );
    }
  }
  return Object.freeze({
    ...adapter,
    ...(adapter.requires !== undefined
      ? { requires: Object.freeze(adapter.requires.map((entry) => Object.freeze({ ...entry }))) }
      : {}),
  });
}

function isPolicyRequirement(value: unknown): value is HonoPolicyRequirement {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "key") === "string" &&
    Reflect.get(value, "key").length > 0 &&
    typeof Reflect.get(value, "policyId") === "string" &&
    POLICY_ID_PATTERN.test(Reflect.get(value, "policyId")) &&
    typeof Reflect.get(value, "message") === "string" &&
    Reflect.get(value, "message").length > 0
  );
}

export function isHonoCredentialAdapter(value: unknown): value is HonoCredentialAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "string" &&
    CREDENTIAL_ADAPTER_ID_PATTERN.test(Reflect.get(value, "id")) &&
    typeof Reflect.get(value, "extract") === "function"
  );
}

export function requestHeadersCredential(): HonoCredentialAdapter<HeaderCredential> {
  return defineHonoCredentialAdapter({
    id: "http.headers",
    extract: (request) =>
      Object.freeze(
        Object.fromEntries(
          [...request.headers].map(([name, value]) => [name.toLowerCase(), value]),
        ),
      ),
  });
}
