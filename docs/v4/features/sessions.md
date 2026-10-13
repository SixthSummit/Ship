# JWT sessions and cookies

> **Compatibility feature:** these session APIs remain available from the
> monolithic v4 package. Focused operation access consumes resolved identities
> and actors without selecting a browser-session implementation in the kernel.

The operational layer on top of `JwtSigner`, `AuthFlow`, and `RefreshTokenStore` (covered conceptually in [authentication](../concepts/authentication.md)). This page is for production: how to rotate signing keys, what cookie attributes to set, recommended TTLs, the JWKS endpoint pattern, and what reuse-detection actually does.

## Cookie strategy

The framework ships two cookies for JWT cookie-auth:

```
ship_access     (path=/)              short-lived JWT, sent on every request
ship_refresh    (path=/auth/refresh)  long-lived opaque token, sent only to the refresh endpoint
```

The path scoping on `ship_refresh` is deliberate. The refresh token is more dangerous than the access token — if leaked, an attacker can mint new access tokens for the lifetime of the refresh window. Scoping to `/auth/refresh` means the cookie only ships to the rotation endpoint; an XSS on any other path can't exfiltrate it via cookie.

### Setting cookies

```ts
import { setAuthCookies, clearAuthCookies, readRefreshCookie } from "@sixthsummit/ship-api";

// On login (after exchanging Firebase / OAuth for a session):
const pair = await flow.issue({ accountId: account.id, ip: c.req.header("x-forwarded-for"), userAgent: c.req.header("user-agent") });
setAuthCookies(c, pair, {
  secure: env.NODE_ENV === "production",
  sameSite: "Lax",
});
return c.json({ ok: true });

// On refresh (POST /auth/refresh):
const presentedRefresh = readRefreshCookie(c);
if (!presentedRefresh) throw new AuthenticationError("Missing refresh token");
const newPair = await flow.rotate(presentedRefresh, { ip: c.req.header("x-forwarded-for") });
setAuthCookies(c, newPair);
return c.json({ ok: true });

// On logout:
const presentedRefresh = readRefreshCookie(c);
if (presentedRefresh) await flow.revoke(presentedRefresh);
clearAuthCookies(c);
return c.json({ ok: true });
```

### Cookie attributes (locked defaults)

Both cookies:

- **`HttpOnly: true`** — JavaScript can't read them. Defeats the most common XSS attack on session tokens.
- **`Secure`** — `true` in production (sent only over HTTPS), `false` for `localhost` development. The framework reads `NODE_ENV` to decide; override via `setAuthCookies(c, pair, { secure: false })` if you need it.
- **`SameSite: Lax`** — sent on top-level navigations and same-site requests; not on cross-site iframes / fetch. Reasonable default for first-party apps.
- **`Path`** — `/` for access, `/auth/refresh` for refresh.
- **`maxAge`** — computed from the token's `expiresAt`. Browser drops the cookie at the same time the server stops accepting the token.

For multi-subdomain apps (`app.example.com` calls `api.example.com`), set `Domain` to the parent:

```ts
setAuthCookies(c, pair, { domain: ".example.com" });
```

For tighter security on mutation endpoints — and apps deployed as iframes inside other origins — switch to `SameSite: Strict`. Tradeoff: a user clicking a link from a different site won't carry their session.

## TTL recommendations

| Token | Default | Rationale |
| --- | --- | --- |
| Access | 15 min | Stateless verify on every request — short TTL bounds blast radius if leaked. Long enough that browser clock skew isn't an issue. |
| Refresh | 30 days | Long enough that users don't re-auth weekly. Reuse-detection limits damage from theft. |

These are the framework's defaults. Tune by use case:

- **High-sensitivity apps** (banking, healthcare) — drop refresh to 7 days; force re-auth more often.
- **B2B apps with long-running sessions** — extend refresh to 90 days.
- **Mobile-first apps** — extend refresh to 90+ days; users hate re-authenticating mobile apps.

Set via `AuthFlow` constructor:

```ts
const flow = new AuthFlow({
  signer,
  refreshTokenStore,
  accessTokenTtlSec: 15 * 60,           // 15 minutes
  refreshTokenTtlSec: 30 * 24 * 60 * 60, // 30 days
});
```

## Key rotation procedure

