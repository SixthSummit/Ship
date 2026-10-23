# First-party credential auth

> **Kernel feature.** `@sixthsummit/ship-auth-credentials` composes password
> accounts, email verification, TOTP MFA with recovery codes, sessions with
> revocation, lockout and an auth audit log as declared operations plus an
> actor provider beside the Firebase resolver ([ADR-0025](../../rearchitecture/decisions/0025-first-party-credential-auth.md)).
> It has no compatibility-line counterpart; the compat `AuthFlow` stays as it is.

| Package | Owns |
| --- | --- |
| `@sixthsummit/ship-auth-credentials` | `defineCredentialAuthModule`, `defineCredentialAuthMailer`, `credentialAuthentication` (adapter + resolver), `credentialAuthRateLimitPolicies`, `credentialSessionCsrfPolicy`, the `CredentialStore` contract and in-memory store, crypto (`argon2idPasswordHasher`, TOTP, tokens, `createSecretBox`), policies, the session cookie policy |
| `…/drizzle` | `shipAuthTables()` and `createDrizzleCredentialStore()` |
| `…/console` | `credentialAuthConsoleExtension()` for `defineConsoleModule({ extensions })` |
| `…/conformance` | `credentialStoreConformance` |
| `@sixthsummit/ship-angular/credential-auth` | `provideShipCredentialAuth`, `ShipCredentialAuth`, `cookieSessionStorage` (the default) and `cookieCredentialCapability`, `memorySessionStorage` / `browserSessionStorage` (bearer), `ShipSignInComponent`, `ShipMfaChallengeComponent`, `ShipRecoveryCodeComponent`, `ShipAuthAuditPanelComponent`, `ShipCredentialAuthContract` |

## 1. Tables and store

```ts
// src/schema.ts
import { shipAuthTables } from "@sixthsummit/ship-auth-credentials/drizzle";
export const { authAccounts, authCredentials, authTokens, authMfaSecrets, authRecoveryCodes, authSessions, authAuditEvents } = shipAuthTables();
```

Generate the migration with `drizzle-kit generate` and apply it through the
gated release step ([schema safety](./schema-safety.md)); the tables are only
ever added to. Bind the store:

```ts
const store = createDrizzleCredentialStore({ database, tables: authTables });
```

`createInMemoryCredentialStore()` serves tests; run `credentialStoreConformance`
against any other implementation.

## 2. Mailer, module and policies

```ts
const mailer = defineCredentialAuthMailer({ from: "App <auth@example.com>", appName: "App" });
const delivery = defineMailDelivery({ mailers: [mailer, ...others] }); // one mail.deliver job

export const auth = defineCredentialAuthModule({
  store,
  mailer,
  mail: delivery.dependency,
  links: {
    verifyEmail: (token) => `${env.APP_URL}/verify/${token}`,
    resetPassword: (token) => `${env.APP_URL}/reset/${token}`,
    signIn: `${env.APP_URL}/sign-in`, // the existing-account notice links here
    changeEmail: (token) => `${env.APP_URL}/email/${token}`,
  },
  secrets: { current: "k1", keys: { k1: env.AUTH_MFA_KEY } },
  policies: {
    password: { minLength: 12, maxLength: 256 },
    lockout: { threshold: 5, windowMs: 15 * 60_000, durationMs: 15 * 60_000 },
    session: { maxAgeMs: 30 * 24 * 60 * 60_000, idleTimeoutMs: 12 * 60 * 60_000 },
    mfa: { required: (account) => account.roles.includes("admin") },
    tokens: { verifyEmailTtlMs: 24 * 60 * 60_000, resetPasswordTtlMs: 60 * 60_000 },
    requireVerifiedEmail: true,
    onExistingEmail: "conceal", // default; "reject" answers 409 and enumerates accounts
  },
  sessions: { transport: "both" }, // bearer (default) | cookie | both; see section 4
  defaultRoles: ["member"],
  clients, // createRequestClientRegistry(), shared with the adapter; required in cookie mode
});
```

The module declares `auth.mailer`, provides and exports the store token, and
imports the modules that export the job backend behind the sender (`imports`,
default `["mail"]`; the customized consumer passes `["portfolio"]`). Mount it like any
module; `createHonoAdapter` projects `/auth/*`.

