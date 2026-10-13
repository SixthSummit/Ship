# Authentication

> **Compatibility guide:** this page documents the monolithic v4 alpha auth and
> route-middleware surface. New operation applications use transport-independent
> actors/access policies and install provider adapters such as
> `@sixthsummit/ship-auth-firebase` only at composition.

The pluggable `AuthProvider` interface, the Firebase adapter the framework ships as the default, the `requireAuth` middleware that wires it into routes, and the JWT layer underneath cookie-based session auth.

## The `AuthProvider` interface

Every authenticated route runs through `requireAuth({ provider })`. The provider is the seam — Firebase, Better Auth, Clerk, a custom JWKS verifier, anything that fits the contract:

```ts
// packages/core/src/app/auth/AuthProvider.ts
export interface AuthProvider<TAccount extends AuthenticatedAccount = AuthenticatedAccount> {
  readonly name: string;
  verify(ctx: AuthProviderContext): Promise<AuthVerifyResult>;
  resolve(claims: AuthClaims): Promise<TAccount | null>;
  onMissingToken?: "reject" | "next";
  onUnknownAccount?: "reject" | "create" | "next";
}

export type AuthVerifyResult =
  | { ok: true; claims: AuthClaims }
  | { ok: false; reason: AuthFailureReason; message?: string };

export type AuthFailureReason =
  | "missing-token" | "invalid-token" | "expired-token"
  | "revoked-token" | "issuer-mismatch" | "provider-error";

export interface AuthClaims {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  issuedAt?: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface AuthenticatedAccount {
  id: string;
  hasPermission?(slug: string): boolean | Promise<boolean>;
}
```

Two methods, deliberately separate:

- **`verify()` is pure.** Read the credential out of the request, validate it (verify a signature, check expiry, etc.), and return the claims. No database access. This makes verification cacheable and lets the framework reason about it independently.
- **`resolve()` is impure.** Take the verified claims, look up the corresponding `AuthenticatedAccount` in your data store. Return `null` to indicate "valid credential but no matching account."

The split is what lets you swap providers without rewriting permission logic. Whatever calls into `verify` and `resolve`, the downstream context — `c.var.user`, `c.var.claims`, `requirePermission` — sees the same shape.

## `FirebaseAuthProvider` — the default

The framework ships `FirebaseAuthProvider` as a worked example and a default for projects that don't have a strong opinion on auth. It's a thin wrapper around the Firebase Admin SDK:

```ts
import { FirebaseAuthProvider } from "@sixthsummit/ship-api/app/auth/adapters/firebase";

const provider = new FirebaseAuthProvider({
  // Required: how to find an account by Firebase UID + claims
  async findAccount(firebaseUid, claims) {
    const account = await accountService.findByFirebaseUid(firebaseUid);
    if (account) return account;
    // Optional: auto-create on first sign-in
    return await accountService.create({
      firebaseUid,
      email: claims.email!,
      emailVerified: claims.emailVerified ?? false,
      displayName: claims.name,
    });
  },
  checkRevoked: false,                  // Set true to call admin.auth().verifyIdToken(token, true) — costs a round-trip
  onMissingToken: "reject",             // 401 on missing Authorization header (default)
  onUnknownAccount: "reject",           // 401 if findAccount returns null
});
```

The constructor options:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `findAccount` | `(uid, claims) => Promise<TAccount \| null>` | required | Database lookup. Implement to return your account, optionally auto-create. |
| `checkRevoked` | `boolean` | `false` | If true, the Admin SDK checks the revocation list — adds latency. Useful for sensitive sessions. |
| `onMissingToken` | `"reject" \| "next"` | `"reject"` | What to do when no token is present. `"next"` makes the route effectively optional-auth. |
| `onUnknownAccount` | `"reject" \| "create" \| "next"` | `"reject"` | What to do when `findAccount` returns null. |
| `extractToken` | `(ctx) => string \| undefined` | `Authorization: Bearer ...` reader | Override for cookie-based or custom-header credentials. |
| `firebaseApp` | `admin.app.App` | from `FIREBASE_CREDENTIALS` env | Provide a pre-initialized Admin app (testing, multi-project). |