ES256 keys are not forever. Rotate them periodically (yearly is reasonable; faster if you suspect compromise). The procedure is dual-verification with a grace window:

### 1. Generate the new key

```ts
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";

const generate = promisify(generateKeyPair);
const { privateKey, publicKey } = await generate("ec", { namedCurve: "P-256" });
```

Store the private key in your secret manager. Keep the kid (`"k2"`) for reference.

### 2. Add new key to verification, keep old key signing

```ts
const signer = new JwtSigner({
  signingKey: { kid: "k1", privateKey: oldPrivateKey },         // still signing with old
  verificationKeys: [
    { kid: "k1", publicKey: oldPublicKey },
    { kid: "k2", publicKey: newPublicKey },                     // accept new for verification
  ],
});
```

Deploy this change. Now the server accepts tokens signed with either key, but only mints with the old. This step exists in case anything goes wrong with the new key — you can roll back without invalidating sessions.

### 3. Cut signing over

```ts
const signer = new JwtSigner({
  signingKey: { kid: "k2", privateKey: newPrivateKey },         // sign with new
  verificationKeys: [
    { kid: "k1", publicKey: oldPublicKey },                     // still accept old
    { kid: "k2", publicKey: newPublicKey },
  ],
});
```

All new tokens sign with `k2`. Existing access tokens (signed with `k1`) verify until they naturally expire — 15 minutes for the default access TTL.

### 4. Wait for the token lifetime

Wait at least `accessTokenTtlSec` so all tokens signed before step 3 expire. After this, no in-the-wild token uses `k1`.

### 5. Retire the old key

```ts
const signer = new JwtSigner({
  signingKey: { kid: "k2", privateKey: newPrivateKey },
  verificationKeys: [
    { kid: "k2", publicKey: newPublicKey },                     // k1 dropped
  ],
});
```

Tokens signed with `k1` now fail verification. The rotation is complete.

The whole procedure spans `accessTokenTtlSec + safety margin` — typically an hour total wall-clock. Faster rotation is possible but riskier; slower rotation is fine if you're not under time pressure.

For refresh tokens, the rotation is automatic — they're opaque tokens (not JWTs), so refresh-token signing isn't affected by this. Each refresh-token rotation event during the grace window mints with the new signing key.

## JWKS endpoint

If you have downstream services that verify your tokens (microservices, server-to-server JWTs), publish a JWKS endpoint:

```ts
import { exportJWK } from "jose";

app.get("/.well-known/jwks.json", async (c) => {
  const verificationKids = signer.getVerificationKids();
  // Export each public key as JWK
  const keys = await Promise.all(
    verificationKids.map(async (kid) => {
      const key = signer.getVerificationKey(kid);   // helper you wrap around your key store
      const jwk = await exportJWK(key);
      return { ...jwk, kid, alg: "ES256", use: "sig" };
    }),
  );
  return c.json({ keys });
});
```

Downstream services fetch this endpoint, cache the keys, and verify tokens locally. The framework's helper APIs (`getSigningKid`, `getVerificationKids`) make the endpoint easy to compose; the framework doesn't ship the route itself because the cache strategy and access control are app-specific.

## Refresh-token reuse detection

The most important security property of `AuthFlow.rotate`:

```
Refresh tokens are stored as SHA-256 hashes (never raw bytes).
On rotation, the old row's `replacedById` is set to the new row's id.
If a refresh token is presented for rotation AND its `replacedById` is already set,
the entire chain (every descendant via `replacedById`) is revoked.
```

Why this matters:

- **Legitimate flow**: client presents `R1`, gets `R2`. Client presents `R2`, gets `R3`. Each rotation invalidates the previous.
- **Attack flow**: attacker steals `R1`, presents it, gets `R2'`. Attacker uses `R2'`. Meanwhile the legitimate user (who hasn't refreshed yet) still has `R1` cached. User presents `R1` → server sees `R1.replacedById = R2'.id` → **the whole chain is killed**. Attacker's `R2'` is now invalid; user has to re-authenticate (visible event), but the attacker's session is also burned.

The cost is a forced re-auth for the legitimate user — visible, recoverable, much better than silent attacker persistence. The mechanism doesn't prevent theft, but it makes theft self-revealing.

## Revocation flows

```ts
// Single token (logout):
await flow.revoke(presentedRefreshToken);

// All sessions for an account (password reset, "sign out everywhere"):
const revoked = await flow.revokeAccount(accountId);
// revoked = count of refresh tokens marked revoked

// Reuse detection (called automatically by rotate; also exposed for manual use):
await refreshTokenStore.revokeChain(suspectId);
```

Three escalation levels:

- **`revoke()`** — one token, one device. Logout.
- **`revokeChain()`** — one rotation chain, one device. Security incident on a specific session.
- **`revokeAccount()`** — every active session for an account. Password change, account compromise, key rotation incident.

Access tokens can't be revoked individually (they're stateless JWTs — verification doesn't hit the database). The closest thing is a short access TTL (15 min); revocation effectively waits for the access token to expire. For instant revocation of access tokens, switch to a stateful access-token model (database lookup on every request); the framework's default cookie-auth chooses statelessness for performance.

## CSRF for cookie auth

Cookie-based auth is vulnerable to CSRF (cross-site request forgery) — a malicious site can submit a form to your endpoint, the browser ships the cookie, the server believes the request is from the user. Two mitigations:

**SameSite cookies (the default).** `SameSite: Lax` means the cookie isn't sent on cross-site fetches / form submits, only on top-level navigations from the same site. This blocks the most common CSRF patterns.

**The `csrf()` middleware.** For tighter protection (multi-subdomain apps where SameSite alone isn't enough; iframed apps), add the framework's CSRF middleware:

```ts
import { csrf } from "@sixthsummit/ship-api";

app.use(csrf({
  allowedOrigins: ["https://app.example.com"],
  doubleSubmit: true,                   // require X-CSRF-Token header on mutations
}));
```

Default mode (origin-check only): mutating requests must carry an `Origin` or `Referer` header that matches `allowedOrigins`. `Sec-Fetch-Site: cross-site` is rejected outright (modern browsers).

Hardened mode (`doubleSubmit: true`): on safe requests without a `ship_csrf` cookie, issues one (24-bit random, base64url, *not* HttpOnly so client JS can read it). On mutating requests, requires the client to echo the cookie value in `X-CSRF-Token`. Comparison uses `timingSafeEqual`.

The double-submit pattern works because cross-site attackers can't read the cookie value (cross-origin) and therefore can't submit the matching header.

## Operational concerns

**Refresh-token storage size.** Every active session is a row. For an app with 1M users averaging 2 active devices, that's 2M rows in `refresh_tokens`. Index on `tokenHash` is essential; periodic cleanup of expired rows is good hygiene (a `DELETE FROM refresh_tokens WHERE expiresAt < now() - interval '30 days'` cron).

**Audit trail per session.** The `refresh_tokens` table includes `userAgent` and `issuedFromIp`. Surface these in the user's "active sessions" UI so they can see "iPhone, Chicago, last used 5 minutes ago" — and revoke individual sessions. The data is already there; just needs a route that queries it.

**Don't store the access token.** The whole point of stateless JWT is that you don't need to. Storing access tokens defeats the model and creates a hot-path database lookup on every request. Revoke via short TTL + refresh-token revocation; that's the contract.

**Test reuse detection.** It's the load-bearing security property. A test that presents the same refresh token twice and asserts the second call fails (and that the entire chain is dead) is worth writing. The framework's test suite has these; mirror the pattern in your app's auth tests if you've extended the flow.

## Source

- [`packages/core/src/app/auth/jwt/JwtSigner.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/jwt/JwtSigner.ts) — ES256 sign/verify, key rotation
- [`packages/core/src/app/auth/jwt/AuthFlow.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/jwt/AuthFlow.ts) — issue / rotate / revoke
- [`packages/core/src/app/auth/jwt/RefreshTokenStore.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/jwt/RefreshTokenStore.ts) — persistence interface, reuse detection
- [`packages/core/src/http/utils/authCookies.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/utils/authCookies.ts) — cookie helpers
- [`packages/core/src/app/auth/adapters/jwtCookie.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/auth/adapters/jwtCookie.ts) — `AuthProvider` adapter for cookie-based JWT auth
- [`packages/core/src/http/middleware/csrf.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/middleware/csrf.ts) — CSRF middleware
- [authentication](../concepts/authentication.md) — the conceptual layer this page builds on