| Operation | Transport | Access | Result |
| --- | --- | --- | --- |
| `auth.register` | `POST /auth/register` | public | 201 `{ status: "verification-sent" }`; `AUTH_EMAIL_TAKEN` 409, `AUTH_PASSWORD_POLICY` 422 |
| `auth.verify-email` | `POST /auth/verify-email` | public | 200; `AUTH_TOKEN_INVALID` 400 (unknown, expired, used) |
| `auth.resend-verification` | `POST /auth/resend-verification` | public | 202 always |
| `auth.sign-in` | `POST /auth/sign-in` | public | 200 `signed-in` \| `mfa-required` \| `mfa-enrolment-required`; the optional body `transport` (`bearer` \| `cookie`, only the enabled ones validate) picks how the session travels; `AUTH_INVALID_CREDENTIALS` 401, `AUTH_ACCOUNT_LOCKED` 423 + `Retry-After`, `AUTH_EMAIL_UNVERIFIED` 403, `AUTH_ACCOUNT_DISABLED` 403 |
| `auth.totp.verify` / `auth.recovery.consume` | `POST /auth/totp/verify`, `/auth/recovery/consume` | public | 200 `signed-in` (same `transport` field); `AUTH_MFA_INVALID_CODE` / `AUTH_RECOVERY_CODE_INVALID` 401, `AUTH_TOKEN_INVALID` 400 |
| `auth.sign-out`, `auth.me` | `POST /auth/sign-out`, `GET /auth/me` | authenticated | current session |
| `auth.sessions.list` / `.revoke` / `.revoke-all` | `GET /auth/sessions`, `POST /auth/sessions/revoke`, `/auth/sessions/revoke-all` | authenticated | `{ keepCurrent }` on revoke-all |
| `auth.forgot-password` / `auth.reset-password` | `POST /auth/password/forgot`, `/auth/password/reset` | public | 202 always; reset clears the lock and signs every session out |
| `auth.change-password` | `POST /auth/password/change` | authenticated | `{ currentPassword, newPassword, signOutOtherSessions? }`; password re-entry under the lockout policy; 200 `{ changed, revoked, session }` where `session` is the rotated current session (new bearer token, or a new cookie in `Set-Cookie`) and every other session is revoked unless `signOutOtherSessions: false`; `AUTH_INVALID_CREDENTIALS` 401, `AUTH_ACCOUNT_LOCKED` 423, `AUTH_PASSWORD_POLICY` 422 |
| `auth.change-email` / `auth.confirm-email-change` | `POST /auth/email/change`, `/auth/email/confirm` | authenticated / public | password re-entry; mail to the new address |
| `auth.totp.enrol` / `auth.totp.confirm` | `POST /auth/totp/enrol`, `/auth/totp/confirm` | authenticated | password re-entry; confirm returns the recovery codes once and, for a cookie session, the rotated `session` |

Every flow writes an audit row (`register`, `sign-in`, `sign-in.locked`,
`mfa.challenged`, `mfa.verify`, `mfa.recover`, `mfa.enrolled`,
`password.reset`, `password.changed`, `email.changed`, `session.revoke`,
`sessions.revoke-all`, …)
with outcome, request id, ip and user agent, never a secret.

## 3. The actor provider

```ts
const http = createHonoAdapter(app, {
  auth: credentialAuthentication({
    store,
    clients,
    session: auth.policies.session,
    resolveActor: ({ account, session }) =>
      operationActor({
        id: account.id,
        permissions: [
          ...permissionsFor(account.roles),
          // Per-surface MFA: the admin slug only for an MFA-verified session.
          ...(session.mfaState === "verified" ? [CONSOLE_OPERATE_PERMISSION] : []),
        ],
      }),
  }),
  preValidationPolicies: credentialAuthRateLimitPolicies({ max: 10, windowMs: 60_000 }),
});
```