The provider's `verify()` calls `admin.auth().verifyIdToken()`, maps Admin SDK errors to `AuthFailureReason` cases (`expired-token`, `invalid-token`, `revoked-token`, etc.), and returns the claims as a normalized `AuthClaims` shape. `resolve()` calls your `findAccount`.

## Writing a custom provider

A custom provider implements the interface end-to-end. Example: a JWT-based provider for service-to-service calls:

```ts
import type { AuthProvider, AuthProviderContext, AuthVerifyResult } from "@sixthsummit/ship-api/app/auth/AuthProvider";
import { jwtSigner } from "./jwt.js"; // your JwtSigner instance

export class ServiceJwtProvider implements AuthProvider<ServiceAccount> {
  readonly name = "service-jwt";
  readonly onMissingToken = "reject";
  readonly onUnknownAccount = "reject";

  async verify(ctx: AuthProviderContext): Promise<AuthVerifyResult> {
    const auth = ctx.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return { ok: false, reason: "missing-token" };
    }
    const token = auth.slice("Bearer ".length);
    try {
      const { payload } = await jwtSigner.verify(token);
      return {
        ok: true,
        claims: {
          subject: payload.sub!,
          metadata: { scope: payload.scope, audience: payload.aud },
          issuedAt: payload.iat,
          expiresAt: payload.exp,
        },
      };
    } catch (err) {
      return { ok: false, reason: "invalid-token", message: String(err) };
    }
  }

  async resolve(claims: AuthClaims): Promise<ServiceAccount | null> {
    return await serviceAccountService.findById(claims.subject);
  }
}
```

The contract is intentionally narrow: implement the two methods, return the right shapes, set the two policy fields. The framework's `requireAuth` middleware does the rest — converts `AuthVerifyResult` failures into `AuthenticationError`, converts `null` resolves into errors per `onUnknownAccount`, attaches the resolved account to the context.

## `requireAuth` — the middleware

```ts
import { requireAuth } from "@sixthsummit/ship-api";

const auth = requireAuth({ provider });

app.get("/me", auth, (c) => {
  const user = c.var.user;       // AuthenticatedAccount
  const claims = c.var.claims;   // AuthClaims
  return c.json(user);
});
```

The signature:

```ts
export function requireAuth<TAccount extends AuthenticatedAccount>(
  opts: RequireAuthOptions<TAccount>,
): MiddlewareHandler;

export interface RequireAuthOptions<TAccount> {
  provider: AuthProvider<TAccount>;
  optional?: boolean;            // default: false — don't throw on missing token
}
```

What the middleware does, in order:

1. Calls `provider.verify(ctx)`.
2. On `ok: false` — throws `AuthenticationError` with the appropriate message (or returns `next()` if `optional: true` or `onMissingToken: "next"` matches the failure mode).
3. Calls `provider.resolve(claims)`.
4. On `null` resolve — applies `onUnknownAccount` policy (`"reject"` throws, `"create"` is provider-implemented, `"next"` continues without setting `user`).
5. On success — `c.set("user", account)` and `c.set("claims", claims)`.

The middleware tags itself with `AUTH_META` so `createApp`'s route-method interceptor records `auth: { required: true, provider: "<name>" }` in the route registry. The MCP `list_routes` and `describe_route` tools read this metadata; agents can see at a glance which routes are protected and by which provider.

## JWT layer — when you need cookie-based session auth

For first-party web apps, an OAuth / Firebase exchange that produces an access + refresh token pair stored in HttpOnly cookies is often the right shape. The framework ships the building blocks for this without prescribing a flow:

- **`JwtSigner`** — ES256 sign/verify with key rotation (multiple verification keys, one signing key).
- **`AuthFlow`** — orchestrates issue / verify / rotate / revoke against a `RefreshTokenStore`.
- **`RefreshTokenStore`** interface — abstract persistence; the framework includes a Drizzle-backed implementation against the default `refresh_tokens` table.

