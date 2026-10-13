const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*(?:[.:][a-z][a-z0-9-]*)+$/;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

export interface PublicAccess {
  readonly kind: "public";
}

export interface AuthenticatedAccess {
  readonly kind: "authenticated";
}

/**
 * Accepts an anonymous request or a verified external identity. Application
 * actor resolution remains optional so onboarding and `/me`-style endpoints
 * can distinguish an unknown account from a missing credential.
 */
export interface OptionalIdentityAccess {
  readonly kind: "optional-identity";
}

export interface PermissionAccess {
  readonly kind: "permissions";
  readonly mode: "all" | "any";
  readonly permissions: readonly string[];
}

/** Only `system` actors (schedulers, dispatchers, job runners). Grants nothing else. */
export interface SystemAccess {
  readonly kind: "system";
}

/** Only `provider` actors verified against the named provider. */
export interface ProviderAccess {
  readonly kind: "provider";
  readonly provider: string;
}

export type OperationAccess =
  | PublicAccess
  | OptionalIdentityAccess
  | AuthenticatedAccess
  | PermissionAccess
  | SystemAccess
  | ProviderAccess;

export function publicAccess(): PublicAccess {
  return Object.freeze({ kind: "public" });
}

export function authenticatedAccess(): AuthenticatedAccess {
  return Object.freeze({ kind: "authenticated" });
}

export function optionalIdentityAccess(): OptionalIdentityAccess {
  return Object.freeze({ kind: "optional-identity" });
}

export function systemAccess(): SystemAccess {
  return Object.freeze({ kind: "system" });
}

export function providerAccess(provider: string): ProviderAccess {
  if (typeof provider !== "string" || !PROVIDER_ID_PATTERN.test(provider)) {
    throw new TypeError(
      `provider access requires a lowercase dot-separated provider id; received ${JSON.stringify(provider)}`,
    );
  }
  return Object.freeze({ kind: "provider", provider });
}

export function permission(...permissions: string[]): PermissionAccess {
  return permissionsAccess("all", permissions);
}

export function anyPermission(...permissions: string[]): PermissionAccess {
  return permissionsAccess("any", permissions);
}

function permissionsAccess(
  mode: PermissionAccess["mode"],
  permissions: readonly string[],
): PermissionAccess {
  if (permissions.length === 0) {
    throw new TypeError(`${mode} permission access requires at least one permission`);
  }

  const unique = new Set<string>();
  for (const permission of permissions) {
    if (!PERMISSION_PATTERN.test(permission)) {
      throw new TypeError(
        `permission must be a lowercase namespaced identifier using dots or colons; received ${JSON.stringify(permission)}`,
      );
    }
    if (unique.has(permission)) {
      throw new TypeError(
        `permission access contains duplicate permission ${JSON.stringify(permission)}`,
      );
    }
    unique.add(permission);
  }

  return Object.freeze({
    kind: "permissions",
    mode,
    permissions: Object.freeze([...permissions]),
  });
}

export function isOperationAccess(value: unknown): value is OperationAccess {
  if (typeof value !== "object" || value === null) return false;

  const kind = Reflect.get(value, "kind");
  if (
    kind === "public" ||
    kind === "optional-identity" ||
    kind === "authenticated" ||
    kind === "system"
  ) {
    return true;
  }
  if (kind === "provider") {
    const provider = Reflect.get(value, "provider");
    return typeof provider === "string" && PROVIDER_ID_PATTERN.test(provider);
  }
  if (kind !== "permissions") return false;

  const mode = Reflect.get(value, "mode");
  const permissions = Reflect.get(value, "permissions");
  return (
    (mode === "all" || mode === "any") &&
    Array.isArray(permissions) &&
    permissions.length > 0 &&
    permissions.every(
      (permission, index) =>
        typeof permission === "string" &&
        PERMISSION_PATTERN.test(permission) &&
        permissions.indexOf(permission) === index,
    )
  );
}