The adapter reads `Authorization: Bearer ship_s_…` (and, with
`sessions: auth.sessions`, the session cookie when no bearer header is
present); the resolver checks the session (unrevoked, within max age and idle
timeout, created after the account's `sessionsInvalidBefore`, account active)
and yields the identity `{ provider: "ship-credentials.session", subject: sessionId }`
and the actor from `resolveActor`. A `pending-enrolment` session reaches only
the enrolment operations, sign-out and `me`. To run beside Firebase, dispatch
on the credential kind (see the customized golden consumer's `auth.ts`).

## 4. Cookie sessions: the browser default

A bearer kept in JavaScript is either lost on every reload (memory) or
readable by any injected script (storage). The browser answer is a session
cookie script cannot read, with CSRF protection. `sessions.transport` selects
`"bearer"` (the default, for native and machine clients), `"cookie"`, or
`"both"`, where each sign-in chooses through its `transport` field (bearer by
default). The sign-in, TOTP verify and recovery consume operations then answer
with `Set-Cookie: ship_session=ship_s_…; Path=/; Max-Age=<absolute lifetime>; Secure; SameSite=Lax; HttpOnly`
and a `session` without `token`; sign-out, revoking the current session and
revoke-all answer with the cookie cleared; TOTP confirmation rotates a cookie
session (the old token is revoked with reason `rotated`, a verified one is
installed and returned as `session`), and a password change rotates the
current session whatever its transport (a captured token is the same token
the request carries) and revokes the others. Idle expiry stays server-side:
the resolver refuses an idle session whatever the cookie's `Max-Age` says.

```ts
export const auth = defineCredentialAuthModule({
  // …
  sessions: {
    transport: "both",
    cookie: {
      name: "ship_session",          // or "__Host-session" for the strongest shape
      path: "/",
      domain: undefined,             // set to the shared parent domain only when app and API are different hosts of one site
      sameSite: "lax",               // "strict" also drops the cookie from top-level navigations into the app
      secure: true,                  // mandatory unless environment is "development"
      csrf: { cookieName: "ship_csrf", header: "x-csrf-token" },
    },
    environment: "production",       // the package never reads NODE_ENV; say "development" to allow secure: false
  },
  clients,                           // required: operations learn how the request authenticated from the registry
});

const http = createHonoAdapter(app, {
  auth: credentialAuthentication({ store, clients, session: auth.policies.session, sessions: auth.sessions, resolveActor }),
  preValidationPolicies: {
    "*": credentialSessionCsrfPolicy({ auth, trustedOrigins: CORS_ORIGINS }),
    ...credentialAuthRateLimitPolicies({ max: 10, windowMs: 60_000 }),
  },
  cors: { origin: CORS_ORIGINS, credentials: true },
});
```

**The CSRF guard** is `credentialSessionCsrfPolicy()`, a SAPI-476
pre-validation policy under the adapter's `"*"` key (new in `ship-hono`: one
policy that runs on every operation ahead of the operation's own), so it runs
after actor resolution and a refusal is the ADR-0004 403
`AUTHORIZATION_ERROR`, never a 500. Safe methods (`GET`, `HEAD`, `OPTIONS`)
are exempt. A request that presents the session cookie and no bearer header
must carry a trusted `Origin` (else the origin of `Referer`; neither is a
refusal) and echo the readable `ship_csrf` cookie in `x-csrf-token`, compared
in constant time. A session-issuing operation is refused when it carries an
untrusted `Origin`/`Referer` (login CSRF); a request with neither header is a
native client and passes. Trusted origins are the list you pass (the same
list as `cors.origin`) plus the request's own origin, read from
`X-Forwarded-Proto`/`X-Forwarded-Host` or `Host`, so a same-origin
deployment needs no list. The policy installs the CSRF cookie on a response
to a request that has a session cookie but no CSRF cookie, and on every
session-issuing operation, so a client always holds a token after a sign-in
or a `GET /auth/me`. A bearer header always wins over a cookie, and a bearer
request is never CSRF-checked.

**The guard cannot be forgotten.** `credentialAuthentication({ sessions })`
(and `credentialSessionCredentials({ sessions })`) with a cookie transport
declares that it requires `credentialSessionCsrfPolicy()` under the `"*"`
key, and `createHonoAdapter` refuses to construct without it
(`SHIP_HONO_OPTIONS_INVALID`, naming the policy to register). A key may hold
a list of policies that run in order, so the guard composes with a policy of
your own: `"*": [myPolicy, credentialSessionCsrfPolicy({ auth })]`. A consumer
that wraps the credential adapter in its own (to dispatch on several
credential kinds) forwards `requires`, as the customized golden consumer
does; `credentialSessionCsrfRequirement(sessions)` builds the same entry by
hand.

**A stale cookie** (revoked, expired, idle, cut off, malformed) resolves
anonymously on a public operation and is refused on an authenticated one: the
browser keeps sending it after a revoke-all, and sign-in must stay reachable
to replace it. A present invalid *bearer* is still refused everywhere
(ADR-0004).

**Definition-time rules.** `secure: false` is refused unless
`sessions.environment` is `"development"`; a `__Host-` name requires
`Secure`, `Path=/` and no `Domain`; the CSRF cookie name must differ from the
session cookie name; `sessions.cookie` without a cookie transport is refused;
cookie transports require `clients`.

**CORS and proxies.** Cookie mode is a same-site deployment: `SameSite=Lax`
never sends the cookie cross-site, so the app and the API share a registrable
domain, either behind one origin (a reverse proxy serving the API under the
app's origin, the simplest shape) or as sibling hosts
(`app.example.com` and `api.example.com`) with `cookie.domain: "example.com"`
so the session cookie reaches the API and the CSRF cookie is readable by the
app. For sibling hosts the adapter must answer
`Access-Control-Allow-Credentials: true` for the app's exact origin
(`cors: { origin: [APP_ORIGIN], credentials: true }`); the SAPI-760 guard
refuses `"*"` with credentials at construction, and `Access-Control-Allow-Headers`
must admit the CSRF header (the default reflects the preflight; an explicit
`allowHeaders` list must include `x-csrf-token`). Behind a TLS-terminating
proxy, forward `X-Forwarded-Proto` and `X-Forwarded-Host` so the own-origin
check sees `https://` and the public host; `Secure` cookies are not sent over
plain HTTP, so local development against `http://localhost` needs
`environment: "development"` with `secure: false`.

## 5. Rate limiting

`credentialAuthRateLimitPolicies({ moduleId?, windowMs, max, operations?, key?, store? })`
returns `preValidationPolicies` (SAPI-476) for the public flows, keyed by
client ip, answered with `AUTH_RATE_LIMITED` 429 and `Retry-After`,
`RateLimit-Limit`, `RateLimit-Remaining`. The in-memory store is per process;
bind a shared `RateLimitStore` in a fleet. The lockout policy guards the
credential itself and applies to direct execution.

## 6. The console panel

```ts
defineConsoleModule({
  imports: [..., "auth"],              // the auth module exports the store token
  extensions: [credentialAuthConsoleExtension()],
});
```

`console.auth-audit.events` (`GET /console/auth-audit/events?accountId|email&event&outcome&before&limit`),
`.account` (lock state, sessions, recovery-code counts), `.revoke` (one or
all sessions), `.unlock`, `.status` (`disabled` revokes every session), all
gated by `console.operate` and audited with the operator id. In Angular, mount
`ShipAuthAuditPanelComponent` under the console shell with
`SHIP_AUTH_AUDIT_CLIENT` provided.

## 7. Angular screens

```ts
// Cookie mode is the default: nothing readable from script, reload-safe.
provideShipCredentialAuth({ client: () => injectShipClient(APP_CLIENT) });
// The policy client's credential capability: credentials: "include" and the
// ship_csrf cookie echoed in x-csrf-token on every operation whose policy
// declares csrf: true (every unsafe operation that is not anonymous).
createPolicyClient(executor, { policies, credentials: cookieCredentialCapability() });

// Bearer mode for a native shell or a non-browser host:
provideShipCredentialAuth({ client: () => injectShipClient(APP_CLIENT), storage: memorySessionStorage() });
{ kind: "bearer", getToken: () => injectCredentialAuth().getToken() }
```

`cookieSessionStorage()` sends `transport: "cookie"` on sign-in and the MFA
answers, never stores a token (a token a server sends anyway is dropped),
asks `me` on `initialize()` so a reload restores the session from the cookie
(and the response restores a missing CSRF cookie), always calls sign-out so
the server clears the cookie, and adopts the rotated session TOTP
confirmation returns. `ShipCredentialAuth.credential()` is the matching
capability for either mode; `cookieCredentialCapability({ csrfCookieName, csrfHeaderName })`
follows a renamed cookie or header. The server's `sessions.transport` must
include `"cookie"` (`"both"` keeps native clients working); a bearer-only
module answers a cookie sign-in with a validation error naming `transport`.

`ShipCredentialAuth` is signal-first: `state` (`unknown` → `anonymous` /
`challenged` / `enrolment-required` / `signed-in`), `account`, `failure`
(declared failures as values, with `retryAfterSeconds` from lockouts and rate
limits), `sessions`, `recoveryCodes`. `ShipSignInComponent` emits the sign-in
result, `ShipMfaChallengeComponent` and `ShipRecoveryCodeComponent` answer
the pending challenge and emit `expired` when the challenge is gone.

## Security choices

See the table in [ADR-0025](../../rearchitecture/decisions/0025-first-party-credential-auth.md):
argon2id from `node:crypto` (scrypt available, pluggable), RFC 6238 TOTP with
replay guard, SHA-256 token hashes,
AES-256-GCM MFA secrets under a key ring, hashed single-use recovery codes,
constant-time comparisons, a decoy hash on unknown emails, opaque hashed
session tokens carried as a bearer or an `httpOnly` cookie with CSRF
protection (section 4).

### Passwords

`argon2idPasswordHasher()` is the default: argon2id from `node:crypto`, 64 MiB,
three passes, one lane, in the standard PHC string, so hashes are portable.
Pass `hasher: scryptPasswordHasher()` to keep scrypt, or any `PasswordHasher`.
The argon2id hasher also verifies `$scrypt$` hashes and reports them through
`needsRehash`, so an installation that started on scrypt upgrades each account
on its next successful sign-in with no migration.

### Registering an email that already has an account

`onExistingEmail` defaults to `"conceal"`: `register` answers `201` exactly as
it does for a new address, and the existing address is told instead. An
unverified account receives its verification link again; a verified one
receives the `existingAccount` message with a link to `links.signIn`. The
caller cannot tell the two cases apart, so the endpoint does not enumerate
accounts, which matters once sign-in and forgot-password already conceal.
`links.signIn` is required in this mode and refused at definition time when
missing. `"reject"` answers `409 AUTH_EMAIL_TAKEN`; opt in where account
existence is not sensitive.

## Proof

- `packages/auth-credentials/src/module.test.ts`: every flow and policy edge
  (expired and replayed tokens, lockout and lockout reset, replayed TOTP step,
  replayed recovery code, revoke-all during an in-flight authorized request,
  idle and absolute session expiry, MFA required per role with the
  pending-enrolment session, rate limiting over HTTP only).
- `cookie.test.ts`: cookie attributes per environment and the definition-time
  rules, the CSRF accept/refuse matrix (missing header, mismatched token,
  missing CSRF cookie, bad or null or missing origin, bad referer, trusted
  origin and referer, own and forwarded origin, safe methods and bearer
  requests exempt, login-CSRF on sign-in), the cookie flow over HTTP (sign-in
  without a token in the body, reload through the cookie, CSRF-less and
  cross-site writes refused, sign-out and revoke clearing, bearer and cookie
  coexisting, stale and malformed cookies anonymous on public operations,
  rotation on TOTP confirmation, transport validation per module).
- `drizzle.integration.test.ts`: the store conformance suite, the full flow
  and the cookie flow (reload-safe request, revoke-all ending the cookie
  session during an in-flight request, bearer beside cookie) against real
  PostgreSQL.
- `console.test.ts`: the panel namespaced by the console id, refused without
  `console.operate`, read/unlock/revoke/disable with operator audit rows.
- `packages/angular/credential-auth`: the cookie default (transport asked,
  no token in state, memory or storage, `me` on initialize, rotation
  adopted), and the client-executor path through `createPolicyClient` with
  `cookieCredentialCapability()` (credentials included, CSRF cookie echoed,
  refusal before the cookie exists, custom names).
- `fixtures/consumers/customized`: the module beside the session directory
  through a composite credential adapter, `0004_credential_auth` generated from
  schema source, the `sre` role forced through TOTP enrolment before its
  session reaches the console, both transports (`sessions.transport: "both"`
  with the CSRF policy under `"*"` and the CORS allowlist as trusted origins:
  a browser cookie session beside a native bearer, login CSRF and CSRF-less
  writes refused, sign-out clearing, revoke-all ending the cookie on
  PostgreSQL), and the audit panel read over HTTP against PostgreSQL.

## Diagnostics and errors

| Code | Where | Meaning |
| --- | --- | --- |
| `SHIP_AUTH_OPTIONS_INVALID` / `SHIP_AUTH_STORE_INVALID` / `SHIP_AUTH_MAILER_INVALID` / `SHIP_AUTH_KEY_INVALID` / `SHIP_AUTH_POLICY_INVALID` | definition | `InvalidCredentialAuthDefinitionError` |
| `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_LOCKED`, `AUTH_ACCOUNT_DISABLED`, `AUTH_EMAIL_UNVERIFIED`, `AUTH_EMAIL_TAKEN`, `AUTH_TOKEN_INVALID`, `AUTH_PASSWORD_POLICY`, `AUTH_MFA_INVALID_CODE`, `AUTH_MFA_NOT_ENROLLED`, `AUTH_MFA_ALREADY_ENROLLED`, `AUTH_RECOVERY_CODE_INVALID`, `AUTH_SESSION_NOT_FOUND`, `AUTH_RATE_LIMITED`, `AUTH_MAIL_QUEUE_FULL` | operations | declared failures |
| `AUTH_AUDIT_ACCOUNT_NOT_FOUND` | console panel | no account for the id or email |