`JwtSigner`:

```ts
import { JwtSigner } from "@sixthsummit/ship-api/app/auth/jwt/JwtSigner";

const signer = new JwtSigner({
  signingKey: { kid: "current", key: privateKey },          // Sign new tokens with this
  verificationKeys: [
    { kid: "current", key: publicKey },                     // Accept tokens signed with this
    { kid: "previous", key: previousPublicKey },            // Accept tokens during rotation window
  ],
  issuer: "https://api.my-app.com",
  audience: "my-app",
  clockToleranceSec: 5,
});

const token = await signer.sign({
  subject: account.id,
  ttlSec: 60 * 15,            // 15 minute access token
  claims: { scope: "user" },
});

const { payload, kid } = await signer.verify(presentedToken);
```

`AuthFlow` composes the signer with a refresh-token store:

```ts
import { AuthFlow } from "@sixthsummit/ship-api/app/auth/jwt/AuthFlow";

const flow = new AuthFlow({
  signer,
  refreshTokens: refreshTokenStore,
  accessTokenTtlSec: 60 * 15,
  refreshTokenTtlSec: 60 * 60 * 24 * 30,
});

// Issue a fresh pair after Firebase exchange
const pair = await flow.issue({ accountId: account.id });
//   { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, refreshTokenId }

// Verify access token (stateless — JWT signature only)
await flow.verifyAccess(presentedAccessToken);

// Rotate on access-token expiry — exchanges presented refresh for a new pair.
// Re-use detection: if the refresh token was already exchanged, the entire chain is revoked.
const next = await flow.rotate(presentedRefreshToken, { userAgent, ip });

// Logout
await flow.revoke(presentedRefreshToken);

// Revoke all sessions for an account (password reset, etc.)
const count = await flow.revokeAccount(accountId);
```

Two things worth understanding about this layer:

**Refresh-token reuse detection.** When a refresh token is presented for rotation, `AuthFlow.rotate` checks whether the row already has `replacedById` set. If it does — meaning this refresh token was already exchanged once — the entire rotation chain is revoked (every descendant `replacedById` link). This is the standard mitigation against stolen-refresh-token replay attacks.

**Tokens are stored hashed.** The `RefreshTokenStore` stores SHA-256 hashes of refresh tokens, never the raw values. A stolen database row can't be replayed. The raw token only exists in the cookie.

If you don't need cookie-based session auth — for instance, you're using Firebase ID tokens directly with `Authorization: Bearer ...` headers — you don't need this layer at all. `FirebaseAuthProvider` works without it. The JWT layer is a tool for projects that exchange a Firebase / OAuth credential for an app-managed session.

## Middleware ordering

Authentication runs early, before validation. The standard chain on a protected route:

```
httpLogger → requireAuth → requirePermission → validate → handler
```

`requireAuth` must run before `requirePermission` (the latter reads `c.var.user`). `validate` can run in either order relative to auth — placing it after auth is the convention because a 401 is more useful than a 400 on a request the caller isn't allowed to make. `httpLogger` is app-level and runs on every request.

## Source

- [`packages/core/src/app/auth/AuthProvider.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/AuthProvider.ts) — the interface and supporting types
- [`packages/core/src/app/auth/adapters/firebase.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/adapters/firebase.ts) — `FirebaseAuthProvider`
- [`packages/core/src/app/auth/jwt/JwtSigner.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/jwt/JwtSigner.ts) — ES256 signer
- [`packages/core/src/app/auth/jwt/AuthFlow.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/jwt/AuthFlow.ts) — issue/verify/rotate/revoke
- [`packages/core/src/app/auth/jwt/RefreshTokenStore.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/jwt/RefreshTokenStore.ts) — persistence interface + Drizzle adapter
- [`packages/core/src/http/middleware/requireAuth.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/middleware/requireAuth.ts) — the route middleware
- [`.cursor/rules/security.mdc`](https://github.com/sixthsummit/ship-api/blob/main/.cursor/rules/security.mdc) — auth and RBAC conventions
