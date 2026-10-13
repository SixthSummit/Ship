import { defineActorResolver, operationActor } from "@sixthsummit/ship-core";
import {
  type HeaderCredential,
  type HonoAuthenticationOptions,
  requestHeadersCredential,
} from "@sixthsummit/ship-hono";
import type { AuthenticatedAccount, AuthProvider } from "../app/auth/AuthProvider.js";

export * from "@sixthsummit/ship-hono";

/** @deprecated Migration bridge for the monolithic v4 AuthProvider contract. */
export function honoAuthProvider<TAccount extends AuthenticatedAccount>(
  provider: AuthProvider<TAccount>,
): HonoAuthenticationOptions<HeaderCredential> {
  const actors = defineActorResolver<HeaderCredential>({
    id: `v4.${normalizeResolverId(provider.name)}`,
    resolve: async ({ credential, operation }) => {
      try {
        const verification = await provider.verify({ headers: credential ?? {} });
        if (!verification.ok) {
          if (verification.reason === "missing-token") return Object.freeze({ ok: true as const });
          return Object.freeze({
            ok: false as const,
            reason:
              verification.reason === "provider-error"
                ? ("unavailable" as const)
                : ("invalid-credential" as const),
          });
        }

        const account = await provider.resolve(verification.claims);
        if (account === null) {
          return provider.onUnknownAccount === "next"
            ? Object.freeze({ ok: true as const })
            : Object.freeze({ ok: false as const, reason: "forbidden" as const });
        }

        const granted: string[] = [];
        if (operation.access.kind === "permissions" && account.hasPermission) {
          for (const permission of operation.access.permissions) {
            if (await account.hasPermission(permission)) granted.push(permission);
          }
        }
        return Object.freeze({
          ok: true as const,
          actor: operationActor({ id: account.id, permissions: granted }),
        });
      } catch {
        return Object.freeze({ ok: false as const, reason: "unavailable" as const });
      }
    },
  });

  return Object.freeze({ credentials: requestHeadersCredential(), actors });
}

function normalizeResolverId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.length > 0 && /^[a-z]/u.test(normalized) ? normalized : "provider";
}
